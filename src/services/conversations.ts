import { query } from '../db/pool.js';

export interface Citation {
  file: string;
  page: number | null;
}

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  summary?: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  tool_calls: ToolCallRecord[];
  created_at: string;
}

export async function ensureConversation(
  workspaceId: string,
  conversationId: string | undefined,
  firstUserMessage: string,
): Promise<string> {
  if (conversationId) {
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM conversations WHERE id = $1 AND workspace_id = $2',
      [conversationId, workspaceId],
    );
    if (rows[0]) return rows[0].id;
  }
  const title = firstUserMessage.slice(0, 80);
  const { rows } = await query<{ id: string }>(
    'INSERT INTO conversations (workspace_id, title) VALUES ($1, $2) RETURNING id',
    [workspaceId, title],
  );
  return rows[0]!.id;
}

export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  citations: Citation[] = [],
  toolCalls: ToolCallRecord[] = [],
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, content, citations, tool_calls)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id`,
    [conversationId, role, content, JSON.stringify(citations), JSON.stringify(toolCalls)],
  );
  await query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0]!.id;
}

export async function listConversations(workspaceId: string): Promise<
  { id: string; title: string; created_at: string; updated_at: string }[]
> {
  const { rows } = await query(
    `SELECT id, title, created_at, updated_at
     FROM conversations WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return rows as never;
}

export async function getConversationMessages(
  workspaceId: string,
  conversationId: string,
): Promise<MessageRow[] | null> {
  const { rows: conv } = await query<{ id: string }>(
    'SELECT id FROM conversations WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
  if (!conv[0]) return null;
  const { rows } = await query<MessageRow>(
    `SELECT id, conversation_id, role, content, citations, tool_calls, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );
  return rows;
}

/** Prior turns as Anthropic message params (text-only history). */
export async function getConversationHistory(
  conversationId: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const { rows } = await query<{ role: 'user' | 'assistant'; content: string }>(
    'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId],
  );
  return rows.filter((r) => r.content.trim().length > 0);
}
