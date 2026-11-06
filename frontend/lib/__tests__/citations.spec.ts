import { describe, expect, it } from "vitest";
import { filesLabel, groupCitations, pagesLabel } from "../citations";

describe("answer sources", () => {
  it("one row per file with its distinct pages, in first-seen order", () => {
    const g = groupCitations([
      { file: "PL.pdf", page: 2 },
      { file: "INV.pdf", page: null },
      { file: "PL.pdf", page: 1 },
      { file: "PL.pdf", page: 2 },
      { file: "INV.pdf", page: 3 },
    ]);
    expect(g).toEqual([
      { file: "PL.pdf", pages: [1, 2] },
      { file: "INV.pdf", pages: [3] },
    ]);
    expect(pagesLabel(g[0]!.pages)).toBe("с. 1, 2");
    expect(pagesLabel([])).toBe("");
  });

  it("Ukrainian plural for files", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map(filesLabel)).toEqual([
      "1 файл", "2 файли", "5 файлів", "11 файлів", "12 файлів", "21 файл", "22 файли", "25 файлів",
    ]);
  });
});
