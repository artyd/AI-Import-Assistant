import { query } from '../db/pool.js';
import { getRegistration } from '../customs/drugRegistry.js';
import { logistEnabled, uktzedLookup } from '../customs/logist/index.js';
import type { AppendixData, ContractData, DocData, DocKind, InvoiceData, Party, UaInvoiceData } from './schema.js';
import { parseData } from './schema.js';
import { round } from './format.js';

/**
 * «Перевірити документ» (spec 012, phase 2): what can be checked mechanically
 * before a document leaves — requisites checksums, УКТ ЗЕД codes against qdpro,
 * Ukrainian registrations against the Держреєстр mirror, the invoice against its
 * contract / annex, duplicate numbers. Never blocks a download: the logist decides.
 */
export interface Finding {
  level: 'error' | 'warning' | 'ok';
  area: 'requisites' | 'hs' | 'registry' | 'contract' | 'number';
  message: string;
}

// ---------- pure validators ----------
/** ISO 13616 IBAN check (mod 97). */
export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('UA') && iban.length !== 29) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** BIC / SWIFT: 4 bank + 2 country + 2 location (+ 3 branch). */
export function swiftValid(raw: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(raw.replace(/\s+/g, '').toUpperCase());
}

/** Ukrainian ЄДРПОУ (8 digits) control digit. */
export function edrpouValid(code: string): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const n = Number(code);
  const base = n < 30_000_000 || n > 60_000_000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
  const sum = (w: number[]) => w.reduce((s, wi, i) => s + wi * d[i]!, 0) % 11;
  let ctrl = sum(base);
  if (ctrl === 10) {
    ctrl = sum(base.map((w) => w + 2));
    if (ctrl === 10) ctrl = 0;
  }
  return ctrl === d[7];
}

/** The codes a requisites block mentions. */
export function requisiteCodes(text: string): { iban: string[]; swift: string[]; edrpou: string[] } {
  const iban = [...text.matchAll(/\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30})\b/g)]
    .map((m) => m[1]!.replace(/\s+/g, ''))
    .filter((v) => /^[A-Z]{2}\d{2}/.test(v) && v.length >= 15);
  const swift = [...text.matchAll(/SWIFT[^:\n]{0,12}:?[ \t]*([A-Z]{4}[ ]?[A-Z]{2}[ ]?[A-Z0-9]{2}(?:[ ]?[A-Z0-9]{3})?)(?![A-Z0-9])/gi)].map((m) => m[1]!.replace(/\s+/g, '').toUpperCase());
  const edrpou = [...text.matchAll(/(?:ЄДРПОУ|EDRPOU|Enterprise Code|Reg\.\s*No\.?|Код)\D{0,6}(\d{8})\b/gi)].map((m) => m[1]!);
  return { iban: [...new Set(iban)], swift: [...new Set(swift)], edrpou: [...new Set(edrpou)] };
}

export function checkRequisites(who: string, p: Pick<Party, 'requisitesEn' | 'requisitesUk'>): Finding[] {
  const out: Finding[] = [];
  const codes = requisiteCodes(`${p.requisitesEn}\n${p.requisitesUk}`);
  for (const v of codes.iban)
    out.push(ibanValid(v) ? { level: 'ok', area: 'requisites', message: `${who}: IBAN ${v} — контрольна сума правильна` } : { level: 'error', area: 'requisites', message: `${who}: IBAN ${v} — помилка в номері (контрольна сума не сходиться)` });
  for (const v of codes.swift)
    if (!swiftValid(v)) out.push({ level: 'error', area: 'requisites', message: `${who}: SWIFT ${v} — неправильний формат` });
  for (const v of codes.edrpou)
    out.push(edrpouValid(v) ? { level: 'ok', area: 'requisites', message: `${who}: ЄДРПОУ ${v} — контрольна цифра правильна` } : { level: 'error', area: 'requisites', message: `${who}: ЄДРПОУ ${v} — контрольна цифра не сходиться` });
  return out;
}

/** «2627X/0044» → «2627X/0045», «AI/2026-27/081» → «AI/2026-27/082» (keeps the zero padding). */
export function nextNumber(last: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(last.trim());
  if (!m) return '';
  const [, head, digits, tail] = m;
  const next = String(Number(digits) + 1).padStart(digits!.length, '0');
  return `${head}${next}${tail}`;
}

const norm = (v: string) => v.toLowerCase().replace(/[«»"'“”.,]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- external lookups ----------
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function checkHs(codes: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  const uniq = [...new Set(codes.map((c) => c.replace(/\s+/g, '')).filter(Boolean))].slice(0, 12);
  for (const code of uniq) {
    if (!/^\d{10}$/.test(code)) {
      out.push({ level: 'error', area: 'hs', message: `Код УКТ ЗЕД ${code} — має бути 10 цифр` });
      continue;
    }
    if (!logistEnabled()) continue;
    try {
      const r = await withTimeout(uktzedLookup(code), 12_000);
      const text = (r.common ?? r.text ?? '').trim();
      if (!text) out.push({ level: 'warning', area: 'hs', message: `Код УКТ ЗЕД ${code} не знайдено в qdpro — перевірте код` });
      else {
        const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 3 && !/^#/.test(l)) ?? '';
        out.push({ level: 'ok', area: 'hs', message: `Код УКТ ЗЕД ${code} є в qdpro${line ? `: ${line.slice(0, 140)}` : ''}` });
      }
    } catch {
      out.push({ level: 'warning', area: 'hs', message: `Код УКТ ЗЕД ${code}: не вдалося перевірити в qdpro зараз` });
    }
  }
  return out;
}

async function checkRegistrations(regs: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const numbers = [...new Set(regs.map((r) => /UA\/\d+\/\d+\/\d+/i.exec(r)?.[0]?.toUpperCase()).filter((v): v is string => Boolean(v)))].slice(0, 20);
  for (const n of numbers) {
    const rec = await getRegistration(n).catch(() => null);
    if (!rec) {
      out.push({ level: 'warning', area: 'registry', message: `Реєстрація ${n} не знайдена в Держреєстрі (локальна копія) — перевірте номер` });
      continue;
    }
    const name = rec.product_name ?? rec.active_substance ?? '';
    if (!rec.valid_unlimited && rec.valid_to && rec.valid_to < today)
      out.push({ level: 'error', area: 'registry', message: `Реєстрація ${n} (${name}) закінчилась ${rec.valid_to}` });
    else if (!rec.valid_unlimited && rec.valid_to && rec.valid_to < soon)
      out.push({ level: 'warning', area: 'registry', message: `Реєстрація ${n} (${name}) закінчується ${rec.valid_to}` });
    else out.push({ level: 'ok', area: 'registry', message: `Реєстрація ${n}: ${name}${rec.valid_unlimited ? ', безстрокова' : rec.valid_to ? `, діє до ${rec.valid_to}` : ''}` });
  }
  return out;
}

// ---------- against the parent contract / annex ----------
interface ParentItems {
  number: string;
  buyer: Party;
  seller: Party;
  currency: string;
  incoterm: string;
  incoPlaceEn: string;
  items: { nameEn: string; qty: number; price: number }[];
}

/** Invoice vs its contract or annex: goods, prices, quantities left, buyer, currency, terms. */
export function compareInvoice(inv: InvoiceData, parent: ParentItems, otherInvoices: InvoiceData[]): Finding[] {
  const out: Finding[] = [];
  const ref = parent.number; // «Контракт 31072026/PNS» / «Додаток № 21 до контракту …»
  if (parent.buyer.nameEn && norm(inv.toName) !== norm(parent.buyer.nameEn))
    out.push({ level: 'warning', area: 'contract', message: `${ref}: покупець «${parent.buyer.nameEn}», а в інвойсі одержувач «${inv.toName}»` });
  if (inv.currency !== parent.currency) out.push({ level: 'error', area: 'contract', message: `${ref}: валюта ${parent.currency}, а в інвойсі — ${inv.currency}` });
  if (inv.incoterm !== parent.incoterm || norm(inv.incoPlaceEn) !== norm(parent.incoPlaceEn))
    out.push({ level: 'warning', area: 'contract', message: `${ref}: умови ${parent.incoterm} ${parent.incoPlaceEn}, а в інвойсі — ${inv.incoterm} ${inv.incoPlaceEn}` });
  for (const it of inv.items) {
    if (!it.nameEn.trim()) continue;
    const p = parent.items.find((x) => norm(x.nameEn) === norm(it.nameEn));
    if (!p) {
      out.push({ level: 'error', area: 'contract', message: `${ref}: товару «${it.nameEn}» немає в специфікації` });
      continue;
    }
    if (round(p.price, 4) !== round(it.price, 4)) out.push({ level: 'error', area: 'contract', message: `${ref}: ціна «${it.nameEn}» ${p.price}, а в інвойсі — ${it.price}` });
    const used = otherInvoices.flatMap((o) => o.items).filter((x) => norm(x.nameEn) === norm(it.nameEn)).reduce((s, x) => s + x.qty, 0);
    const left = round(p.qty - used, 3);
    if (it.qty > left + 1e-9)
      out.push({ level: 'error', area: 'contract', message: `${ref}: «${it.nameEn}» в інвойсі ${it.qty} — перевищує залишок ${left} з ${p.qty}${used ? ` (${round(used, 3)} вже в інших інвойсах)` : ''}` });
    else out.push({ level: 'ok', area: 'contract', message: `${ref}: «${it.nameEn}» — ціна й кількість у межах (після цього інвойсу залишиться ${round(left - it.qty, 3)})` });
  }
  return out;
}

async function loadDoc(id: string): Promise<{ kind: DocKind; data: DocData; number: string } | null> {
  const { rows } = await query<{ kind: DocKind; data: unknown; number: string }>('SELECT kind, data, number FROM doc_documents WHERE id = $1', [id]);
  const r = rows[0];
  return r ? { kind: r.kind, data: parseData(r.kind, r.data), number: r.number } : null;
}

function parentItems(kind: DocKind, d: DocData): ParentItems | null {
  if (kind === 'contract') {
    const c = d as ContractData;
    return { number: `Контракт ${c.number}`, buyer: c.buyer, seller: c.seller, currency: c.currency, incoterm: c.incoterm, incoPlaceEn: c.incoPlaceEn, items: c.items };
  }
  if (kind === 'appendix') {
    const a = d as AppendixData;
    return { number: `Додаток № ${a.number} до контракту ${a.contractNumber}`, buyer: a.buyer, seller: a.seller, currency: a.currency, incoterm: a.incoterm, incoPlaceEn: a.incoPlaceEn, items: a.items };
  }
  return null;
}

// ---------- entry point ----------
export async function checkDocument(kind: DocKind, data: DocData, ctx: { id?: string | null; contractId?: string | null }): Promise<Finding[]> {
  const out: Finding[] = [];

  // Parties' requisites.
  if (kind === 'contract' || kind === 'appendix' || kind === 'ua_invoice') {
    const d = data as ContractData | AppendixData | UaInvoiceData;
    out.push(...checkRequisites('Продавець', d.seller), ...checkRequisites('Покупець', d.buyer));
  }

  // Codes and registrations of the goods.
  if (kind === 'contract' || kind === 'appendix') {
    const items = (data as ContractData).items;
    out.push(...(await checkHs(items.map((i) => i.hs).filter(Boolean))));
    out.push(...(await checkRegistrations(items.map((i) => i.reg))));
  }
  if (kind === 'invoice') out.push(...(await checkRegistrations((data as InvoiceData).items.map((i) => i.reg))));

  // Duplicate number of the same kind.
  const number = data.number.trim();
  if (number) {
    const { rows } = await query<{ title: string }>(
      `SELECT title FROM doc_documents WHERE kind = $1 AND number = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
         AND ($4::uuid IS NULL OR kind <> 'appendix' OR contract_id = $4::uuid) LIMIT 3`,
      [kind, number, ctx.id ?? null, kind === 'appendix' ? ctx.contractId ?? null : null],
    );
    if (rows.length) out.push({ level: 'error', area: 'number', message: `Номер ${number} вже використано: ${rows.map((r) => r.title).join('; ')}` });
    else out.push({ level: 'ok', area: 'number', message: `Номер ${number} унікальний` });
  }

  // Against the parent document.
  if (ctx.contractId) {
    const parent = await loadDoc(ctx.contractId);
    if (parent && kind === 'invoice') {
      const pi = parentItems(parent.kind, parent.data);
      if (pi) {
        const { rows } = await query<{ data: unknown }>(
          "SELECT data FROM doc_documents WHERE kind = 'invoice' AND contract_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)",
          [ctx.contractId, ctx.id ?? null],
        );
        out.push(...compareInvoice(data as InvoiceData, pi, rows.map((r) => parseData('invoice', r.data))));
      }
    }
    if (parent && kind === 'appendix' && parent.kind === 'contract') {
      const a = data as AppendixData;
      const c = parent.data as ContractData;
      if (norm(a.buyer.nameEn) !== norm(c.buyer.nameEn)) out.push({ level: 'warning', area: 'contract', message: `Покупець додатку відрізняється від покупця контракту ${c.number}` });
      if (norm(a.seller.nameEn) !== norm(c.seller.nameEn)) out.push({ level: 'warning', area: 'contract', message: `Продавець додатку відрізняється від продавця контракту ${c.number}` });
      if (a.date && c.date && a.date < c.date) out.push({ level: 'error', area: 'contract', message: `Дата додатку раніша за дату контракту (${c.date})` });
    }
  }
  return out;
}

/** The next free number for a new invoice (from the latest one) or annex (per contract). */
export async function suggestNumber(kind: DocKind, contractId: string | null): Promise<string> {
  if (kind === 'appendix' && contractId) {
    const { rows } = await query<{ number: string }>("SELECT number FROM doc_documents WHERE kind = 'appendix' AND contract_id = $1", [contractId]);
    const max = rows.reduce((m, r) => Math.max(m, Number(/\d+/.exec(r.number)?.[0] ?? 0)), 0);
    return String(max + 1);
  }
  const { rows } = await query<{ number: string }>(
    "SELECT number FROM doc_documents WHERE kind = $1 AND number <> '' ORDER BY created_at DESC LIMIT 1",
    [kind],
  );
  return rows[0] ? nextNumber(rows[0].number) : '';
}
