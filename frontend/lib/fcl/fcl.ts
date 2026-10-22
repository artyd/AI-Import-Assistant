import type { FclOverview, LotStatus, LotSummary, ManifestMatch } from "@/lib/types";

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

/** Red on a confirmed discrepancy or a critical risk, yellow on gaps or suspicions. */
export function lotLight(l: Pick<LotSummary, "completeness" | "discrepancies" | "risks">): Light {
  if (l.discrepancies.confirmed > 0 || l.risks.error > 0) return "err";
  if (l.completeness.done < l.completeness.total || l.discrepancies.suspected > 0 || l.risks.warning > 0) return "warn";
  return "ok";
}

export const LIGHT_COLOR: Record<Light, string> = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)" };

/** Header numbers of the whole FCL. */
export function fclCounts(o: Pick<FclOverview, "risks" | "all_discrepancies">) {
  return {
    risksError: o.risks.filter((r) => r.severity === "error").length,
    risksWarning: o.risks.filter((r) => r.severity === "warning").length,
    confirmed: o.all_discrepancies.filter((d) => d.kind === "confirmed").length,
    suspected: o.all_discrepancies.filter((d) => d.kind !== "confirmed").length,
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
