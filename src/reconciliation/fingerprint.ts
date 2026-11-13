import { createHash } from 'node:crypto';
import type { Discrepancy } from './reconcile.js';
import type { Risk } from './risks.js';

/**
 * Finding fingerprints and triage decoration (spec 011). Pure, no I/O.
 *
 * A fingerprint is a stable id of a finding: the same finding on the same
 * evidence gives the same id across recomputes; changed evidence (another file
 * or value) gives a new one, so a decided finding comes back.
 *
 *   discrepancy: sha1( 'd' | field | lot | sorted('file_id=value' of each citation) )
 *   risk:        sha1( 'r' | code  | lot | source_file_id | title )
 *
 * Display texts (expected / actual / detail) are NOT part of it: a reworded
 * message keeps the decision. `lot` is the lot name in an FCL, else empty.
 */

export type TriageStatus = 'not_problem' | 'resolved';
export type TriageReason = 'legs' | 'version' | 'lots' | 'agreed' | 'other';

export const REASON_LABELS: Record<TriageReason, string> = {
  legs: 'Різні плечі угоди',
  version: 'Інша версія / копія',
  lots: 'Різні партії / товари',
  agreed: 'Погоджено з брокером / митницею',
  other: 'Інше',
};

export const STATUS_LABELS: Record<TriageStatus, string> = { not_problem: 'Не проблема', resolved: 'Вирішено' };

/** The decision as the API shows it on a finding. */
export interface FindingTriage {
  status: TriageStatus;
  reason: TriageReason | null;
  note: string;
  user_name: string;
  decided_at: string;
}

/** A stored decision (`finding_triage` joined with the user's name). */
export interface TriageRow extends FindingTriage {
  fingerprint: string;
  title: string;
  lot: string | null;
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

export function findingFingerprint(d: Pick<Discrepancy, 'field' | 'citations'> & { lot?: string | null }): string {
  const cites = d.citations.map((c) => `${c.file_id ?? ''}=${c.value}`).sort();
  return sha1(['d', d.field, d.lot ?? '', cites.join(';')].join('|'));
}

export function riskFingerprint(r: Pick<Risk, 'code' | 'source_file_id' | 'title'> & { lot?: string | null }): string {
  return sha1(['r', r.code, r.lot ?? '', r.source_file_id ?? '', r.title].join('|'));
}

export function toFindingTriage(row: TriageRow): FindingTriage {
  return { status: row.status, reason: row.reason, note: row.note, user_name: row.user_name, decided_at: row.decided_at };
}

/**
 * Sets `fingerprint` on every discrepancy and risk and `triage` on the decided
 * ones (in place). A risk built from a triaged discrepancy
 * (`discrepancy_<field>`, same first-cited file) inherits its decision.
 */
export function decorateFindings(
  discrepancies: Discrepancy[],
  risks: Risk[],
  rows: readonly TriageRow[] | undefined,
  lot?: string | null,
): void {
  const byFp = new Map((rows ?? []).map((r) => [r.fingerprint, r]));
  // A risk built from a discrepancy (`discrepancy_<field>`, source = its first
  // citation) IS that discrepancy: it shares its fingerprint, so deciding it from
  // the risks list decides the discrepancy too (status, counts and the agent).
  const fromDiscrepancy = new Map<string, Discrepancy>();
  for (const d of discrepancies) {
    d.fingerprint = findingFingerprint({ field: d.field, citations: d.citations, lot });
    const row = byFp.get(d.fingerprint);
    if (row) d.triage = toFindingTriage(row);
    const key = `discrepancy_${d.field}|${d.citations[0]?.file_id ?? ''}`;
    if (!fromDiscrepancy.has(key)) fromDiscrepancy.set(key, d);
  }
  for (const r of risks) {
    const d = r.category === 'discrepancy' ? fromDiscrepancy.get(`${r.code}|${r.source_file_id ?? ''}`) : undefined;
    if (d?.fingerprint) {
      r.fingerprint = d.fingerprint;
      if (d.triage) r.triage = d.triage;
      continue;
    }
    r.fingerprint = riskFingerprint({ code: r.code, source_file_id: r.source_file_id, title: r.title, lot });
    const row = byFp.get(r.fingerprint);
    if (row) r.triage = toFindingTriage(row);
  }
}
