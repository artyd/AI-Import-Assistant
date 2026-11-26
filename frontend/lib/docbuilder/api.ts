import { api, ApiError, getToken, handleUnauthorized } from "@/lib/api";
import type {
  ContractData,
  DirectoryParty,
  DirectoryProduct,
  DocData,
  DocEvent,
  DocFull,
  DocKind,
  DocStatus,
  DocSummary,
  Finding,
  InvoiceData,
  Party,
  PartyRole,
  Product,
  TemplateInfo,
} from "./model";

// REST client for /api/docbuilder (API_CONTRACT.md § Document builder).

export const listParties = () => api<{ parties: DirectoryParty[] }>("/api/docbuilder/parties").then((r) => r.parties);
export const createParty = (p: Omit<DirectoryParty, "id">) =>
  api<{ party: DirectoryParty }>("/api/docbuilder/parties", { method: "POST", body: p }).then((r) => r.party);
export const updateParty = (p: DirectoryParty) =>
  api<{ party: DirectoryParty }>(`/api/docbuilder/parties/${p.id}`, { method: "PUT", body: p }).then((r) => r.party);
export const deleteParty = (id: string) => api(`/api/docbuilder/parties/${id}`, { method: "DELETE" });

export const listProducts = () => api<{ products: DirectoryProduct[] }>("/api/docbuilder/products").then((r) => r.products);
export const createProduct = (p: Product) =>
  api<{ product: DirectoryProduct }>("/api/docbuilder/products", { method: "POST", body: p }).then((r) => r.product);
export const updateProduct = (p: DirectoryProduct) =>
  api<{ product: DirectoryProduct }>(`/api/docbuilder/products/${p.id}`, { method: "PUT", body: p }).then((r) => r.product);
export const deleteProduct = (id: string) => api(`/api/docbuilder/products/${id}`, { method: "DELETE" });

export const listDocuments = () => api<{ documents: DocSummary[] }>("/api/docbuilder/documents").then((r) => r.documents);
export const getDocument = (id: string) => api<{ document: DocFull }>(`/api/docbuilder/documents/${id}`).then((r) => r.document);
export const createDocument = (kind: DocKind, data: DocData, contractId?: string | null, workspaceId?: string | null) =>
  api<{ document: DocFull }>("/api/docbuilder/documents", {
    method: "POST",
    body: { kind, data, contractId: contractId ?? null, workspaceId: workspaceId ?? null },
  }).then((r) => r.document);
export const saveDocument = (id: string, data: DocData) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${id}`, { method: "PUT", body: { data } }).then((r) => r.document);
export const deleteDocument = (id: string) => api(`/api/docbuilder/documents/${id}`, { method: "DELETE" });
export const invoiceFrom = (id: string) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${id}/invoice`, { method: "POST" }).then((r) => r.document);
export const appendixFrom = (contractId: string) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${contractId}/appendix`, { method: "POST" }).then((r) => r.document);
export const setStatus = (id: string, status: DocStatus) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${id}/status`, { method: "POST", body: { status } }).then((r) => r.document);
export const newVersion = (id: string) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${id}/version`, { method: "POST" }).then((r) => r.document);
export const listEvents = (id: string) => api<{ events: DocEvent[] }>(`/api/docbuilder/documents/${id}/events`).then((r) => r.events);
export const toShipment = (id: string, workspaceId: string) =>
  api<{ fileId: string; duplicateOf: string | null; workspaceId: string }>(`/api/docbuilder/documents/${id}/to-shipment`, {
    method: "POST",
    body: { workspaceId },
  });
export const fromShipment = (workspaceId: string) =>
  api<{ contract: ContractData; invoice: InvoiceData; sources: string[] }>(`/api/docbuilder/from-shipment/${workspaceId}`);

export const checkDocument = (kind: DocKind, data: DocData, id: string | null, contractId: string | null) =>
  api<{ findings: Finding[] }>("/api/docbuilder/check", { method: "POST", body: { kind, data, id, contractId } }).then((r) => r.findings);
export const nextNumber = (kind: DocKind, contractId?: string | null) =>
  api<{ number: string }>(`/api/docbuilder/next-number?kind=${kind}${contractId ? `&contractId=${contractId}` : ""}`).then((r) => r.number);

export const previewHtml = (kind: DocKind, data: DocData, signal?: AbortSignal) =>
  api<{ html: string; total: number }>("/api/docbuilder/render", { method: "POST", body: { kind, data, format: "html" }, signal });

export const listTemplates = () => api<{ templates: TemplateInfo[] }>("/api/docbuilder/templates").then((r) => r.templates);
export const templateTags = (kind: DocKind) =>
  api<{ tags: { tag: string; example: string }[] }>(`/api/docbuilder/templates/tags?kind=${kind}`).then((r) => r.tags);
export const deleteTemplate = (id: string) => api(`/api/docbuilder/templates/${id}`, { method: "DELETE" });
export function uploadTemplate(kind: DocKind, name: string, file: File) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("name", name);
  form.append("file", file);
  return api<{ template: TemplateInfo }>("/api/docbuilder/templates", { form }).then((r) => r.template);
}

export interface ExtractResult {
  companies: (Party & { role: PartyRole })[];
  products: Product[];
  note: string | null;
}
export function extractFromFile(file: File) {
  const form = new FormData();
  form.append("file", file);
  return api<ExtractResult>("/api/docbuilder/extract", { form });
}

export interface ShipmentOption {
  id: string;
  number: string | null;
  supplier: string | null;
}
export const listShipments = () => api<{ workspaces: ShipmentOption[] }>("/api/workspaces").then((r) => r.workspaces);

function fileName(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  return utf?.[1] ? decodeURIComponent(utf[1]) : fallback;
}

async function saveResponse(res: Response, path: string, fallback: string): Promise<void> {
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    let message = `Не вдалося сформувати документ (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; details?: string[] };
      if (body.message) message = [body.message, ...(body.details ?? [])].join(": ");
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, "render_failed", message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(res, fallback);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const auth = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** Builds the document from the editor's current data (Word or PDF) and saves it in the browser. */
export async function downloadDoc(kind: DocKind, data: DocData, format: "docx" | "pdf" = "docx"): Promise<void> {
  const path = "/api/docbuilder/render";
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...auth() }, body: JSON.stringify({ kind, data, format }) });
  await saveResponse(res, path, `${kind}.${format}`);
}

/** Back-compat name used by older callers. */
export const downloadDocx = (kind: DocKind, data: DocData) => downloadDoc(kind, data, "docx");

/** The document with everything linked to it, as one ZIP (optionally with PDFs). */
export async function downloadBundle(id: string, withPdf: boolean): Promise<void> {
  const path = `/api/docbuilder/documents/${id}/bundle.zip${withPdf ? "?pdf=1" : ""}`;
  const res = await fetch(path, { headers: auth() });
  await saveResponse(res, path, "documents.zip");
}

export async function downloadTemplateFile(path: string, fallback: string): Promise<void> {
  const res = await fetch(path, { headers: auth() });
  await saveResponse(res, path, fallback);
}
