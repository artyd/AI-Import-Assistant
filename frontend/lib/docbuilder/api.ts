import { api, ApiError, getToken, handleUnauthorized } from "@/lib/api";
import type { DirectoryParty, DirectoryProduct, DocData, DocFull, DocKind, DocSummary, Product } from "./model";

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
export const createDocument = (kind: DocKind, data: DocData, contractId?: string | null) =>
  api<{ document: DocFull }>("/api/docbuilder/documents", { method: "POST", body: { kind, data, contractId: contractId ?? null } }).then(
    (r) => r.document,
  );
export const saveDocument = (id: string, data: DocData) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${id}`, { method: "PUT", body: { data } }).then((r) => r.document);
export const deleteDocument = (id: string) => api(`/api/docbuilder/documents/${id}`, { method: "DELETE" });
export const invoiceFromContract = (contractId: string) =>
  api<{ document: DocFull }>(`/api/docbuilder/documents/${contractId}/invoice`, { method: "POST" }).then((r) => r.document);

export const previewHtml = (kind: DocKind, data: DocData, signal?: AbortSignal) =>
  api<{ html: string; total: number }>("/api/docbuilder/render", { method: "POST", body: { kind, data, format: "html" }, signal });

/** Builds the .docx from the editor's current data and saves it in the browser. */
export async function downloadDocx(kind: DocKind, data: DocData): Promise<void> {
  const token = getToken();
  const path = "/api/docbuilder/render";
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ kind, data, format: "docx" }),
  });
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, "render_failed", `Не вдалося сформувати документ (${res.status})`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = utf?.[1] ? decodeURIComponent(utf[1]) : `${kind}.docx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
