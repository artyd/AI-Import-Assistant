import type { Folder } from "@/lib/types";

/** A folder with its children, in position order (spec 007 nested folders). */
export interface FolderNode {
  folder: Folder;
  depth: number;
  children: FolderNode[];
}

/** The folder forest. A folder whose parent is unknown is shown at the root. */
export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const ids = new Set(folders.map((f) => f.id));
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(f);
    byParent.set(parent, list);
  }
  const grow = (parent: string | null, depth: number, seen: Set<string>): FolderNode[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .filter((f) => !seen.has(f.id))
      .map((f) => {
        const next = new Set(seen).add(f.id);
        return { folder: f, depth, children: grow(f.id, depth + 1, next) };
      });
  return grow(null, 0, new Set());
}

/** Tree order, depth-first (the move menu). */
export function flattenTree(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

/** "Митниця / Shandong X" — a folder's full path. */
export function folderPathLabel(folders: Folder[], id: string, label: (name: string) => string = (n) => n): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = byId.get(id);
  for (let i = 0; cur && i < 10; i++) {
    parts.unshift(label(cur.name));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" / ");
}

/** The ids of a folder and all its descendants. */
export function subtreeIds(node: FolderNode): string[] {
  return [node.folder.id, ...node.children.flatMap(subtreeIds)];
}
