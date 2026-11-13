import type { Discrepancy, FclOverview, LotStatus, LotSummary, ManifestMatch } from "@/lib/types";
import { type FindingSummary, summarizeFindings, summaryText } from "@/lib/shipment/findings";

/**
 * Pure view helpers for a Збірник (FCL, spec 006): traffic lights of a lot, labels,
 * and the scope of the «Комплектність» switcher. No I/O — components fetch.
 */

export type Light = "ok" | "warn" | "err";

export const LOT_STATUS_LABEL: Record<LotStatus, string> = {
  draft: "Чернетка",
  docs_in_progress: "Документи в роботі",
  docs_complete: "Документи повні",
  customs_ready: "Готово до митниці",
};

export const MATCH_LABEL: Record<ManifestMatch["status"], string> = {
  ok: "збігається",
  qty: "розбіжність кг",
  price: "розбіжність ціни",
  no_invoice: "немає інвойсу",
  not_in_manifest: "поза маніфестом",
};

export const LIGHT_COLOR: Record<Light, string> = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)" };

type LotFinding = Discrepancy & { lot?: string };

/** Findings of one lot (the overview labels each with the lot name); notes included. */
export function lotFindings(lotName: string, all: LotFinding[]): FindingSummary {
  return summarizeFindings(all.filter((d) => d.lot === lotName));
}

/**
 * Red only on a confirmed error (finding or risk), yellow on gaps, warnings or
 * «перевірити»; info notes never colour a lot. `f` comes from lotFindings — the
 * summary counts the server sends include info notes, so they are not used.
 */
export function lotLight(
  l: Pick<LotSummary, "completeness" | "risks">,
  f: Pick<FindingSummary, "errors" | "warnings" | "toCheck">,
): Light {
  if (f.errors > 0 || l.risks.error > 0) return "err";
  if (l.completeness.done < l.completeness.total || f.warnings > 0 || f.toCheck > 0 || l.risks.warning > 0) return "warn";
  return "ok";
}

/** Header numbers of the whole FCL: FCL-level and lot-level findings kept apart. */
export function fclCounts(o: Pick<FclOverview, "risks" | "all_discrepancies">) {
  const level = summarizeFindings(o.all_discrepancies.filter((d) => !d.lot));
  const lots = summarizeFindings(o.all_discrepancies.filter((d) => !!d.lot));
  const risks = summarizeFindings(o.risks);
  return {
    risksError: risks.errors,
    risksWarning: risks.warnings + risks.toCheck,
    risksNotes: risks.notes,
    level,
    lots,
    all: summarizeFindings(o.all_discrepancies),
  };
}

/** «Комплектність» scope: the whole FCL ("fcl") or one lot id; a vanished lot falls back to the FCL. */
export function resolveScope(scope: string, lots: Pick<LotSummary, "id">[]): string {
  return scope === "fcl" || lots.some((l) => l.id === scope) ? scope : "fcl";
}

/** The «Без партії» hint: how many files are outside lots and FCL folders. */
export function unassignedLabel(n: number): string | null {
  if (n <= 0) return null;
  const word = n % 10 === 1 && n % 100 !== 11 ? "файл" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "файли" : "файлів";
  return `Без партії: ${n} ${word}`;
}

export interface LotRow {
  id: string;
  name: string;
  consignee: string | null;
  light: Light;
  /** «5/7» — required documents present. */
  docs: string;
  /** «2 проблеми · 3 перевірити» without notes, or «без проблем». */
  summary: string;
}

/**
 * The lots of a Збірник as the sidebar lists them: worst first (red, yellow,
 * green), then by name. Notes never count — only problems and «перевірити».
 */
export function lotRows(o: Pick<FclOverview, "lots" | "all_discrepancies">): LotRow[] {
  const rank: Record<Light, number> = { err: 0, warn: 1, ok: 2 };
  return o.lots
    .map((l) => {
      const f = lotFindings(l.name, o.all_discrepancies);
      const riskProblems = l.risks.error + l.risks.warning;
      const text = summaryText({ problems: f.problems + riskProblems, toCheck: f.toCheck, notes: 0 });
      return {
        id: l.id,
        name: l.name,
        consignee: l.consignee,
        light: lotLight(l, f),
        docs: `${l.completeness.done}/${l.completeness.total}`,
        summary: text || "без проблем",
      };
    })
    .sort((a, b) => rank[a.light] - rank[b.light] || a.name.localeCompare(b.name, "uk"));
}
