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
  incoterm?: string | null;
  transport_mode?: string | null;
  origin_country?: string | null;
  responsible_user_id?: string | null;
}

export interface UserLite {
  id: string;
  email: string;
  name: string | null;
}

export type PartyRole = "our_company" | "supplier" | "intermediary";

export interface Party {
  id?: string;
  role: PartyRole;
  company_name: string;
  is_internal?: boolean;
  country?: string | null;
  contact_info?: Record<string, unknown>;
}

export interface ChecklistItem {
  requirement_key: string;
  status: "missing" | "received" | "verified";
  source_file_id: string | null;
}

export interface Discrepancy {
  field: string;
  expected: string;
  actual: string;
  severity: "error" | "warning" | "info";
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
}

export function toUiStatus(s: FileStatus): UiFileStatus {
  return s === "ready" ? "done" : s;
}
