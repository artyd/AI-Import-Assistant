import { describe, expect, it } from "vitest";
import { buildFolderTree, flattenTree, folderPathLabel, subtreeIds } from "../folderTree";
import type { Folder } from "@/lib/types";

const folders: Folder[] = [
  { id: "customs", name: "03_Митниця", position: 2 },
  { id: "lotA", name: "Партія — A", position: 3, lotId: "A", role: "lot" },
  { id: "pA1", name: "Paracetamol", position: 5, lotId: "A", parentId: "lotA", role: "product" },
  { id: "cA", name: "A", position: 4, lotId: "A", parentId: "customs", role: "lot_customs" },
  { id: "transport", name: "02_Транспорт", position: 1 },
  { id: "orphan", name: "Сирота", position: 9, parentId: "missing" },
];

describe("folderTree", () => {
  it("nests by parent, orders by position, orphans go to the root", () => {
    const tree = buildFolderTree(folders);
    expect(tree.map((n) => n.folder.id)).toEqual(["transport", "customs", "lotA", "orphan"]);
    expect(tree[1]!.children.map((n) => n.folder.id)).toEqual(["cA"]);
    expect(tree[2]!.children[0]!.depth).toBe(1);
    expect(flattenTree(tree).map((n) => n.folder.id)).toEqual(["transport", "customs", "cA", "lotA", "pA1", "orphan"]);
    expect(subtreeIds(tree[2]!)).toEqual(["lotA", "pA1"]);
  });

  it("full path labels", () => {
    expect(folderPathLabel(folders, "cA")).toBe("03_Митниця / A");
    expect(folderPathLabel(folders, "pA1", (n) => n.toUpperCase())).toBe("ПАРТІЯ — A / PARACETAMOL");
  });
});
