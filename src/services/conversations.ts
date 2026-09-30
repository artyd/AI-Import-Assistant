import { query } from '../db/pool.js';
import { repairBlocks, stableWindowStart } from '../agent/historyRepair.js';
import type { ChatMessageParam } from '../anthropic/client.js';

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

export type ChatKind = 'normal' | 'supply' | 'consolidated';

export interface ConversationScope {
  kind: ChatKind;
  /** Set for 'supply' (shipment) chats. */
  workspaceId?: string;
  /** Set for 'consolidated' (Збірник) chats. */
  collectionId?: string;
  /** Set for 'normal' (global) chats. */
  ownerId?: string;
}

/** The scope column that owns a conversation of the given kind. */
function scopeColumn(kind: ChatKind): 'workspace_id' | 'collection_id' | 'owner_id' {
  switch (kind) {
    case 'supply':
      return 'workspace_id';
    case 'consolidated':
      return 'collection_id';
    case 'normal':
      return 'owner_id';
  }
}

/** The scope id value that owns a conversation of the given kind. */
function scopeValue(scope: ConversationScope): string {
  switch (scope.kind) {
    case 'supply':
      if (!scope.workspaceId) throw new Error('supply scope requires workspaceId');
      return scope.workspaceId;
    case 'consolidated':
      if (!scope.collectionId) throw new Error('consolidated scope requires collectionId');
      return scope.collectionId;
    case 'normal':
      if (!scope.ownerId) throw new Error('normal scope requires ownerId');
      return scope.ownerId;
  }
}

/**
 * Reuse or create a conversation for a given kind + scope. When `conversationId`
 * is supplied it is reused only if it belongs to the SAME scope column AND kind
 * (so a normal-chat id can't reattach to a workspace turn, etc.); otherwise a new
 * conversation is inserted with the correct chat_kind + scope column + title.
 */
export async function ensureConversationScoped(
  scope: ConversationScope,
  conversationId: string | undefined,
  firstUserMessage: string,
): Promise<string> {
  const column = scopeColumn(scope.kind);
  const value = scopeValue(scope);

  if (conversationId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM conversations WHERE id = $1 AND chat_kind = $2 AND ${column} = $3`,
      [conversationId, scope.kind, value],
    );
    if (rows[0]) return rows[0].id;
  }
  const title = firstUserMessage.slice(0, 80);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO conversations (chat_kind, ${column}, title) VALUES ($1, $2, $3) RETURNING id`,
    [scope.kind, value, title],
  );
  return rows[0]!.id;
}

/** Supply (shipment) chat — unchanged behavior, delegates to the scoped path. */
export async function ensureConversation(
  workspaceId: string,
  conversationId: string | undefined,
  firstUserMessage: string,
): Promise<string> {
  return ensureConversationScoped(
    { kind: 'supply', workspaceId },
    conversationId,
    firstUserMessage,
  );
}

export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  citations: Citation[] = [],
  toolCalls: ToolCallRecord[] = [],
  // Full Anthropic content blocks of this turn (assistant tool_use/text + the
  // following tool_result user messages), so the agent replays what it actually
  // read/extracted on prior turns — not just its final text. Null → text-only.
  blocks: ChatMessageParam[] | null = null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, content, citations, tool_calls, blocks)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING id`,
    [
      conversationId,
      role,
      content,
      JSON.stringify(citations),
      JSON.stringify(toolCalls),
      blocks && blocks.length > 0 ? JSON.stringify(blocks) : null,
    ],
  );
  await query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0]!.id;
}

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** List conversations of a kind for the scope that owns them. */
async function listConversationsByScope(
  kind: ChatKind,
  value: string,
): Promise<ConversationSummary[]> {
  const column = scopeColumn(kind);
  const { rows } = await query<ConversationSummary>(
    `SELECT id, title, created_at, updated_at
     FROM conversations WHERE chat_kind = $1 AND ${column} = $2 ORDER BY updated_at DESC`,
    [kind, value],
  );
  return rows;
}

/** Supply (shipment) conversations — unchanged. */
export async function listConversations(workspaceId: string): Promise<ConversationSummary[]> {
  return listConversationsByScope('supply', workspaceId);
}

/** Consolidated (Збірник) conversations for a collection. */
export async function listConversationsByCollection(
  collectionId: string,
): Promise<ConversationSummary[]> {
  return listConversationsByScope('consolidated', collectionId);
}

/** Normal (global) conversations for a user. */
export async function listConversationsByOwner(ownerId: string): Promise<ConversationSummary[]> {
  return listConversationsByScope('normal', ownerId);
}

/** Fetch a conversation's messages, verifying it belongs to the given scope. */
async function getConversationMessagesByScope(
  kind: ChatKind,
  value: string,
  conversationId: string,
): Promise<MessageRow[] | null> {
  const column = scopeColumn(kind);
  const { rows: conv } = await query<{ id: string }>(
    `SELECT id FROM conversations WHERE id = $1 AND chat_kind = $2 AND ${column} = $3`,
    [conversationId, kind, value],
  );
  if (!conv[0]) return null;
  const { rows } = await query<MessageRow>(
    `SELECT id, conversation_id, role, content, citations, tool_calls, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );
  return rows;
}

/** Supply (shipment) messages — unchanged. */
export async function getConversationMessages(
  workspaceId: string,
  conversationId: string,
): Promise<MessageRow[] | null> {
  return getConversationMessagesByScope('supply', workspaceId, conversationId);
}

/** Consolidated (Збірник) messages, verified against the collection. */
export async function getConversationMessagesByCollection(
  collectionId: string,
  conversationId: string,
): Promise<MessageRow[] | null> {
  return getConversationMessagesByScope('consolidated', collectionId, conversationId);
}

/** Normal (global) messages, verified against the owner. */
export async function getConversationMessagesByOwner(
  ownerId: string,
  conversationId: string,
): Promise<MessageRow[] | null> {
  return getConversationMessagesByScope('normal', ownerId, conversationId);
}

// Windowing budget for replayed history. Prior turns' full content blocks (incl.
// tool_result document text) are replayed so the agent remembers what it read;
// this caps how much, keeping room for the system prompt, the current turn's
// tool results, and the output. ~400k chars ≈ ~100k tokens.
const HISTORY_CHAR_BUDGET = 400_000;

function approxSize(msgs: ChatMessageParam[]): number {
  try {
    return JSON.stringify(msgs).length;
  } catch {
    return 0;
  }
}

/**
 * Prior turns as Anthropic message params, LOSSLESS where possible: an assistant
 * row that stored `blocks` (its full tool_use/text + tool_result sequence) replays
 * verbatim, so the agent sees the document text/search hits it read on earlier
 * turns — not just its own prose. Legacy rows (no blocks) replay as plain text.
 * Windowed from the most recent turn by a char budget so long chats can't overflow
 * the context window (oldest whole turns are dropped first).
 */
export async function getConversationHistory(
  conversationId: string,
): Promise<ChatMessageParam[]> {
  const { rows } = await query<{
    role: 'user' | 'assistant';
    content: string;
    blocks: ChatMessageParam[] | null;
  }>(
    'SELECT role, content, blocks FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId],
  );

  // One group per DB row; each group is a self-contained, replay-valid unit
  // (a user text turn, or an assistant turn's full block sequence).
  const groups: ChatMessageParam[][] = [];
  for (const r of rows) {
    const plain: ChatMessageParam[] =
      r.content && r.content.trim().length > 0 ? [{ role: r.role, content: r.content }] : [];
    if (r.role === 'assistant' && Array.isArray(r.blocks) && r.blocks.length > 0) {
      // A single turn larger than the whole budget (huge read_file results) would
      // overflow the context on every later turn — replay its prose instead.
      groups.push(approxSize(r.blocks) > HISTORY_CHAR_BUDGET ? plain : r.blocks);
    } else if (plain.length) {
      groups.push(plain);
    }
  }

  // Keep the most recent groups within the char budget (never split a group, so
  // tool_use/tool_result pairing stays valid). The window start moves in
  // quantized jumps so the replayed prefix stays byte-stable for several turns
  // and the prompt cache keeps hitting (see stableWindowStart).
  const start = stableWindowStart(groups.map(approxSize), HISTORY_CHAR_BUDGET);
  const kept = groups.slice(start);
  // Heal anything stored before repair existed (unpaired tool_use, empty
  // messages) and guarantee the window opens with a user message.
  return repairBlocks(kept.flat());
}
