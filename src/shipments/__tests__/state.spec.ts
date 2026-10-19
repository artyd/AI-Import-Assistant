import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let row: Record<string, unknown> = {};

vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('intake_complete')) calls.push('intake');
    return { rows: [] };
  }),
}));
vi.mock('../workspaceAccess.js', () => ({ getWorkspaceById: vi.fn(async () => ({ ...row })) }));
vi.mock('../autoContext.js', () => ({ autoFillWorkspaceContext: vi.fn(async () => { calls.push('autopilot'); }) }));
vi.mock('../status.js', () => ({
  refreshWorkspaceState: vi.fn(async () => {
    calls.push('verdicts');
    return {
      checklist: [],
      discrepancies: [],
      risks: [{ code: 'cert_expired', category: 'expiry', severity: 'error', title: 'X прострочено', detail: '', source_file_id: null }],
      status: 'docs_in_progress',
    };
  }),
}));
vi.mock('../../notifications/notifications.js', () => ({
  insertNotification: vi.fn(async () => { calls.push('alert'); }),
}));

const { shipmentChanged } = await import('../state.js');

const complete = {
  id: 'ws1', number: '7', status: 'draft', intake_complete: false, responsible_user_id: 'u1',
  contract_type: 'bilateral', product_category: 'api', incoterm_in: 'FCA', incoterm: 'FCA',
  transport_mode: 'air', origin_country: 'Індія',
};

beforeEach(() => {
  calls.length = 0;
  row = { ...complete };
});

describe('shipmentChanged — order of steps per change', () => {
  it.each([
    ['documents', ['autopilot', 'intake', 'verdicts']],
    ['verification', ['autopilot', 'intake', 'verdicts']],
    ['context', ['intake', 'verdicts']],
    ['parties', ['intake', 'verdicts']],
    ['files', ['intake', 'verdicts']],
    ['instruction', ['intake', 'verdicts']],
  ] as const)('%s → %j', async (change, steps) => {
    await shipmentChanged('ws1', change);
    expect(calls).toEqual(steps);
  });

  it('an explicit intake flag is kept', async () => {
    await shipmentChanged('ws1', 'context', { keepIntakeFlag: true });
    expect(calls).toEqual(['verdicts']);
  });

  it('no intake write when the flag already matches', async () => {
    row = { ...complete, intake_complete: true };
    await shipmentChanged('ws1', 'files');
    expect(calls).toEqual(['verdicts']);
  });

  it('critical risks alert only when asked', async () => {
    await shipmentChanged('ws1', 'documents', { alertRisks: true });
    expect(calls.at(-1)).toBe('alert');
    calls.length = 0;
    await shipmentChanged('ws1', 'documents');
    expect(calls).not.toContain('alert');
  });

  it('returns the workspace with the advanced status', async () => {
    const res = await shipmentChanged('ws1', 'context');
    expect(res?.workspace.status).toBe('docs_in_progress');
    expect(res?.workspace.intake_complete).toBe(true);
  });
});

/**
 * Pattern guard: every module that writes an input of the shipment verdicts
 * (files, folders, parties, extractions, context) must report it through
 * shipmentChanged. A new writer that forgets it is exactly the bug class this
 * module exists to remove.
 */
describe('every verdict-input writer reports shipmentChanged', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const WRITES = [
    /DELETE FROM files\b/,
    /UPDATE files SET[^`']*\b(folder_id|is_latest)\b/,
    /\bupsertParties\(/,
    /UPDATE document_extractions\b/,
    /\bwriteManualContext\(/,
    /\bsortInbox\(/,
    /\bclassifyAndFile\(/,
    /\bupdateVersion\(/,
  ];
  // Modules that define the writers, or own no shipment verdicts.
  const EXEMPT = new Set([
    'documents/classify.ts', // defines classifyAndFile / sortInbox; callers report
    'shipments/autoContext.ts', // defines writeManualContext; runs inside shipmentChanged
    'reconciliation/parties.ts', // defines upsertParties
    'instruction/store.ts', // defines updateVersion
    'instruction/realign.ts', // parties realign — callers (mode change) report
    'documents/collectionFiles.routes.ts', // collections have no verdicts
    'shipments/collections.routes.ts',
    'ingest/extraction/extractFields.ts', // upsertExtraction — the worker reports
  ]);
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
      else if (p.endsWith('.ts')) files.push(p);
    }
  })(src);

  it.each(files.map((f) => path.relative(src, f).split(path.sep).join('/')).filter((rel) => !EXEMPT.has(rel)))(
    '%s',
    (rel) => {
      const text = fs.readFileSync(path.join(src, rel), 'utf8');
      if (rel.startsWith('db/')) return; // one-off migrations
      const writes = WRITES.some((rx) => rx.test(text));
      if (writes) expect(text, `${rel} writes verdict inputs`).toMatch(/\bshipmentChanged\(/);
    },
  );
});
