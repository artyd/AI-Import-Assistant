import { describe, expect, it } from "vitest";
import {
  classifyFinding,
  cleanText,
  docTypeLabel,
  fieldLabel,
  filesText,
  findingView,
  groupFindings,
  requestErrorText,
  requirementLabel,
  statusCaveat,
  summarizeFindings,
  summaryText,
  truncate,
} from "../findings";

const f = (severity: "error" | "warning" | "info", kind?: "confirmed" | "suspected") => ({ severity, kind });

describe("classify / summarize", () => {
  it("info is a note whatever its kind; suspected is «перевірити»", () => {
    expect(classifyFinding(f("info", "confirmed"))).toBe("note");
    expect(classifyFinding(f("warning", "suspected"))).toBe("check");
    expect(classifyFinding(f("error", "confirmed"))).toBe("problem");
    expect(classifyFinding(f("warning"))).toBe("problem");
  });

  it("13 findings that are mostly notes are not «13 розбіжностей»", () => {
    const items = [...Array.from({ length: 11 }, () => f("info", "confirmed")), f("warning", "suspected"), f("warning", "confirmed")];
    const s = summarizeFindings(items);
    expect(s).toMatchObject({ errors: 0, warnings: 1, toCheck: 1, notes: 11, problems: 2, tone: "warn" });
    expect(summaryText(s)).toBe("1 проблема · 1 перевірити · 11 приміток");
  });

  it("only a confirmed error turns red; a suspected error does not", () => {
    expect(summarizeFindings([f("error", "suspected")]).tone).toBe("warn");
    expect(summarizeFindings([f("error", "confirmed")]).tone).toBe("err");
    expect(summarizeFindings([f("info")]).tone).toBe("ok");
    expect(summarizeFindings([]).tone).toBe("ok");
    expect(summaryText(summarizeFindings([]))).toBe("");
  });

  it("groups problems (errors first), checks, notes", () => {
    const g = groupFindings([f("info"), f("warning", "confirmed"), f("error", "confirmed"), f("warning", "suspected")]);
    expect(g.problems.map((x) => x.severity)).toEqual(["error", "warning"]);
    expect(g.check).toHaveLength(1);
    expect(g.notes).toHaveLength(1);
  });
});

describe("labels", () => {
  it("never leaks raw field keys", () => {
    expect(fieldLabel("net_weight_kg")).toBe("Вага нетто");
    expect(fieldLabel("hbl_versions_gross_weight_kg")).toBe("Вага брутто в копіях HBL");
    expect(fieldLabel("hbl_versions_packages_count")).toBe("Кількість місць у копіях HBL");
    expect(fieldLabel("hbl_versions_consignee_name")).toBe("Одержувач у копіях HBL");
    expect(fieldLabel("lot_gross_weight_kg")).toBe("Вага брутто партії (PL проти HBL)");
    expect(fieldLabel("lot_packages_count")).toBe("Кількість місць партії");
    expect(fieldLabel("manifest_qty")).toBe("Кількість у маніфесті");
    expect(fieldLabel("documents")).toBe("Документи");
    expect(fieldLabel("customs_declaration:ТОВ Альфа")).toBe("Митна декларація — ТОВ Альфа");
    expect(fieldLabel("hbl:0b8e3c1e-1111-4222-8333-944444444444")).toBe("House-коносамент (HBL)");
    expect(fieldLabel("hbl_versions_something_new")).toBe("Копії HBL: інший показник");
    expect(fieldLabel("some_future_field")).toBe("Інший показник");
  });

  it("humanises checklist requirement keys", () => {
    expect(requirementLabel("intermediary_agreement")).toBe("Договір з посередником");
    expect(requirementLabel("customs_declaration:ТОВ Альфа")).toBe("Митна декларація — ТОВ Альфа");
    expect(requirementLabel("hbl:0b8e3c1e-1111-4222-8333-944444444444")).toBe("House-коносамент (HBL)");
    expect(requirementLabel("manifest")).toBe("Маніфест збірника");
    expect(requirementLabel("brand_new_doc")).toBe("Інший документ");
  });

  it("humanises document types of citations", () => {
    expect(docTypeLabel("packing_list")).toBe("Пакувальний лист");
    expect(docTypeLabel("transport")).toBe("Транспортний документ");
    expect(docTypeLabel("weird_type")).toBe("Документ");
  });

  it("strips internal markers and ids from values", () => {
    expect(cleanText("[suspected] 12 кг")).toBe("12 кг");
    expect(cleanText("HBL 0b8e3c1e-1111-4222-8333-944444444444: 5")).toBe("HBL …: 5");
  });

  it("request errors never show a raw code", () => {
    expect(requestErrorText("db_exploded")).toBe("Не вдалося виконати запит. Спробуйте ще раз.");
    expect(requestErrorText(undefined)).not.toMatch(/_/);
    expect(requestErrorText("not_found")).toBe("Поставку не знайдено.");
  });
});

describe("compact finding", () => {
  const cite = (n: string | null) => ({ file_id: null, file_name: n, doc_type: "invoice", value: "1" });

  it("truncates long file lists with «+N» and dedupes names", () => {
    expect(filesText([cite("a.pdf"), cite("a.pdf"), cite("b.pdf"), cite("c.pdf"), cite("d.pdf")])).toBe("«a.pdf», «b.pdf» +2");
    expect(filesText([cite(null)])).toBe("");
    expect(filesText(undefined)).toBe("");
  });

  it("shows what — where → values on short lines", () => {
    const v = findingView({
      field: "hbl_versions_gross_weight_kg",
      expected: `HBL-1: ${"9".repeat(200)}`,
      actual: "100 / 120",
      severity: "warning",
      kind: "suspected",
      lot: "Alpha",
      citations: [cite("hbl1.pdf"), cite("hbl2.pdf"), cite("hbl3.pdf")],
    });
    expect(v.title).toBe("Вага брутто в копіях HBL");
    expect(v.lot).toBe("Alpha");
    expect(v.cls).toBe("check");
    expect(v.values.length).toBeLessThan(180);
    expect(v.values.endsWith("→ 100 / 120")).toBe(true);
    expect(v.files).toBe("«hbl1.pdf», «hbl2.pdf» +1");
  });

  it("truncate keeps short text", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("statusCaveat", () => {
  it("flags a ready status next to problems, stays quiet otherwise", () => {
    expect(statusCaveat("customs_ready", { errors: 1, warnings: 1, toCheck: 0 })).toBe("Є 2 проблеми — перегляньте перед митницею.");
    expect(statusCaveat("done", { errors: 0, warnings: 0, toCheck: 2 })).toMatch(/перевірити/);
    expect(statusCaveat("customs_ready", { errors: 0, warnings: 0, toCheck: 0 })).toBeNull();
    expect(statusCaveat("draft", { errors: 3, warnings: 0, toCheck: 0 })).toBeNull();
  });
});
