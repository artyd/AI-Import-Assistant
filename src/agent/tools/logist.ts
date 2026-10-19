import * as logist from '../../customs/logist/index.js';
import { digestUktzedSections } from '../../customs/logist/uktzedDigest.js';
import { type ToolOutcome } from './shared.js';

// ── logist-mcp reference tools (scope-less external lookups) ──────────────────

function logistFail(msg: string, summary: string): ToolOutcome {
  return { result: msg, summary, citations: [] };
}

export async function runUktzedLookup(input: unknown): Promise<ToolOutcome> {
  const code = String((input as { code?: unknown })?.code ?? '').trim();
  if (!code) return logistFail('Не вказано код УКТ ЗЕД.', 'УКТ ЗЕД: помилка');
  try {
    const r = await logist.uktzedLookup(code);
    // The goodinfo page is large and split by customs regime (ІМПОРТ/ЕКСПОРТ/
    // ТРАНЗИТ) with critical parts sitting deep (ветеринарний контроль, заборони,
    // ліцензування). Digest each regime in batches so nothing is lost and each
    // requirement is attributed to its regime. Legacy flat `text` maps to common.
    const common = r.common ?? r.text ?? '';
    const digest = await digestUktzedSections(r.code, common, r.tabs ?? []);
    const body = digest || 'Довідку отримано, але вміст порожній — перевірте код.';
    return {
      result: `Митна довідка УКТ ЗЕД ${r.code} (джерело: qdpro.com.ua):\n${body}`,
      summary: `УКТ ЗЕД ${r.code}: довідка`,
      citations: [{ file: r.source, page: null }],
    };
  } catch (err) {
    return logistFail(`Не вдалося отримати довідку: ${(err as Error).message}`, 'УКТ ЗЕД: помилка');
  }
}

export async function runUktzedBrowse(input: unknown): Promise<ToolOutcome> {
  const code = String((input as { code?: unknown })?.code ?? '').trim();
  try {
    const r = await logist.uktzedBrowse(code);
    const links = r.links.length
      ? `\n\nДочірні рівні (код — опис):\n${r.links.map((l) => `- ${l.id} — ${l.label}`).join('\n')}`
      : '';
    return {
      result: `${r.text}${links}`,
      summary: `Класифікатор УКТ ЗЕД: ${r.links.length} рівнів`,
      citations: [{ file: r.source, page: null }],
    };
  } catch (err) {
    return logistFail(`Не вдалося відкрити класифікатор: ${(err as Error).message}`, 'Класифікатор: помилка');
  }
}

export async function runDualuseBrowse(input: unknown): Promise<ToolOutcome> {
  const nodeId = String((input as { node_id?: unknown })?.node_id ?? '').trim();
  try {
    const r = await logist.dualuseBrowse(nodeId);
    // Surface node_ids so the model can drill down (get_text alone loses them).
    const links = r.links.length
      ? `\n\nВузли для заглиблення (node_id — назва):\n${r.links.map((l) => `- ${l.id} — ${l.label}`).join('\n')}`
      : '';
    return {
      result: `${r.text}${links}`,
      summary: `Подвійне використання: ${r.links.length} вузлів`,
      citations: [{ file: r.source, page: null }],
    };
  } catch (err) {
    return logistFail(`Не вдалося відкрити список подвійного використання: ${(err as Error).message}`, 'Подвійне використання: помилка');
  }
}

export async function runExchangeRate(input: unknown): Promise<ToolOutcome> {
  const currency = String((input as { currency?: unknown })?.currency ?? '').trim();
  const date = String((input as { date?: unknown })?.date ?? '').trim();
  if (!currency) return logistFail('Не вказано код валюти.', 'Курс НБУ: помилка');
  try {
    const r = await logist.exchangeRate(currency, date);
    return { result: r.text, summary: `Курс НБУ: ${r.currency}`, citations: [] };
  } catch (err) {
    return logistFail(`Не вдалося отримати курс НБУ: ${(err as Error).message}`, 'Курс НБУ: помилка');
  }
}

export async function runPubchemIdentify(input: unknown): Promise<ToolOutcome> {
  const identifier = String((input as { identifier?: unknown })?.identifier ?? '').trim();
  if (!identifier) return logistFail('Не вказано назву/CAS речовини.', 'PubChem: помилка');
  try {
    const r = await logist.pubchemIdentify(identifier);
    return { result: r.text, summary: `PubChem: ${identifier}`, citations: [] };
  } catch (err) {
    return logistFail(`Не вдалося ідентифікувати речовину: ${(err as Error).message}`, 'PubChem: помилка');
  }
}
