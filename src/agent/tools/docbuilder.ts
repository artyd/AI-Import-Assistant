import type { ChatTool } from '../../lib/anthropic/client.js';
import { query } from '../../db/pool.js';
import { parseData, type DocKind } from '../../docbuilder/schema.js';
import { appendixFromContract, invoiceFromAppendix, invoiceFromContract } from '../../docbuilder/fromContract.js';
import { documentTotal } from '../../docbuilder/templateData.js';
import { suggestNumber } from '../../docbuilder/checks.js';
import { findByNumber, insertDoc, logEvent, type DocRow } from '../../docbuilder/store.js';
import { moneyUk } from '../../docbuilder/format.js';

/**
 * Штурман ↔ the document builder (spec 012). The agent can list the team's
 * trade documents and start a DRAFT from an existing contract / annex; it never
 * fills or sends a document itself — the logist checks every field in «Документи».
 */
export const docBuilderToolDefinitions: ChatTool[] = [
  {
    name: 'trade_documents_list',
    description:
      'Список документів конструктора «Документи» (контракти зі специфікацією, додатки до контрактів, інвойси з пакувальним листом, ' +
      'видаткові накладні / рахунки): номер, контрагент, дата, сума, статус (чернетка / перевірено / відправлено). ' +
      'Викликай, коли питають, які контракти чи інвойси вже складені, який наступний номер або що ще не відправлено.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Пошук за номером або назвою контрагента.' },
        kind: { type: 'string', enum: ['contract', 'appendix', 'invoice', 'ua_invoice'], description: 'Лише один тип документа.' },
      },
    },
  },
  {
    name: 'trade_document_draft',
    description:
      'Створює ЧЕРНЕТКУ в конструкторі «Документи» з уже збереженого контракту: інвойс + пакувальний лист до контракту чи додатку ' +
      '(action=invoice) або наступний додаток (специфікацію) до контракту (action=appendix). Викликай лише коли користувач прямо просить ' +
      '«склади інвойс до контракту …» / «зроби додаток до контракту …». Після виклику скажи, що чернетку відкрито в розділі «Документи», ' +
      'і що всі поля (партії, ваги, ціни, реквізити) треба перевірити перед завантаженням.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['invoice', 'appendix'] },
        contract_number: { type: 'string', description: 'Номер контракту, напр. 31072026/PNS.' },
        appendix_number: { type: 'string', description: 'Для інвойсу до додатку: номер додатку (напр. 21).' },
      },
      required: ['action', 'contract_number'],
    },
  },
];

const NAMES = new Set(docBuilderToolDefinitions.map((t) => (t as { name: string }).name));
export function isDocBuilderTool(name: string): boolean {
  return NAMES.has(name);
}

const KIND_LABEL: Record<DocKind, string> = { contract: 'Контракт', appendix: 'Додаток', invoice: 'Інвойс', ua_invoice: 'Накладна/рахунок' };
const STATUS_LABEL: Record<string, string> = { draft: 'чернетка', checked: 'перевірено', sent: 'відправлено' };

function line(r: DocRow): string {
  const data = parseData(r.kind, r.data);
  const cur = r.kind === 'ua_invoice' ? 'грн' : (data as { currency: string }).currency;
  return `- ${KIND_LABEL[r.kind]} ${r.title}${data.date ? `, ${data.date}` : ''}, ${moneyUk(documentTotal(r.kind, data))} ${cur}, ${STATUS_LABEL[r.status] ?? r.status}${r.version > 1 ? `, версія ${r.version}` : ''}`;
}

export async function executeDocBuilderTool(name: string, input: unknown): Promise<{ result: string; summary: string }> {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');

  if (name === 'trade_documents_list') {
    const kind = str('kind');
    const q = str('query').toLowerCase();
    const { rows } = await query<DocRow>(
      `SELECT * FROM doc_documents WHERE ($1 = '' OR kind = $1) AND ($2 = '' OR lower(title) LIKE '%' || $2 || '%') ORDER BY updated_at DESC LIMIT 40`,
      [kind, q],
    );
    if (!rows.length) return { result: 'У конструкторі «Документи» таких документів немає — даних немає.', summary: 'Документи: нічого' };
    return { result: `Документи конструктора (до 40, найновіші):\n${rows.map(line).join('\n')}`, summary: `Документи: ${rows.length}` };
  }

  // trade_document_draft
  const action = str('action');
  const contract = await findByNumber(['contract'], str('contract_number'));
  if (!contract) return { result: `Контракту ${str('contract_number')} у конструкторі «Документи» немає. Спершу його треба скласти там.`, summary: 'Чернетка: контракт не знайдено' };
  const today = new Date().toISOString().slice(0, 10);

  if (action === 'appendix') {
    const n = await suggestNumber('appendix', contract.id);
    const annex = appendixFromContract(parseData('contract', contract.data), n, today);
    const row = await insertDoc('appendix', annex, { contractId: contract.id, workspaceId: contract.workspace_id, userId: null });
    await logEvent(row.id, null, 'created', `Штурман (чат): додаток № ${n} до ${contract.number}`);
    return {
      result: `Створено чернетку «Додаток № ${n} до контракту ${contract.number}» у розділі «Документи». Сторони й умови взято з контракту, специфікація порожня — товари, кількості й ціни користувач додає сам і обовʼязково перевіряє всі поля перед завантаженням.`,
      summary: `Чернетка додатку № ${n}`,
    };
  }

  let source: DocRow = contract;
  const annexNo = str('appendix_number');
  if (annexNo) {
    const { rows } = await query<DocRow>("SELECT * FROM doc_documents WHERE kind = 'appendix' AND contract_id = $1 AND number = $2 ORDER BY version DESC LIMIT 1", [contract.id, annexNo]);
    if (!rows[0]) return { result: `Додатку № ${annexNo} до контракту ${contract.number} у конструкторі немає.`, summary: 'Чернетка: додаток не знайдено' };
    source = rows[0];
  }
  const invoice = source.kind === 'appendix' ? invoiceFromAppendix(parseData('appendix', source.data), today) : invoiceFromContract(parseData('contract', source.data), today);
  invoice.number = await suggestNumber('invoice', null);
  const row = await insertDoc('invoice', invoice, { contractId: source.id, workspaceId: source.workspace_id, userId: null });
  await logEvent(row.id, null, 'created', `Штурман (чат): з ${source.title}`);
  return {
    result:
      `Створено чернетку інвойсу${invoice.number ? ` № ${invoice.number} (запропонований наступний номер)` : ''} до ${source.kind === 'appendix' ? `додатку № ${annexNo}` : 'контракту'} ${contract.number} у розділі «Документи». ` +
      `Одержувач, умови, товари, кількості й ціни перенесено з ${source.kind === 'appendix' ? 'додатку' : 'контракту'}; номери партій, вага брутто й кількість місць ще порожні. ` +
      'Користувач має обовʼязково перевірити всі поля перед завантаженням.',
    summary: 'Чернетка інвойсу',
  };
}
