// Wire types — mirror API_CONTRACT.md exactly.

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export type WorkspaceStatus =
  | "active"
  | "draft"
  | "done"
  | "docs_in_progress"
  | "docs_complete"
  | "customs_ready";

export interface Workspace {
  id: string;
  number: string | null;
  supplier: string | null;
  status: WorkspaceStatus;
  created_at: string;
  // Intake / contract fields — present on GET /:id (optional on the list view).
  contract_type?: "bilateral" | "trilateral" | null;
  intake_complete?: boolean;
  product_category?: string | null;
  incoterm?: string | null; // legacy; mirrors incoterm_in
  incoterm_in?: string | null; // buy-side (supplier → us)
  incoterm_out?: string | null; // sell-side (us → buyer)
  transport_mode?: string | null;
  origin_country?: string | null;
  destination_country?: string | null;
  responsible_user_id?: string | null;
}

// ── ШТУРМАН prototype port · Phase A: collections + chat kinds ────────────────

// A "Збірник" (consolidated cargo) — a second top-level entity alongside
// Workspace. `supplier` doubles as the manifest source label.
export type CollectionStatus = "active" | "draft" | "done";

export interface Collection {
  id: string;
  number: string | null;
  supplier: string | null; // manifest source: Демо-маніфест | Google Sheets | Вставлена таблиця
  status: CollectionStatus;
  created_at: string;
}

// Three chat kinds with separate history (see API_CONTRACT.md):
//   normal       — global ЗЕД consultant (no entity, no tools)
//   supply       — scoped to a Workspace (Постачання), full agent + tools
//   consolidated — scoped to a Collection (Збірник), manifest analysis
export type ChatKind = "normal" | "supply" | "consolidated";

export interface UserLite {
  id: string;
  email: string;
  name: string | null;
}

// Three fixed party slots: sender (Від кого) / intermediary (Через кого) /
// recipient (Кому). The backend normalizes any legacy label into one of these.
export type PartyRole = "sender" | "intermediary" | "recipient";

export interface PartyContactInfo {
  source?: "auto" | "manual";
  source_files?: string[];
  [key: string]: unknown;
}

export interface Party {
  id?: string;
  role: PartyRole;
  company_name: string;
  is_internal?: boolean;
  country?: string | null;
  contact_info?: PartyContactInfo;
}

export interface PartySuggestion {
  role: string;
  company_name: string;
  country: string | null;
  source_files: string[];
  confidence: number;
  // Which extracted field the name came from (manufacturer / seller / buyer).
  from_field?: "manufacturer" | "seller" | "buyer";
  // Role not confirmed by the documents — UI shows "роль уточнюється".
  uncertain_role?: boolean;
}

export interface ChecklistItem {
  requirement_key: string;
  status: "missing" | "received" | "verified";
  source_file_id: string | null;
}

export type FlagKind = "confirmed" | "suspected";

export interface DiscrepancyCitation {
  file_id: string | null;
  file_name: string | null;
  doc_type: string;
  value: string;
}

export interface Discrepancy {
  field: string;
  expected: string;
  actual: string;
  severity: "error" | "warning" | "info";
  // Ranked confidence (plan Q15): "confirmed" = 🔴 deterministic mismatch backed
  // by two source citations; "suspected" = 🟡 uncertain / not fully checked.
  kind?: FlagKind;
  citations?: DiscrepancyCitation[];
}

// Human-in-the-loop verification (plan Q9/Q17): one file's extracted fields plus
// which verdict-driving fields still need the declarant's confirmation.
export interface FileExtraction {
  file_id: string;
  file_name: string;
  extraction_status: "ok" | "unreadable" | "no_fields" | null;
  fields: Record<string, unknown>;
  needs_review: string[];
  verified: boolean;
}

export interface Risk {
  code: string;
  category: "expiry" | "missing_docs" | "discrepancy" | "deadline";
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  source_file_id: string | null;
}

export interface NotificationItem {
  id: string;
  workspace_id: string | null;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface Folder {
  id: string;
  name: string;
  position: number;
}

// ── News (Новини логістики) ───────────────────────────────────────────────────
// Mirrors GET /api/news?rubric=<key> → { items: NewsItem[], counts }.
// `rubric` is one of the 8 frozen keys (see NEWS_RUBRICS in lib/news.ts).
export interface NewsItem {
  id: string;
  rubric: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  published_at: string;
}

export interface NewsResponse {
  items: NewsItem[];
  counts: Record<string, number> & { total: number };
}

// Backend emits queued|indexing|ready|error; the UI maps ready -> done.
export type FileStatus = "queued" | "indexing" | "ready" | "error";
export type UiFileStatus = "queued" | "indexing" | "done" | "error";

export interface FileItem {
  id: string;
  folderId: string | null;
  name: string;
  type: string;
  status: FileStatus;
  errorReason?: string | null;
  sizeBytes?: number;
  createdAt?: string;
  version?: number;
  isLatest?: boolean;
  replacesFileId?: string | null;
  // Classification transparency: why the file was filed + how confident, and
  // (for low-confidence inbox items) a suggested folder to confirm manually.
  folderReason?: string | null;
  folderConfidence?: "high" | "medium" | "low" | null;
  suggestedFolderId?: string | null;
  // Extraction outcome (plan Q29): 'unreadable' means the human must enter key
  // fields on the verification screen.
  extractionStatus?: "ok" | "unreadable" | "no_fields" | null;
}

// Read-progress for a shipment (or one upload batch). Mirrors the backend
// GET /api/workspaces/:id/ingest-status response.
export interface IngestStatus {
  batchId: string | null;
  total: number;
  read: number;
  pending: number;
  counts: {
    queued: number;
    indexing: number;
    ready: number;
    error: number;
    unreadable: number;
  };
  done: boolean;
  problems: {
    id: string;
    name: string;
    status: FileStatus;
    extractionStatus?: "ok" | "unreadable" | "no_fields" | null;
    errorReason?: string | null;
    folderId: string | null;
  }[];
}

// Cross-shipment problem file (GET /api/problem-files).
export interface ProblemFile {
  id: string;
  name: string;
  status: FileStatus;
  extractionStatus?: "ok" | "unreadable" | "no_fields" | null;
  errorReason?: string | null;
  workspaceId: string;
  workspaceNumber: string;
  createdAt?: string;
}

export interface FileVersion {
  id: string;
  name: string;
  version: number;
  replacesFileId: string | null;
  isLatest: boolean;
  createdAt: string;
}

export interface Citation {
  file: string;
  page: number | null;
}

export interface ToolCall {
  tool: string;
  input?: unknown;
  summary?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  tool_calls?: ToolCall[];
  created_at?: string;
}

export interface ConversationMeta {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

// SSE (chat) event payloads
export interface TokenEvent {
  text: string;
}
export interface ToolCallEvent {
  tool: string;
  input: Record<string, unknown>;
}
export interface ToolResultEvent {
  tool: string;
  summary: string;
}
export interface DoneEvent {
  message: string;
  citations: Citation[];
  conversationId: string;
  messageId: string;
}
export interface ErrorEvent {
  message: string;
}

// SSE (events channel) payload
export interface FileStatusEvent {
  fileId: string;
  status: FileStatus | "deleted";
  name?: string;
  errorReason?: string | null;
  // Present when the worker auto-filed an inbox file (e.g. an OCR'd scan).
  folderId?: string | null;
}

export function toUiStatus(s: FileStatus): UiFileStatus {
  return s === "ready" ? "done" : s;
}

// ── Consolidated-cargo analysis (Аналіз збірного вантажу) ─────────────────────
// Mirrors the backend AnalysisResult returned by POST /api/collections/:id/analyze.

// One broker check line. status drives the coloured dot: green|yellow|red →
// var(--ok)|var(--warn)|var(--err).
export interface AnalysisCheck {
  item: string;
  status: string; // "green" | "yellow" | "red"
  note: string;
}

export interface AnalysisRow {
  name: string;
  code: string | null; // УКТ ЗЕД
  codeSuggested?: boolean; // code proposed by the engine, not from the manifest
  codeBasis?: string | null; // official HS description backing a suggested code
  codeVerified?: boolean | null; // suggested code confirmed to exist in qdpro
  qtyKg: number;
  price: number;
  dutyRate: number | null;
  category: string;
  origin: string | null; // plant|animal|fermentation|mineral|synthetic|mixed|unknown
  risk: string | null; // Критичний | Середній | Низький
  riskNote: string;
  cif: number;
  duty: number | null;
  vat: number | null;
  eu: AnalysisCheck[];
  ua: AnalysisCheck[];
  needsReview: boolean;
  sourceCheck?: SourceCheck | null;
}

// Live cross-check with the official source (qdpro via logist-mcp). Enrichment
// only — never alters the CIF/мито/ПДВ numbers above.
export interface SourceCheck {
  dutyPref: string | null;
  dutyFull: string | null;
  banRf: boolean;
  license: boolean;
  vetControl: boolean;
  phyto: boolean;
  dualUse: boolean;
  narcotic: boolean;
  dutyMismatch: boolean;
  source: string;
}

export interface AnalysisMeta {
  sheet: string;
  date: string | null;
  reason: string;
  ignored: string[];
}

export interface AnalysisTotals {
  cif: number;
  duty: number;
  vat: number;
  payable: number;
  count: number;
}

export interface AnalysisResult {
  id: string | null;
  meta: AnalysisMeta;
  rows: AnalysisRow[];
  totals: AnalysisTotals;
  source: string;
  sheet: string;
  criticalAlert: string;
  nctsList: string[];
  warnings: string[];
  hasHigh: boolean;
  aiDegraded: boolean;
  sourceChecked?: boolean;
  costDataAvailable?: boolean; // false ⇒ classification-only (no price/qty data)
  fx?: { currency: string; rate: number; date: string } | null; // NBU rate → UAH
}

// ── Map (Карта постачань) ─────────────────────────────────────────────────────
// Mirror GET /api/map/{ports,routes,shipments}.

export type PortKind = "sea" | "inland" | "customs";

export interface Port {
  code: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  kind: PortKind;
}

export type RouteMode = "sea" | "land";
export type RouteRisk = "low" | "medium" | "high";

export interface MapRoute {
  id: string;
  from_code: string;
  to_code: string;
  mode: RouteMode;
  risk: RouteRisk;
  // Ordered [lat, lng] polyline vertices.
  waypoints: [number, number][];
}

export interface Vessel {
  id: string;
  kind: "ship" | "truck";
  label: string;
  lat: number;
  lng: number;
  status: string;
  routeId: string | null;
}

// ── AI settings (BYOK) ────────────────────────────────────────────────────────
// Mirrors GET/PUT /api/ai-config. `engine` = builtin (server-side Claude) or byok
// (customer-supplied key for the consolidated-cargo analysis engine). `keyMask` is
// a masked hint (e.g. "••••1234"); the real key never comes back to the browser.
export type AiProvider = "openai" | "gemini" | "claude" | "openrouter";

export interface AiConfig {
  engine: "builtin" | "byok";
  provider: string | null;
  hasKey: boolean;
  keyMask: string | null;
}

export interface ArchiveRecord {
  id: string;
  collectionId: string | null;
  analysisId: string | null; // full analysis for preview/xlsx; null once deleted
  source: string;
  sheet: string;
  itemCount: number;
  payable: number | string;
  hasHigh: boolean;
  createdAt: string;
}
