import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), pool: {} }));
vi.mock('../../db/pool.js', () => db);
vi.mock('../../lib/config.js', () => ({ config: {} }));

const { findingFingerprint, riskFingerprint, decorateFindings } = await import('../fingerprint.js');
const { loadTriage, upsertTriage, deleteTriage } = await import('../triage.js');
const { computeVerdicts, deriveWorkspaceStatus } = await import('../verdicts.js');
const { computeFclLevel } = await import('../fcl.js');
const { renderProblemsReport, collectProblems } = await import('../problemsReport.js');
const { decidedBlock } = await import('../../agent/tools/shared.js');
import type { TriageRow } from '../fingerprint.js';

const cite = (file_id: string | null, value: string, file_name = `${file_id}.pdf`) => ({ file_id, file_name, doc_type: 'invoice', value });
const disc = (over = {}) => ({
  field: 'gross_weight_kg', expected: '100', actual: '120', severity: 'error' as const, kind: 'confirmed' as const,
  citations: [cite('f1', '100'), cite('f2', '120')], ...over,
});
const triageRow = (fingerprint: string, over: Partial<TriageRow> = {}): TriageRow => ({
  fingerprint, status: 'not_problem', reason: 'legs', note: '', title: 't', lot: null, user_name: 'Артем', decided_at: '2026-11-13T10:00:00.000Z', ...over,
});

describe('fingerprints', () => {
  it('are 40-char sha1 hex', () => {
    expect(findingFingerprint(disc())).toMatch(/^[0-9a-f]{40}$/);
    expect(riskFingerprint({ code: 'c', source_file_id: null, title: 't' })).toMatch(/^[0-9a-f]{40}$/);
  });

  it('stable across reordered citations and reworded expected/actual', () => {
    const a = findingFingerprint(disc());
    expect(findingFingerprint(disc({ citations: [cite('f2', '120'), cite('f1', '100')] }))).toBe(a);
    expect(findingFingerprint({ ...disc(), expected: 'sto', actual: 'sto dvadtsat' } as never)).toBe(a);
    expect(findingFingerprint(disc({ citations: [cite('f1', '100', 'renamed.pdf'), cite('f2', '120')] }))).toBe(a);
  });

  it('changes when a cited value, a cited file, the field or the lot changes', () => {
    const a = findingFingerprint(disc());
    expect(findingFingerprint(disc({ citations: [cite('f1', '100'), cite('f2', '121')] }))).not.toBe(a);
    expect(findingFingerprint(disc({ citations: [cite('f1', '100'), cite('f3', '120')] }))).not.toBe(a);
    expect(findingFingerprint(disc({ field: 'net_weight_kg' }))).not.toBe(a);
    expect(findingFingerprint({ ...disc(), lot: 'Hebei' })).not.toBe(a);
  });

  it('a risk: code, source file, title and lot; not the detail', () => {
    const r = { code: 'cert_expired', source_file_id: 'f1', title: 'Сертифікат прострочено' };
    const a = riskFingerprint(r);
    expect(riskFingerprint({ ...r, detail: 'other' } as never)).toBe(a);
    expect(riskFingerprint({ ...r, source_file_id: 'f2' })).not.toBe(a);
    expect(riskFingerprint({ ...r, title: 'Інше' })).not.toBe(a);
    expect(riskFingerprint({ ...r, lot: 'L' })).not.toBe(a);
  });
});

describe('decorateFindings', () => {
  it('sets fingerprint on all and triage on the decided; a derived risk inherits', () => {
    const d = disc() as never;
    const derived = { code: 'discrepancy_gross_weight_kg', category: 'discrepancy', severity: 'error', title: 'Розбіжність', detail: 'x', source_file_id: 'f1' } as never;
    const other = { code: 'docs_missing', category: 'missing_docs', severity: 'warning', title: 'Бракує', detail: 'x', source_file_id: null } as never;
    decorateFindings([d], [derived, other], [triageRow(findingFingerprint(disc()))]);
    expect((d as { triage?: unknown }).triage).toMatchObject({ status: 'not_problem', user_name: 'Артем' });
    expect((derived as { triage?: unknown }).triage).toBeDefined();
    expect((other as { triage?: unknown }).triage).toBeUndefined();
    expect((other as { fingerprint?: string }).fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a risk built from a discrepancy shares its fingerprint, so deciding it from the risks list decides the discrepancy', () => {
    const d = disc() as never;
    const derived = { code: 'discrepancy_gross_weight_kg', category: 'discrepancy', severity: 'error', title: 'Розбіжність', detail: 'x', source_file_id: 'f1' } as never;
    decorateFindings([d], [derived], []);
    const fp = (d as { fingerprint: string }).fingerprint;
    expect((derived as { fingerprint: string }).fingerprint).toBe(fp);
    // The sidebar decides the risk row (its fingerprint) → the discrepancy is decided.
    const d2 = disc() as never;
    const r2 = { ...(derived as object) } as never;
    decorateFindings([d2], [r2], [triageRow(fp)]);
    expect((d2 as { triage?: unknown }).triage).toBeDefined();
    expect((r2 as { triage?: unknown }).triage).toBeDefined();
  });
});

describe('triage store', () => {
  beforeEach(() => db.query.mockReset());

  it('loadTriage maps rows (Date → ISO, null name → empty)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ fingerprint: 'x', status: 'resolved', reason: null, note: '', title: 't', lot: null, user_name: null, decided_at: new Date('2026-11-13T10:00:00Z') }] });
    expect(await loadTriage('ws')).toEqual([triageRow('x', { status: 'resolved', reason: null, user_name: '', title: 't' })]);
    expect(db.query.mock.calls[0]![1]).toEqual(['ws']);
  });

  it('upsertTriage writes then reads back with the user name; reason only for not_problem', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ fingerprint: 'x', status: 'resolved', reason: null, note: 'n', title: 't', lot: 'L', user_name: 'Артем', decided_at: '2026-11-13T10:00:00.000Z' }] });
    const row = await upsertTriage('ws', 'u1', 'x', { status: 'resolved', reason: 'legs', note: 'n', title: 't', lot: 'L' });
    expect(row.user_name).toBe('Артем');
    expect(db.query.mock.calls[0]![0]).toContain('ON CONFLICT (workspace_id, fingerprint)');
    expect(db.query.mock.calls[0]![1]).toEqual(['ws', 'x', 'resolved', null, 'n', 't', 'L', 'u1']);
  });

  it('deleteTriage reports whether a row was removed', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    expect(await deleteTriage('ws', 'x')).toBe(true);
    expect(await deleteTriage('ws', 'x')).toBe(false);
  });
});

describe('verdict integration', () => {
  const ws = {
    id: 'ws1', owner_id: 'u1', number: '1', supplier: 'S', status: 'docs_in_progress', created_at: '',
    contract_type: 'bilateral', intake_complete: true, product_category: null, incoterm: null,
    incoterm_in: null, incoterm_out: null, transport_mode: null, origin_country: null,
    destination_country: null, responsible_user_id: null, contract_type_source: null,
    contract_type_confidence: null, contract_type_reason: null, auto_context_fields: [],
    survey_answers: null, survey_status: 'not_started',
  };
  const seller = 'Fictiva Chemicals GmbH';
  const bank = (iban: string) => ({ iban, swift: 'TESTDEFF', bank_name: 'Testbank AG', beneficiary: seller });
  const f = (id: string, fields: Record<string, unknown>) => ({ file_id: id, file_name: `${id}.pdf`, folder_name: null, fields });
  const snap = (triage?: TriageRow[]) =>
    ({
      ws, required: ['invoice', 'packing_list'], intermediary: null, approvedInstruction: null, registry: [], triage,
      files: [
        f('adv', { doc_type: 'invoice', seller, buyer: 'B', currency: 'EUR', total_value: 300, bank_accounts: [bank('DE12500105170000062011')] }),
        f('inv', { doc_type: 'invoice', seller, buyer: 'B', currency: 'EUR', total_value: 1000, bank_accounts: [bank('DE12500105170000082011')] }),
        f('pl', { doc_type: 'packing_list' }),
      ],
    }) as never;
  const NOW = Date.parse('2026-10-19T12:00:00Z');

  it('an error finding blocks the status; decided, it no longer does — and everything is fingerprinted', () => {
    const open = computeVerdicts(snap(), NOW);
    const bankD = open.discrepancies.find((d) => d.field === 'bank_account')!;
    expect(bankD.severity).toBe('error');
    expect(open.derivedStatus).toBe('docs_in_progress');
    expect(open.discrepancies.every((d) => /^[0-9a-f]{40}$/.test(d.fingerprint ?? ''))).toBe(true);
    expect(open.risks.every((r) => /^[0-9a-f]{40}$/.test(r.fingerprint ?? ''))).toBe(true);
    expect(open.discrepancies.some((d) => d.triage)).toBe(false);

    const rows = open.discrepancies.filter((d) => d.severity === 'error').map((d) => triageRow(d.fingerprint!));
    const decided = computeVerdicts(snap(rows), NOW);
    expect(decided.discrepancies.find((d) => d.field === 'bank_account')!.triage).toMatchObject({ status: 'not_problem' });
    expect(decided.risks.find((r) => r.code === 'discrepancy_bank_account')!.triage).toBeDefined();
    expect(decided.derivedStatus).not.toBe('docs_in_progress');
    // the finding stays in the list
    expect(decided.discrepancies).toHaveLength(open.discrepancies.length);
  });

  it('changed evidence brings the finding back', () => {
    const open = computeVerdicts(snap(), NOW);
    const rows = open.discrepancies.filter((d) => d.severity === 'error').map((d) => triageRow(d.fingerprint!));
    const changed = snap(rows) as unknown as { files: { fields: { bank_accounts: { iban: string }[] } }[] };
    changed.files[1]!.fields.bank_accounts[0]!.iban = 'DE12500105170000099999';
    const again = computeVerdicts(changed as never, NOW);
    expect(again.discrepancies.find((d) => d.field === 'bank_account')!.triage).toBeUndefined();
    expect(again.derivedStatus).toBe('docs_in_progress');
  });

  it('deriveWorkspaceStatus ignores triaged errors only', () => {
    const triage = { status: 'resolved', reason: null, note: '', user_name: 'A', decided_at: '' } as const;
    const checklist = [{ requirement_key: 'invoice', status: 'received', source_file_id: null }] as never;
    expect(deriveWorkspaceStatus({ intake_complete: true }, checklist, [disc({ triage }), disc()] as never)).toBe('docs_in_progress');
    expect(deriveWorkspaceStatus({ intake_complete: true }, checklist, [disc({ triage })] as never)).toBe('docs_complete');
  });

  it('a lot name goes into the fingerprint', () => {
    const plain = computeVerdicts(snap(), NOW).discrepancies.find((d) => d.field === 'bank_account')!;
    const lot = computeVerdicts({ ...(snap() as object), lotName: 'Hebei' } as never, NOW).discrepancies.find((d) => d.field === 'bank_account')!;
    expect(lot.fingerprint).not.toBe(plain.fingerprint);
  });
});

describe('FCL findings', () => {
  const file = (id: string, fields: Record<string, unknown>, extra = {}) => ({ file_id: id, file_name: `${id}.pdf`, file_type: 'pdf', folder_name: '02_Транспорт', lot_id: null, fields, ...extra });
  const lots = [{ id: 'L1', name: 'Shandong', supplier_name: 'Shandong Co', consignee: 'НОВАЛАЙТ', derivedStatus: 'docs_complete' as const }];
  const mbl = file('m', { doc_type: 'transport', transport_doc_kind: 'mbl', container_numbers: ['ECMU4794246'], gross_weight_kg: 10000, place_of_discharge: 'Gdansk, Poland' });
  const hbl = file('a', { doc_type: 'transport', transport_doc_kind: 'hbl', consignor_name: 'SHANDONG CO', container_numbers: ['MSCU1234567'], gross_weight_kg: 10000 });
  const base = { transport_mode: 'sea', eu_transit: null, consignee: null, lots, files: [mbl, hbl] };

  it('FCL-level findings carry fingerprints; decided, they leave the error risks and status', () => {
    const open = computeFclLevel(base);
    const err = open.discrepancies.find((d) => d.field === 'container_numbers')!;
    expect(err.severity).toBe('error');
    expect(err.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(open.levelStatus).toBe('docs_in_progress');
    expect(open.risks.some((r) => r.code === 'fcl_discrepancy_container_numbers')).toBe(true);
    expect(open.risks.every((r) => r.fingerprint)).toBe(true);

    const rows = open.discrepancies.filter((d) => d.severity === 'error').map((d) => triageRow(d.fingerprint!));
    const decided = computeFclLevel({ ...base, triage: rows });
    expect(decided.discrepancies.find((d) => d.field === 'container_numbers')!.triage).toBeDefined();
    expect(decided.risks.some((r) => r.code.startsWith('fcl_discrepancy_'))).toBe(false);
  });

  it('a lot finding carries the lot name in its fingerprint and the decision', () => {
    const ws = { id: 'w', kind: 'fcl', contract_type: 'bilateral', intake_complete: true, number: '18', auto_context_fields: [] };
    const seller = 'Fictiva';
    const bank = (iban: string) => ({ iban, swift: 'X', bank_name: 'B', beneficiary: seller });
    const files = [
      { file_id: 'a', file_name: 'a.pdf', folder_name: null, fields: { doc_type: 'invoice', seller, currency: 'EUR', total_value: 1, bank_accounts: [bank('DE12500105170000062011')] } },
      { file_id: 'b', file_name: 'b.pdf', folder_name: null, fields: { doc_type: 'invoice', seller, currency: 'EUR', total_value: 2, bank_accounts: [bank('DE12500105170000082011')] } },
    ];
    const snapshot = { ws, required: ['invoice'], files, intermediary: null, approvedInstruction: null, registry: [] };
    const a = computeVerdicts({ ...snapshot, lotName: 'Shandong' } as never);
    const d = a.discrepancies.find((x) => x.field === 'bank_account')!;
    expect(d.fingerprint).toBe(findingFingerprint({ field: d.field, citations: d.citations, lot: 'Shandong' }));
    const b = computeVerdicts({ ...snapshot, lotName: 'Shandong', triage: [triageRow(d.fingerprint!, { lot: 'Shandong' })] } as never);
    expect(b.discrepancies.find((x) => x.field === 'bank_account')!.triage).toBeDefined();
    expect(b.derivedStatus).not.toBe('docs_in_progress');
  });
});

describe('problems report', () => {
  const decided = { status: 'not_problem', reason: 'agreed', note: '<b>домовились</b>', user_name: 'Арт<em>ем', decided_at: '2026-11-13T10:00:00.000Z' } as const;

  it('escapes every text and uses human labels, no raw keys', () => {
    const html = renderProblemsReport({
      number: '7<script>', fcl: false, generatedAt: new Date('2026-11-13T10:00:00Z'),
      entries: collectProblems(
        [
          disc({ expected: '<img src=x>', citations: [cite('f1', '1', 'a&b.pdf')] }) as never,
          disc({ field: 'net_weight_kg', kind: 'suspected', severity: 'warning', triage: undefined }) as never,
          disc({ field: 'bank_account', triage: decided }) as never,
        ],
        [],
        null,
      ),
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>домовились');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('a&amp;b.pdf');
    expect(html).toContain('Відкриті проблеми');
    expect(html).toContain('перевірити');
    expect(html).toContain('Не проблема');
    expect(html).toContain('Погоджено з брокером / митницею');
    expect(html).toContain('Приміток до рішень: <b>1</b>');
    expect(html).not.toContain('gross_weight_kg');
    expect(html).not.toContain('bank_account');
  });

  it('an FCL groups by lot; a risk that repeats a discrepancy is not listed twice', () => {
    const entries = [
      ...collectProblems([disc() as never], [{ code: 'discrepancy_gross_weight_kg', category: 'discrepancy', severity: 'error', title: 'Розбіжність: вага', detail: '', source_file_id: null } as never], 'Hebei'),
      ...collectProblems([], [{ code: 'fcl_unassigned_files', category: 'missing_docs', severity: 'warning', title: 'Файли без партії: 2', detail: 'd', source_file_id: null } as never], null),
    ];
    const html = renderProblemsReport({ number: '18', fcl: true, generatedAt: new Date(), entries });
    expect(html).toContain('<h3>Hebei</h3>');
    expect(html).toContain('<h3>Збірник (рівень контейнера)</h3>');
    expect(entries.filter((e) => e.lot === 'Hebei')).toHaveLength(1);
  });
});

describe('agent: decided findings are listed apart', () => {
  it('«Розібрано користувачем:» with status, reason and note; nothing when none', () => {
    const t = { status: 'not_problem', reason: 'legs', note: 'ок', user_name: 'A', decided_at: '' } as const;
    const text = decidedBlock([{ text: 'Вага', triage: t }, { text: 'Банк' }]);
    expect(text).toBe('Розібрано користувачем:\n- Вага — Не проблема, причина: Різні плечі угоди, примітка: ок');
    expect(decidedBlock([{ text: 'Банк' }])).toBe('');
  });
});
