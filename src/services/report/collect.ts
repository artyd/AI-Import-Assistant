import { createHash } from 'node:crypto';
import { query } from '../../db/pool.js';
import { anthropic } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { config } from '../../config.js';
import type { WorkspaceRow } from '../workspaceAccess.js';
import { computeChecklist } from '../checklist.js';
import { computeRisks } from '../risks.js';
import { listParties } from '../parties.js';
import { logistEnabled, uktzedFlags } from '../logist/index.js';
import { buildFacts, type FactsDoc, type FactsQdpro, type ReportFacts } from './facts.js';

/** Loads everything the report needs and assembles the facts (no LLM). */
export async function collectFacts(ws: WorkspaceRow): Promise<ReportFacts> {
  const [{ rows: docs }, parties, checklist, risks, { rows: cnt }, { rows: user }] = await Promise.all([
    query<FactsDoc>(
      `SELECT f.name AS file_name, de.extracted_fields->>'doc_type' AS doc_type, de.extracted_fields AS fields
       FROM document_extractions de JOIN files f ON f.id = de.file_id
       WHERE de.workspace_id = $1 AND f.is_latest = true
       ORDER BY f.created_at, f.name, f.id`,
      [ws.id],
    ),
    listParties(ws.id),
    computeChecklist(ws),
    computeRisks(ws),
    query<{ n: string }>('SELECT count(*)::text AS n FROM files WHERE workspace_id = $1 AND is_latest = true', [ws.id]),
    ws.responsible_user_id
      ? query<{ name: string | null; email: string }>('SELECT name, email FROM users WHERE id = $1', [ws.responsible_user_id])
      : Promise.resolve({ rows: [] as { name: string | null; email: string }[] }),
  ]);

  const input = {
    workspace: {
      number: ws.number,
      status: ws.status,
      contract_type: ws.contract_type,
      product_category: ws.product_category,
      transport_mode: ws.transport_mode,
    },
    responsible: user[0] ? user[0].name || user[0].email : null,
    docs: docs.map((d) => ({ ...d, fields: d.fields ?? {} })),
    parties,
    checklist,
    risks,
    filesCount: Number(cnt[0]?.n ?? 0),
    qdpro: null as FactsQdpro | null,
    now: new Date(),
  };

  // Official source for the code's controls/duty when the reference service is
  // up; otherwise the report states the МД/invoice as the source.
  const draft = buildFacts(input);
  const code = draft.classification.hsCode?.replace(/\D/g, '');
  if (code && code.length === 10 && logistEnabled()) {
    try {
      const q = await uktzedFlags(code);
      const controls = [
        q.flags.vet_control && 'ветконтроль',
        q.flags.phyto && 'фітоконтроль',
        q.flags.license && 'ліцензування',
        q.flags.dual_use && 'подвійне призначення',
        q.flags.narcotic && 'прекурсори/наркотичні',
        q.flags.ban_rf && 'заборона РФ',
      ].filter((x): x is string => !!x);
      input.qdpro = { code, duty: q.duty_full || null, controls: controls.length ? controls : ['без спецконтролю'] };
      return buildFacts(input);
    } catch {
      // qdpro unavailable — keep the document-sourced classification.
    }
  }
  return draft;
}

/**
 * 3–5 neutral sentences for management, from the computed facts only (never
 * from documents). Cached per workspace by a hash of the facts, so re-opening
 * an unchanged report costs nothing. Best-effort: null on any failure.
 */
export async function managementSummary(workspaceId: string, facts: ReportFacts): Promise<string | null> {
  const { generatedAt: _skip, ...stable } = facts;
  const hash = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  const { rows } = await query<{ summary: string }>(
    'SELECT summary FROM report_summaries WHERE workspace_id = $1 AND facts_hash = $2',
    [workspaceId, hash],
  );
  if (rows[0]) return rows[0].summary;

  try {
    const msg = await runWithAnthropicLimit(() =>
      anthropic.messages.create({
        model: config.REPORT_SUMMARY_MODEL,
        max_tokens: 600,
        output_config: { effort: 'low' },
        system:
          'Ти пишеш резюме поставки для керівництва компанії-імпортера. Українською, 3–5 речень, ' +
          'до 90 слів. Лише факти з наданого JSON — нічого не додумуй. Порядок: стан поставки, ' +
          'гроші (платежі), головний ризик і що з ним зробити. Нейтрально, без оціночних слів ' +
          '(«відкат», «схема»), без мотивів сторін. Без заголовків і списків — суцільний абзац.',
        messages: [{ role: 'user', content: JSON.stringify(stable) }],
      }),
    );
    const text = msg.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (!text) return null;
    await query(
      `INSERT INTO report_summaries (workspace_id, facts_hash, summary) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, facts_hash) DO NOTHING`,
      [workspaceId, hash, text],
    );
    return text;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Report summary failed for workspace ${workspaceId}:`, (err as Error).message);
    return null;
  }
}
