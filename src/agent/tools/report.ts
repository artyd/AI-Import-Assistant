import { getWorkspaceById } from '../../shipments/workspaceAccess.js';
import { buildAndSaveReport } from '../../report/report.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

export async function runGenerateReport(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Звіт: помилка', citations: [] };
  const { id } = await buildAndSaveReport(ws);
  return {
    // Do not return the full HTML — just confirm; it's saved and exportable.
    result: `HTML-звіт по постачанню згенеровано та збережено (artifact ${id}). Його можна завантажити через експорт постачання.`,
    summary: 'Згенеровано звіт постачання',
    citations: [],
  };
}
