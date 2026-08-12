import { query } from '../db/pool.js';

/**
 * In-app notifications (reminders). No email/SMTP provider exists in the stack,
 * so delivery is in-app only for now; a channel can be added later without
 * changing callers.
 */

export interface NotificationRow {
  id: string;
  workspace_id: string | null;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
}

/**
 * Inserts a notification unless an identical (user, workspace, type) one already
 * exists for today — keeps the daily reminder job from spamming duplicates.
 * Returns true if a row was inserted.
 */
export async function insertNotification(
  userId: string,
  workspaceId: string | null,
  type: string,
  message: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO notifications (user_id, workspace_id, type, message)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM notifications
       WHERE user_id = $1
         AND workspace_id IS NOT DISTINCT FROM $2
         AND type = $3
         AND created_at::date = now()::date
     )`,
    [userId, workspaceId, type, message],
  );
  return (rowCount ?? 0) > 0;
}

export async function listNotifications(userId: string): Promise<NotificationRow[]> {
  const { rows } = await query<NotificationRow>(
    `SELECT id, workspace_id, type, message, read, created_at
     FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return rows;
}
