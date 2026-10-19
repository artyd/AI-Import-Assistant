import { api } from "@/lib/api";
import { streamAnalyze, type AnalyzeDone } from "@/lib/sse";
import type { AnalysisResult } from "@/lib/types";

/** Where the manifest comes from: a file, or a Google Sheets link / pasted table. */
export type ManifestSource = { file: File } | { input: string };

/** The analyze request body (multipart for a file, JSON otherwise). */
export function analyzeBody(source: ManifestSource, conversationId?: string): FormData | Record<string, unknown> {
  if ("file" in source) {
    const form = new FormData();
    // conversationId BEFORE the file so the server sees it in part.fields.
    if (conversationId) form.append("conversationId", conversationId);
    form.append("files", source.file, source.file.name || "manifest");
    return form;
  }
  const trimmed = source.input.trim();
  const base = /^https?:\/\//i.test(trimmed) ? { sheetUrl: trimmed } : { text: trimmed };
  return conversationId ? { ...base, conversationId } : base;
}

export type AnalysisOutcome =
  | { kind: "done"; done: AnalyzeDone }
  | { kind: "error"; message: string }
  | { kind: "aborted" };

/**
 * Run one consolidated analysis over the SSE progress stream. Never throws:
 * a server error, a stream that ends without a result, and a network failure
 * all come back as `error` with the user-facing message.
 */
export async function runAnalysis(
  collectionId: string,
  body: FormData | Record<string, unknown>,
  onProgress: (e: { pct: number; step: string }) => void,
  signal: AbortSignal,
): Promise<AnalysisOutcome> {
  let outcome: AnalysisOutcome | null = null;
  try {
    await streamAnalyze(
      `/api/collections/${collectionId}/analyze`,
      body,
      {
        onProgress,
        onDone: (done) => (outcome = { kind: "done", done }),
        onError: (message) => (outcome = { kind: "error", message: message || "Не вдалося виконати аналіз." }),
      },
      signal,
    );
  } catch {
    if (!signal.aborted) return { kind: "error", message: "Не вдалося виконати аналіз." };
  }
  if (signal.aborted) return { kind: "aborted" };
  return outcome ?? { kind: "error", message: "Аналіз перервано. Спробуйте ще раз." };
}

/** The collection's latest persisted analysis (null when none). */
export async function fetchLatestAnalysis(collectionId: string): Promise<AnalysisResult | null> {
  const r = await api<{ analysis: AnalysisResult | null }>(`/api/collections/${collectionId}/analysis/latest`);
  return r.analysis;
}
