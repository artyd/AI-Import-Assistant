-- AI Import Assistant — relational schema (PostgreSQL)
-- Applied idempotently by db/migrate.ts on boot.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users (admin-seeded; no public signup).
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspaces == "shipments" (Постачання) in the UI.
CREATE TABLE IF NOT EXISTS workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number     TEXT NOT NULL,                        -- e.g. 2026-0815
  supplier   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft'
             CHECK (status IN ('active', 'draft', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

-- Folders within a workspace (customs document skeleton).
CREATE TABLE IF NOT EXISTS folders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_folders_workspace ON folders(workspace_id);

-- Uploaded files + indexing status.
CREATE TABLE IF NOT EXISTS files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id    UUID REFERENCES folders(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL
               CHECK (type IN ('pdf', 'docx', 'xlsx', 'csv', 'image', 'md')),
  disk_path    TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'indexing', 'ready', 'error')),
  error_reason TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id);

-- Conversations, scoped to a workspace.
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);

-- Messages within a conversation. Citations + tool calls are persisted as JSONB.
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL DEFAULT '',
  citations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_calls      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
