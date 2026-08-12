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

-- ── MVP-completion phase 1: shipment-domain foundation ──────────────────────
-- All statements below are idempotent (applied on every boot by db/migrate.ts).
-- Schema/columns only — the business logic that populates them lands in later
-- phases.

-- File versioning (columns only; phase 2 sets these on upload).
ALTER TABLE files ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN IF NOT EXISTS replaces_file_id UUID REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT TRUE;
-- files.folder_id is already nullable (NULL = inbox) — no change needed.

-- Workspace intake / contract structure.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS contract_type TEXT
  CHECK (contract_type IN ('bilateral', 'trilateral'));
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS intake_complete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS product_category TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS incoterm TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS transport_mode TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS origin_country TEXT;
-- Separate from owner_id (the creator); nullable assignee for reminders.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS responsible_user_id UUID
  REFERENCES users(id) ON DELETE SET NULL;

-- Parties to the deal (flexible role). App convention: when is_internal = true,
-- company_name is one of 'AGroup95' / 'PrimeForce' (not enforced at DB level).
CREATE TABLE IF NOT EXISTS parties (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('our_company', 'supplier', 'intermediary')),
  company_name TEXT NOT NULL DEFAULT '',
  is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
  country      TEXT,
  contact_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parties_workspace ON parties(workspace_id);

-- Structured fields extracted from a document (flexible JSONB payload). Makes
-- reconciliation and checklist completeness deterministic in later phases.
CREATE TABLE IF NOT EXISTS document_extractions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id          UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  extracted_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  extracted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_version    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_extractions_workspace ON document_extractions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_extractions_file ON document_extractions(file_id);

-- Dynamic checklist: templates keyed by shipment characteristics, and the
-- per-workspace requirement items derived from them.
CREATE TABLE IF NOT EXISTS checklist_templates (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_category        TEXT,
  incoterm                TEXT,
  transport_mode          TEXT,
  required_document_types TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS workspace_checklist_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requirement_key TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'missing'
                  CHECK (status IN ('missing', 'received', 'verified')),
  source_file_id  UUID REFERENCES files(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_items_workspace ON workspace_checklist_items(workspace_id);

-- In-app notifications (reminders). `read` / `type` are non-reserved in Postgres.
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL DEFAULT '',
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- Artifacts generated by the agent or the user (instructions, reports, snapshots).
CREATE TABLE IF NOT EXISTS generated_artifacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN
                 ('supplier_instruction', 'discrepancy_report', 'shipment_report_html', 'checklist_snapshot')),
  content_ref  TEXT NOT NULL DEFAULT '',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by TEXT NOT NULL DEFAULT 'agent' CHECK (generated_by IN ('agent', 'user'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON generated_artifacts(workspace_id);

-- ── MVP-completion phase 2: status lifecycle + checklist seed ───────────────

-- Widen the workspace status set with the derived customs-pipeline stages. Kept
-- as a superset of the original ('active','draft','done') so existing rows and
-- the create-default stay valid. DROP IF EXISTS + ADD is re-runnable.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_status_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_status_check
  CHECK (status IN ('active', 'draft', 'done',
                    'docs_in_progress', 'docs_complete', 'customs_ready'));

-- Baseline checklist template (applies to all shipments; product/incoterm/mode
-- NULL = wildcard). Seeded once; refine/extend later. Guarded so re-runs no-op.
INSERT INTO checklist_templates (product_category, incoterm, transport_mode, required_document_types)
SELECT NULL, NULL, NULL, ARRAY[
  'invoice', 'packing_list', 'purchase_order', 'certificate_of_origin',
  'quality_certificate', 'customs_declaration', 'transport'
]
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates);
