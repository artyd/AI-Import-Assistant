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

-- Per-user AI provider config (Phase E — BYOK). `engine='builtin'` uses the
-- server-side Claude; `engine='byok'` routes the analysis AI step through the
-- user's own provider, with `enc_key` an AES-256-GCM blob (never returned raw).
-- Scoped to the consolidated-analysis engine only; the main agent stays builtin.
CREATE TABLE IF NOT EXISTS ai_configs (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  engine     TEXT NOT NULL DEFAULT 'builtin'
             CHECK (engine IN ('builtin', 'byok')),
  provider   TEXT CHECK (provider IN ('openai', 'gemini', 'claude', 'openrouter')),
  enc_key    TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Content-hash dedup (file-normalization phase 1). Nullable until backfilled.
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_files_workspace_hash ON files(workspace_id, content_hash)
  WHERE is_latest = true;

-- Classification transparency (analysis-improvement phase 4): why a file was
-- filed, how confident, and — for low-confidence guesses left in the inbox —
-- which folder is suggested for manual confirmation.
ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_reason TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_confidence TEXT
  CHECK (folder_confidence IN ('high', 'medium', 'low'));
ALTER TABLE files ADD COLUMN IF NOT EXISTS suggested_folder_id UUID
  REFERENCES folders(id) ON DELETE SET NULL;

-- Extraction outcome, separate from the (contract-frozen) indexing `status`.
-- 'ok'         — fields extracted normally.
-- 'unreadable' — a scan/image whose text could not be read (no text layer + OCR
--                failed + vision produced nothing) — the human must enter key
--                fields on the verification screen (plan Q29). NEVER silently dropped.
-- 'no_fields'  — text was available but no structured fields came back.
-- NULL         — extraction not run / not applicable.
ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_status TEXT
  CHECK (extraction_status IN ('ok', 'unreadable', 'no_fields'));

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
  role         TEXT NOT NULL, -- free-text role label (relaxed from a fixed CHECK; see phase-3 ALTER below)
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

-- ── Sidebar-enhancement phase 1: destination country + free-text party roles ──

-- Country of destination (mirrors origin_country). Nullable; not part of the
-- intake_complete required-five derivation (see routes/workspaces.ts).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS destination_country TEXT;

-- Relax the parties.role fixed CHECK to free-text so role labels are flexible
-- (seller/buyer/consignee/agent/…). Idempotent for existing production DBs.
ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_role_check;

-- ── Sidebar-enhancement phase 4: contract-structure checklist dimension ───────

-- Checklist templates can now vary by contract_type (2-party vs 3-party). NULL =
-- wildcard, so the baseline row still applies to every shipment; the trilateral
-- row is additive on top of it.
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS contract_type TEXT;

-- Trilateral (3-party) shipments require the intermediary-structure document(s).
-- NOTE(phase4): 'intermediary_agreement' is a PLACEHOLDER doc_type — confirm the
-- real required-document list with the domain owner before relying on it.
INSERT INTO checklist_templates (product_category, incoterm, transport_mode, contract_type,
                                 required_document_types)
SELECT NULL, NULL, NULL, 'trilateral', ARRAY['intermediary_agreement']
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE contract_type = 'trilateral');

-- ── Phase 6: local mirror of the State Register of Medicinal Products ─────────
-- Reference table (NOT workspace-scoped): a local copy of the Ukrainian drug
-- register (drlz.com.ua / МОЗ open data), ingested by scripts/ingest-drug-registry.
-- Lets the registry cross-check run deterministically OFFLINE (no live browsing,
-- per the grounding rules). Advisory only — a regulatory specialist confirms.
CREATE TABLE IF NOT EXISTS drug_registry (
  reg_number           TEXT PRIMARY KEY,       -- e.g. UA/19603/01/01
  product_name         TEXT,
  active_substance     TEXT,
  dosage_form          TEXT,
  manufacturer         TEXT,
  manufacturer_country TEXT,
  mah_owner            TEXT,                    -- власник реєстраційного посвідчення
  valid_from           DATE,
  valid_to             DATE,                    -- NULL when valid_unlimited (необмежений)
  valid_unlimited      BOOLEAN NOT NULL DEFAULT FALSE,
  raw                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Analysis-improvement phase 2: dual Incoterms + fixed party slots ──────────

-- Incoming (buy-side, supplier→us) and outgoing (sell-side, us→buyer) Incoterms.
-- The legacy single `incoterm` column is kept in sync with incoterm_in for
-- back-compat (checklist matching / supplier instruction historically read it).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS incoterm_in TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS incoterm_out TEXT;
UPDATE workspaces SET incoterm_in = incoterm
  WHERE incoterm_in IS NULL AND incoterm IS NOT NULL;

-- Preserve the "this is us" signal before collapsing roles: the old model
-- identified our company by the role string, the new one carries it via
-- is_internal. Run BEFORE the role re-bucket below so it can still match.
UPDATE parties SET is_internal = true
  WHERE is_internal = false
    AND lower(trim(role)) = ANY(ARRAY['our_company','наша компанія','наша компания']);

-- Collapse free-text party roles into the three fixed slots the UI now exposes:
--   sender (Від кого) / intermediary (Через кого) / recipient (Кому).
-- Idempotent; roles already canonical are unaffected. 'our_company' → recipient
-- (importer) is the common bilateral case; users can re-slot in the UI.
UPDATE parties SET role = 'sender'
  WHERE lower(trim(role)) = ANY(ARRAY['постачальник','поставщик','продавець','продавец',
    'supplier','seller','shipper','від кого','вид кого','вантажовідправник',
    'грузоотправитель','експортер','exporter']);
UPDATE parties SET role = 'intermediary'
  WHERE lower(trim(role)) = ANY(ARRAY['посередник','посредник','агент','agent','trader',
    'брокер','через кого']);
UPDATE parties SET role = 'recipient'
  WHERE lower(trim(role)) = ANY(ARRAY['покупець','покупатель','buyer','вантажоодержувач',
    'грузополучатель','consignee','отримувач','получатель','кому','імпортер','importer',
    'our_company','наша компанія','наша компания']);

-- ── ШТУРМАН prototype port · Phase A: chat types + collections (сборники) ──────
-- Adds a second top-level entity ("Збірник" / consolidated cargo) alongside
-- workspaces (Постачання), and lets a conversation be one of three kinds
-- (normal / supply / consolidated). All statements idempotent (db/migrate.ts
-- applies schema.sql on every boot).

-- Collections == "Збірник" (consolidated cargo) in the UI. Own folder skeleton
-- + files, mirrors workspaces but for a manifest-of-many-goods analysis flow.
-- `supplier` doubles as the manifest source ('Демо-маніфест' | 'Google Sheets'
-- | 'Вставлена таблиця'), matching the workspaces.supplier field shape.
CREATE TABLE IF NOT EXISTS collections (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number     TEXT NOT NULL,                        -- e.g. "Збірник 06.05"
  supplier   TEXT NOT NULL DEFAULT '',             -- manifest source label
  status     TEXT NOT NULL DEFAULT 'draft'
             CHECK (status IN ('active', 'draft', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_id);

-- Generalise folders + files from "belongs to a workspace" to "belongs to a
-- workspace OR a collection". workspace_id becomes nullable; a nullable
-- collection_id is added; a CHECK enforces exactly one owner. Existing rows all
-- have workspace_id set, so they satisfy the new constraint unchanged.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS collection_id UUID
  REFERENCES collections(id) ON DELETE CASCADE;
ALTER TABLE folders ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_owner_chk;
ALTER TABLE folders ADD CONSTRAINT folders_owner_chk
  CHECK ((workspace_id IS NOT NULL) <> (collection_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_folders_collection ON folders(collection_id);

ALTER TABLE files ADD COLUMN IF NOT EXISTS collection_id UUID
  REFERENCES collections(id) ON DELETE CASCADE;
ALTER TABLE files ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_owner_chk;
ALTER TABLE files ADD CONSTRAINT files_owner_chk
  CHECK ((workspace_id IS NOT NULL) <> (collection_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_files_collection ON files(collection_id);

-- Conversations gain a kind + optional collection scope. Existing conversations
-- are all workspace-scoped supply chats, so default kind = 'supply' and keep
-- workspace_id. 'normal' chats are global (no entity); 'consolidated' chats hang
-- off a collection. Exactly-one-scope is NOT enforced at DB level because
-- 'normal' has neither — the app layer sets the scope per kind.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_kind TEXT NOT NULL DEFAULT 'supply'
  CHECK (chat_kind IN ('normal', 'supply', 'consolidated'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS collection_id UUID
  REFERENCES collections(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id UUID
  REFERENCES users(id) ON DELETE CASCADE;   -- set for 'normal' (global) chats
ALTER TABLE conversations ALTER COLUMN workspace_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_collection ON conversations(collection_id);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_id);

-- ── ШТУРМАН prototype port · Phase B-2: consolidated analysis persistence ─────
-- The consolidated-cargo analysis engine (CIF / мито / ПДВ per line, origin,
-- EU/UA checks) writes one `analyses` row per run (the full result the FE card
-- reads back) plus a lightweight `archive_records` row (the "Архів" list). Both
-- are owner/collection scoped. All statements idempotent.

-- One computed analysis of a collection's manifest. `meta`/`rows`/`totals` hold
-- the consolidated AnalysisResult shape the frontend card renders; `checks`
-- holds the AI enrichment payload (euChecks/uaChecks/criticalAlert/nctsList) so
-- the .xlsx export can be rebuilt without re-running the engine.
CREATE TABLE IF NOT EXISTS analyses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  message_id    UUID,                                    -- optional link to the chat message that triggered it
  source        TEXT NOT NULL DEFAULT '',                -- manifest source label (filename | Google Sheets | Вставлена таблиця)
  sheet         TEXT NOT NULL DEFAULT '',                -- selected sheet name
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  rows          JSONB NOT NULL DEFAULT '[]'::jsonb,
  totals        JSONB NOT NULL DEFAULT '{}'::jsonb,
  checks        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analyses_collection ON analyses(collection_id);

-- Lightweight archive index (owner-scoped, capped FIFO in the route). Survives
-- collection deletion (collection_id → NULL) so the "Архів" list is durable.
CREATE TABLE IF NOT EXISTS archive_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id UUID REFERENCES collections(id) ON DELETE SET NULL,
  source        TEXT NOT NULL DEFAULT '',
  sheet         TEXT NOT NULL DEFAULT '',
  item_count    INT NOT NULL DEFAULT 0,
  payable       NUMERIC NOT NULL DEFAULT 0,
  has_high      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_archive_records_owner ON archive_records(owner_id);

-- ── Phase C: News — live RSS ingest with retention ────────────────────────────
-- NOT workspace-scoped: a single shared feed of Ukrainian import/customs-relevant
-- news, ingested by the NEWS cron (src/queue/news.ts + worker) from public RSS/Atom
-- feeds and served read-only by GET /api/news. `rubric` is one of the 8 keys in
-- src/services/news/sources.ts. `hash` = sha256(url + '|' + title) dedups re-fetches
-- (ON CONFLICT DO NOTHING). Rows older than NEWS_RETENTION_DAYS are purged each run.
CREATE TABLE IF NOT EXISTS news_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric       TEXT NOT NULL,
  title        TEXT,
  summary      TEXT,
  source       TEXT,
  url          TEXT,
  published_at TIMESTAMPTZ,
  hash         TEXT UNIQUE,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_rubric_published ON news_items(rubric, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at);

-- ── Phase D: Map — reference ports/routes + live vessel positions ──────────────
-- NOT workspace-scoped: a shared reference atlas of ports and representative
-- shipping routes for the map view. Live positions are computed at request time
-- by the tracking provider (src/services/tracking) — DEMO interpolation until an
-- AIS_API_KEY is configured. All statements idempotent (seed via ON CONFLICT).

-- Reference ports. `kind` is one of sea | inland | customs. Coordinates are real
-- (decimal degrees, WGS84). Names are Ukrainian to match the ШТУРМАН UI.
CREATE TABLE IF NOT EXISTS ports (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  lat     DOUBLE PRECISION NOT NULL,
  lng     DOUBLE PRECISION NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'sea'
          CHECK (kind IN ('sea', 'inland', 'customs'))
);

-- Representative routes between ports. `waypoints` is an ordered [[lat,lng],…]
-- polyline the map draws and the DEMO tracker interpolates along.
CREATE TABLE IF NOT EXISTS routes (
  id        TEXT PRIMARY KEY,
  from_code TEXT NOT NULL,
  to_code   TEXT NOT NULL,
  mode      TEXT NOT NULL CHECK (mode IN ('sea', 'land')),
  risk      TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  waypoints JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- Seed ports (idempotent). code | name | country | lat | lng | kind
INSERT INTO ports (code, name, country, lat, lng, kind) VALUES
  ('CNYTN', 'Яньтянь',   'CN', 22.56, 114.28, 'sea'),
  ('CNSHA', 'Шанхай',    'CN', 31.23, 121.47, 'sea'),
  ('SGSIN', 'Сингапур',  'SG',  1.26, 103.82, 'sea'),
  ('EGSUZ', 'Суец',      'EG', 30.02,  32.55, 'sea'),
  ('GRPIR', 'Пірей',     'GR', 37.94,  23.64, 'sea'),
  ('NLRTM', 'Роттердам', 'NL', 51.95,   4.14, 'sea'),
  ('DEHAM', 'Гамбург',   'DE', 53.53,   9.98, 'sea'),
  ('PLGDN', 'Гданськ',   'PL', 54.40,  18.68, 'sea'),
  ('UAKRK', 'Краковець', 'UA', 49.96,  23.17, 'customs'),
  ('UALWO', 'Львів',     'UA', 49.84,  24.03, 'inland'),
  ('UAIEV', 'Київ',      'UA', 50.45,  30.52, 'inland')
ON CONFLICT (code) DO NOTHING;

-- Seed representative routes (idempotent). Waypoints trace real port coordinates.
INSERT INTO routes (id, from_code, to_code, mode, risk, waypoints) VALUES
  ('sea-yantian-gdansk', 'CNYTN', 'PLGDN', 'sea', 'medium',
     '[[22.56,114.28],[30.02,32.55],[37.94,23.64],[54.40,18.68]]'::jsonb),
  ('land-gdansk-kyiv', 'PLGDN', 'UAIEV', 'land', 'low',
     '[[54.40,18.68],[49.96,23.17],[49.84,24.03],[50.45,30.52]]'::jsonb),
  ('sea-shanghai-rotterdam', 'CNSHA', 'NLRTM', 'sea', 'high',
     '[[31.23,121.47],[1.26,103.82],[30.02,32.55],[51.95,4.14]]'::jsonb)
ON CONFLICT (id) DO NOTHING;
