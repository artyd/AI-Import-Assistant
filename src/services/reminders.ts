import { query } from '../db/pool.js';
import { insertNotification } from './notifications.js';

/**
 * The reminder scan: for every workspace with a responsible user and at least one
 * still-missing required checklist item, insert a (de-duped) in-app notification.
 * In-app only — the stack has no email/SMTP provider. Shared by the daily worker
 * job and the manual `reminders:once` trigger. Returns the number of rows inserted.
 */
export async function scanAndNotify(): Promise<number> {
  const { rows } = await query<{ id: string; number: string; responsible_user_id: string }>(
    `SELECT DISTINCT w.id, w.number, w.responsible_user_id
     FROM workspaces w
     JOIN workspace_checklist_items ci ON ci.workspace_id = w.id
     WHERE w.responsible_user_id IS NOT NULL AND ci.status = 'missing'`,
  );
  let inserted = 0;
  for (const w of rows) {
    const did = await insertNotification(
      w.responsible_user_id,
      w.id,
      'checklist_incomplete',
      `Постачання ${w.number}: є незавершені обовʼязкові документи.`,
    );
    if (did) inserted++;
  }
  return inserted;
}
