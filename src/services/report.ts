import type { WorkspaceRow } from './workspaceAccess.js';
import { saveArtifact } from './artifacts.js';
import { collectFacts, managementSummary } from './report/collect.js';
import { renderReportHtml } from './report/html.js';
import { htmlToPdf } from './pdf.js';

/**
 * One-page A4 management report (approved mockup:
 * docs/instruction-builder-and-report/mockups/report-a4.html). Facts are
 * assembled deterministically from extractions, parties, checklist and risks
 * (`report/facts.ts`); the only model call is the optional cached 3–5 sentence
 * summary. The HTML is persisted as the `shipment_report_html` artifact; PDF is
 * printed from the same HTML on demand.
 */
export async function buildAndSaveReport(
  ws: WorkspaceRow,
  opts: { summary?: boolean } = {},
): Promise<{ id: string; html: string }> {
  const facts = await collectFacts(ws);
  const summary = opts.summary === false ? null : await managementSummary(ws.id, facts);
  const html = renderReportHtml(facts, summary);
  const { id } = await saveArtifact(ws.id, 'shipment_report_html', html, 'html', 'agent');
  return { id, html };
}

export function reportPdf(html: string): Promise<Buffer> {
  return htmlToPdf(html);
}
