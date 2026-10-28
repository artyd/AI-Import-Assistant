"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, uploadWithProgress } from "@/lib/api";
import { openEventsChannel } from "@/lib/sse";
import type { FileItem, FileStatusEvent, Folder, IngestEvent } from "@/lib/types";
import type { NoticeTone } from "@/components/ui/Notice";
import {
  applyFileStatus,
  docsStatusOf,
  mapLimit,
  replayOnSnapshot,
  restored,
  withPatch,
  without,
  withUploaded,
} from "./fileList";
import { ACCEPT_LABEL, planUpload, uploadReport } from "./policy";

export interface UploadProgress {
  pct: number;
  files: number;
}

export interface ClassifiedUpload {
  fileId: string;
  name: string;
  folderName: string | null;
  /** Not filed yet: Штурман files it after reading (spec 007). */
  deferred?: boolean;
}

/** How many journal lines the page keeps. */
const JOURNAL_MAX = 500;

/**
 * A shipment's files: the list, live file_status updates, uploads (batched,
 * with progress), and every file operation with optimistic UI. The page and the
 * chat use this one interface; the rules live in ./fileList and ./policy.
 */
export function useShipmentFiles(
  id: string,
  opts: { live: boolean; folders: Folder[]; notify: (text: string, tone?: NoticeTone) => void },
) {
  const { live, folders, notify } = opts;
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  // The reading journal (spec 007): history on load, then live lines.
  const [journal, setJournal] = useState<IngestEvent[]>([]);
  const addJournal = useCallback((events: IngestEvent[] | undefined) => {
    // A missing/odd payload (older backend, a proxy error page) is ignored.
    if (!Array.isArray(events)) return;
    setJournal((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const add = events.filter((e) => e && typeof e.id === "string" && !seen.has(e.id));
      if (add.length === 0) return prev;
      return [...prev, ...add].sort((a, b) => Number(a.id) - Number(b.id)).slice(-JOURNAL_MAX);
    });
  }, []);
  const refreshJournal = useCallback(async () => {
    const r = await api<{ events?: IngestEvent[] }>(`/api/workspaces/${id}/ingest-log?limit=300`);
    addJournal(r?.events);
  }, [id, addJournal]);
  useEffect(() => {
    setJournal([]);
  }, [id]);
  const docsStatus = useMemo(() => docsStatusOf(files), [files]);

  // file_status events that arrive while a refresh is in flight are re-applied
  // on top of its (possibly older) snapshot, so a resync can never roll a file
  // back to a stale status.
  const refreshInFlight = useRef(0);
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferedEvents = useRef<FileStatusEvent[]>([]);

  const refreshFiles = useCallback(async () => {
    refreshInFlight.current += 1;
    try {
      const r = await api<{ files: FileItem[] }>(`/api/workspaces/${id}/files`);
      setFiles(replayOnSnapshot(r.files, bufferedEvents.current.slice()));
    } finally {
      refreshInFlight.current -= 1;
      if (refreshInFlight.current === 0) bufferedEvents.current = [];
    }
  }, [id]);

  // Live channel. Depends only on stable values; it reconnects itself with
  // backoff and a fresh SSE ticket, and every (re)open resyncs the list.
  useEffect(() => {
    if (!live) return;
    const channel = openEventsChannel(id, {
      onFileStatus: (raw) => {
        const ev = raw as FileStatusEvent;
        if (refreshInFlight.current > 0) bufferedEvents.current.push(ev);
        setFiles((prev) => applyFileStatus(prev, ev));
      },
      onIngestLog: (raw) => {
        const ev = raw as IngestEvent;
        addJournal([ev]);
        // A filing / batch summary changed folders and links (links don't ride
        // on file_status) — resync the list once the burst settles.
        if (ev.kind === "file" || ev.kind === "summary") {
          if (resyncTimer.current) clearTimeout(resyncTimer.current);
          resyncTimer.current = setTimeout(() => void refreshFiles().catch(() => {}), 1500);
        }
      },
      onOpen: () => {
        void refreshFiles().catch(() => {});
        void refreshJournal().catch(() => {});
      },
    });
    return () => {
      channel.close();
      if (resyncTimer.current) clearTimeout(resyncTimer.current);
    };
  }, [id, live, refreshFiles, refreshJournal, addJournal]);

  const upload = useCallback(
    async (folderId: string | null, fileList: FileList | File[], replacesFileId?: string): Promise<FileItem[]> => {
      // Oversize files are skipped up front and reported; the rest goes in
      // count- AND byte-bounded batches, POSTed sequentially, so a big drop
      // never trips the server's per-request caps. A .zip is expanded server-side.
      const { batches, skipped } = planUpload(Array.from(fileList));
      if (batches.length === 0) {
        const report = uploadReport(null, [], skipped);
        if (report) notify(report);
        return [];
      }

      const totalBytes = batches.flat().reduce((s, f) => s + f.size, 0) || 1;
      const totalFiles = batches.reduce((s, b) => s + b.length, 0);
      let sentBytes = 0;
      setUploadProgress({ pct: 0, files: totalFiles });

      const created: FileItem[] = [];
      const rejected: { name: string; reason: string }[] = [];
      let failure: string | null = null;
      try {
        for (let i = 0; i < batches.length; i++) {
          const chunk = batches[i]!;
          const chunkBytes = chunk.reduce((s, f) => s + f.size, 0);
          const form = new FormData();
          for (const f of chunk) form.append("files", f, f.name || "file");
          // A version-replace targets one existing file — only the first request carries it.
          const sp = new URLSearchParams();
          if (folderId) sp.set("folderId", folderId);
          if (i === 0 && replacesFileId) sp.set("replacesFileId", replacesFileId);
          const qs = sp.toString() ? `?${sp.toString()}` : "";
          const res = await uploadWithProgress<{ files: FileItem[]; rejected?: { name: string; reason: string }[] }>(
            `/api/workspaces/${id}/files${qs}`,
            form,
            (loaded, total) => {
              // XHR's total includes multipart overhead → scale to this chunk's bytes.
              const done = sentBytes + (total > 0 ? (loaded / total) * chunkBytes : 0);
              setUploadProgress({ pct: Math.min(100, Math.round((done / totalBytes) * 100)), files: totalFiles });
            },
          );
          sentBytes += chunkBytes;
          created.push(...res.files);
          if (res.rejected) rejected.push(...res.rejected);
          setFiles((prev) => withUploaded(prev, res.files));
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) failure = null; // → /login
        else if (err instanceof ApiError && err.code === "no_valid_files")
          failure = `Жоден файл не підійшов (дозволені: ${ACCEPT_LABEL}).`;
        else failure = "Не вдалося завантажити файли.";
      } finally {
        setUploadProgress(null);
      }
      const report = uploadReport(failure, rejected, skipped);
      if (report) notify(report);
      return created;
    },
    [id, notify],
  );

  const renameFile = useCallback(
    async (file: FileItem, name: string) => {
      setFiles((prev) => withPatch(prev, file.id, { name }));
      try {
        await api(`/api/workspaces/${id}/files/${file.id}`, { method: "PATCH", body: { name } });
      } catch {
        setFiles((prev) => withPatch(prev, file.id, { name: file.name }));
      }
    },
    [id],
  );

  const deleteFile = useCallback(
    async (file: FileItem) => {
      let index = -1;
      setFiles((prev) => {
        index = prev.findIndex((f) => f.id === file.id);
        return without(prev, file.id);
      });
      try {
        await api(`/api/workspaces/${id}/files/${file.id}`, { method: "DELETE" });
      } catch {
        setFiles((prev) => restored(prev, file, index));
      }
    },
    [id],
  );

  const moveFile = useCallback(
    async (fileId: string, folderId: string) => {
      let before: string | null | undefined;
      setFiles((prev) => {
        before = prev.find((f) => f.id === fileId)?.folderId;
        return withPatch(prev, fileId, { folderId });
      });
      try {
        await api(`/api/workspaces/${id}/files/${fileId}`, { method: "PATCH", body: { folderId } });
      } catch {
        if (before !== undefined) setFiles((prev) => withPatch(prev, fileId, { folderId: before! }));
        throw new Error("move_failed");
      }
    },
    [id],
  );

  const classifyFile = useCallback(
    async (fileId: string): Promise<{ folderName: string | null; deferred: boolean }> => {
      const { folderName, deferred } = await api<{ fileId: string; folderName: string | null; deferred?: boolean }>(
        `/api/workspaces/${id}/files/${fileId}/classify`,
        { method: "POST" },
      );
      if (folderName) {
        const target = folders.find((f) => f.name === folderName);
        if (target) setFiles((p) => withPatch(p, fileId, { folderId: target.id }));
      }
      return { folderName, deferred: !!deferred };
    },
    [id, folders],
  );

  // Upload from the file tree. Filing is the server's job now (spec 007): the
  // worker reads each file and only then files it (an FCL: the whole batch at
  // once), reporting every move in the reading journal and over file_status.
  const uploadSmart = useCallback(
    (folderId: string | null, fileList: FileList | File[]): Promise<FileItem[]> => upload(folderId, fileList),
    [upload],
  );

  /** The chat paperclip: upload to the inbox, classify each file, report where it went. */
  const uploadAndClassify = useCallback(
    async (fileList: FileList | File[]): Promise<ClassifiedUpload[]> => {
      const created = await upload(null, fileList);
      return mapLimit(created, 4, async (f) => {
        try {
          return { fileId: f.id, name: f.name, ...(await classifyFile(f.id)) };
        } catch {
          return { fileId: f.id, name: f.name, folderName: null };
        }
      });
    },
    [upload, classifyFile],
  );

  const sortInbox = useCallback(async () => {
    try {
      const res = await api<{
        moved: { fileId: string; name: string; to: string }[];
        unclassified: { fileId: string; name: string }[];
      }>(`/api/workspaces/${id}/sort-inbox`, { method: "POST" });
      await refreshFiles();
      const left = res.unclassified.length;
      notify(`Розкладено: ${res.moved.length}.` + (left ? `\nНе вдалося визначити: ${left}.` : ""), "info");
    } catch {
      notify("Не вдалося розкласти інбокс.");
    }
  }, [id, refreshFiles, notify]);

  const reindexFile = useCallback(
    async (file: FileItem) => {
      setFiles((p) => withPatch(p, file.id, { status: "queued", errorReason: null }));
      try {
        await api(`/api/workspaces/${id}/files/${file.id}/reindex`, { method: "POST" });
      } catch {
        notify("Не вдалося запустити переіндексацію.");
        await refreshFiles();
      }
    },
    [id, refreshFiles, notify],
  );

  return {
    files,
    /** Replace the list (the page's initial load). */
    setFiles,
    uploadProgress,
    docsStatus,
    refreshFiles,
    upload,
    renameFile,
    deleteFile,
    moveFile,
    classifyFile,
    uploadSmart,
    uploadAndClassify,
    sortInbox,
    reindexFile,
    /** The reading journal (spec 007), oldest first. */
    journal,
  };
}
