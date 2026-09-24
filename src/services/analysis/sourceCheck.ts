import * as logist from '../logist/index.js';

/**
 * Live per-code cross-check against the official source (qdpro, via logist-mcp),
 * ENRICHING the deterministic manifest analysis — it never changes the CIF/мито/
 * ПДВ calculation. For each manifest line's УКТ ЗЕД code we fetch the import-regime
 * duty rates + restriction flags (deterministic parse, no LLM) so the analysis
 * card can surface real duties and flags the static engine can't: заборона з РФ,
 * ліцензування, ветеринарно-санітарний/фітосанітарний контроль, подвійне
 * використання, наркотичні/прекурсори — plus a duty-rate divergence warning.
 *
 * Best-effort: gated on LOGIST_MCP_URL, tolerates per-code failures, and the
 * caller keeps the full analysis even if every check fails.
 */

export interface SourceCheck {
  dutyPref: string | null; // official pref rate from qdpro, e.g. "0%"
  dutyFull: string | null;
  banRf: boolean;
  license: boolean;
  vetControl: boolean;
  phyto: boolean;
  dualUse: boolean;
  narcotic: boolean;
  // Parsed official pref rate differs from the static rate used in the calc.
  dutyMismatch: boolean;
  source: string;
}

const CONCURRENCY = 4;
const MAX_CODES = 40;

const normCode = (c: string): string => c.replace(/\D/g, '');

function pctToNum(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Fetch import checks for each unique valid (10-digit) code. code→raw result. */
export async function fetchImportChecks(
  codes: (string | null)[],
  onEach?: (done: number, total: number) => void,
): Promise<Map<string, logist.UktzedFlagsResult>> {
  const uniq = [
    ...new Set(codes.filter((c): c is string => !!c).map(normCode).filter((c) => c.length === 10)),
  ].slice(0, MAX_CODES);

  const out = new Map<string, logist.UktzedFlagsResult>();
  let next = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (next < uniq.length) {
      const code = uniq[next++]!;
      try {
        out.set(code, await logist.uktzedFlags(code));
      } catch {
        /* per-code failure tolerated */
      }
      onEach?.(++completed, uniq.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker));
  return out;
}

/** Look up a row's check by its (possibly formatted) code. */
export function lookupCheck(
  checks: Map<string, logist.UktzedFlagsResult>,
  code: string | null,
): logist.UktzedFlagsResult | undefined {
  if (!code) return undefined;
  return checks.get(normCode(code));
}

/** Assemble a per-row SourceCheck from the raw flags + the static duty rate. */
export function toSourceCheck(
  res: logist.UktzedFlagsResult,
  staticDutyRate: number | null,
): SourceCheck {
  // The divergence flag must compare like-for-like: the static calc uses the MFN
  // (full) rate, so compare against qdpro's duty_full — NOT duty_pref. Comparing
  // the preferential rate (e.g. EU-DCFTA 0%) against the MFN rate flagged a
  // "mismatch" on every line that merely HAS a preference (analysis audit #7).
  const fullNum = pctToNum(res.duty_full);
  const dutyMismatch =
    fullNum !== null && staticDutyRate !== null && Math.abs(fullNum - staticDutyRate) > 0.001;
  return {
    dutyPref: res.duty_pref || null,
    dutyFull: res.duty_full || null,
    banRf: res.flags.ban_rf,
    license: res.flags.license,
    vetControl: res.flags.vet_control,
    phyto: res.flags.phyto,
    dualUse: res.flags.dual_use,
    narcotic: res.flags.narcotic,
    dutyMismatch,
    source: res.source,
  };
}
