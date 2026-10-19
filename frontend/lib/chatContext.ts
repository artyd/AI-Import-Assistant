// Per-kind chat endpoint resolution (ШТУРМАН prototype port · Phase A).
//
// The three chat kinds share the same SSE contract but differ in scope and paths
// (see API_CONTRACT.md → "Chat kinds"). This maps a (kind, entity) pair to the
// concrete REST paths the shell uses for POSTing messages and loading history.
//
//   supply       → /api/workspaces/:id/chat            + /conversations[/:cid]
//   normal       → /api/chats                          + /api/chats[/:cid]
//   consolidated → /api/collections/:id/chat           + /conversations[/:cid]

import { api } from "./api";
import type { ChatKind, ConversationMeta, Message } from "./types";

export interface ChatEndpoints {
  /** POST target for streaming a message. */
  postPath: string;
  /** GET target for the conversation list of this kind/entity. */
  convListPath: string;
  /** GET target for a single conversation's messages. */
  convMsgPath: (conversationId: string) => string;
}

/**
 * Resolve chat endpoints for the active kind/entity, or `null` when the kind
 * needs an entity that isn't selected yet (consolidated without a collection).
 */
export function resolveChatEndpoints(
  kind: ChatKind,
  workspaceId: string | null,
  collectionId: string | null
): ChatEndpoints | null {
  if (kind === "normal") {
    return {
      postPath: "/api/chats",
      convListPath: "/api/chats",
      convMsgPath: (cid) => `/api/chats/${cid}`,
    };
  }
  if (kind === "supply") {
    if (!workspaceId) return null;
    const base = `/api/workspaces/${workspaceId}`;
    return {
      postPath: `${base}/chat`,
      convListPath: `${base}/conversations`,
      convMsgPath: (cid) => `${base}/conversations/${cid}`,
    };
  }
  // consolidated
  if (!collectionId) return null;
  const base = `/api/collections/${collectionId}`;
  return {
    postPath: `${base}/chat`,
    convListPath: `${base}/conversations`,
    convMsgPath: (cid) => `${base}/conversations/${cid}`,
  };
}

/** The conversation list of a chat kind/entity. */
export async function fetchConversations(e: ChatEndpoints): Promise<ConversationMeta[]> {
  const { conversations } = await api<{ conversations: ConversationMeta[] }>(e.convListPath);
  return conversations;
}

/** One conversation's messages. */
export function fetchConversation(e: ChatEndpoints, id: string) {
  return api<{ conversationId: string; messages: Message[] }>(e.convMsgPath(id));
}

/** The most recently updated conversation, if any. */
export function newestConversation(list: ConversationMeta[]): ConversationMeta | null {
  return [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
}
