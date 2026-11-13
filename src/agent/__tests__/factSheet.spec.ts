import { describe, expect, it } from 'vitest';
import { buildFactBlock, buildFactSheet, currentVersions, renderFactSheet, type FactDoc } from '../factSheet.js';

// Fictional, anonymised values only (the repo is public).
const invoice = (over: Partial<FactDoc> = {}, fields: Record<string, unknown> = {}): FactDoc => ({
  name: 'invoice.pdf',
  version: 1,
  createdAt: '2026-01-10T10:00:00Z',
  fields: {
    doc_type: 'invoice',
    seller: 'Fictiva Chemicals GmbH',
    buyer: 'TOV Zoriana Trade',
    invoice_number: 'FC-104',
    document_date: '2026-01-05',
    total_value: 12000,
    currency: 'EUR',
    incoterm: 'FCA Hamburg',
    country_of_origin: 'DE',
    net_weight_kg: 500,
    ...fields,
  },
  ...over,
});
const pl = (over: Partial<FactDoc> = {}, fields: Record<string, unknown> = {}): FactDoc => ({
  name: 'packing-list.pdf',
  version: 1,
  createdAt: '2026-01-10T11:00:00Z',
  fields: { doc_type: 'packing_list', net_weight_kg: 500, gross_weight_kg: 540, packages_count: 20, ...fields },
  ...over,
});

const line = (sheet: ReturnType<typeof buildFactSheet>, label: string): string =>
  renderFactSheet(sheet, 5000).find((l) => l.startsWith(`${label}:`)) ?? '';

describe('fact sheet: authoritative value', () => {
  it('shows the value with its source file', () => {
    expect(line(buildFactSheet([invoice(), pl()]), 'вага брутто')).toBe('вага брутто: 540 кг (packing-list.pdf)');
  });

  it('the newest version of a document wins, the older one is not a source or a conflict', () => {
    const v1 = pl({ name: 'packing-list.pdf', version: 1 }, { gross_weight_kg: 540 });
    const v2 = pl({ name: 'packing-list (1).pdf', version: 2 }, { gross_weight_kg: 560 });
    expect(currentVersions([v1, v2])).toEqual([v2]);
    expect(line(buildFactSheet([invoice(), v1, v2]), 'вага брутто')).toBe('вага брутто: 560 кг (packing-list (1).pdf, дублікат)');
  });

  it('an original beats a draft: the draft is not a weight source at all', () => {
    const draft = pl({ name: 'packing-list-draft.pdf' }, { gross_weight_kg: 999 });
    const orig = pl({ name: 'packing-list-final.pdf' }, { gross_weight_kg: 540 });
    expect(line(buildFactSheet([draft, orig]), 'вага брутто')).toBe('вага брутто: 540 кг (packing-list-final.pdf)');
  });

  it('a translation is a weaker source than the original', () => {
    const tr = invoice({ name: 'invoice_переклад.pdf' }, { seller: 'Fictiva Chemicals' });
    expect(line(buildFactSheet([tr, invoice()]), 'продавець')).toContain('продавець: Fictiva Chemicals GmbH (invoice.pdf)');
  });
});

describe('fact sheet: conflicts', () => {
  it('lists differing values as «конфлікт: X (файл A) vs Y (файл B)» and decides nothing', () => {
    const l = line(buildFactSheet([invoice({}, { net_weight_kg: 480 }), pl()]), 'вага нетто');
    expect(l).toBe('вага нетто: 500 кг (packing-list.pdf); конфлікт: 500 кг (packing-list.pdf) vs 480 кг (invoice.pdf)');
  });

  it('the same value spelled differently is not a conflict (Incoterms place, case)', () => {
    const c = invoice({ name: 'contract.pdf' }, { doc_type: 'contract', incoterm: 'fca hamburg port', seller: 'FICTIVA CHEMICALS GMBH' });
    const s = buildFactSheet([invoice(), c]);
    expect(line(s, 'Incoterms')).not.toContain('конфлікт');
    expect(line(s, 'продавець')).not.toContain('конфлікт');
  });

  it('a different Incoterms rule is a conflict', () => {
    const c = invoice({ name: 'contract.pdf' }, { doc_type: 'contract', incoterm: 'DAP Kyiv' });
    expect(line(buildFactSheet([invoice(), c]), 'Incoterms')).toContain('конфлікт');
  });

  it('shows the page when the extraction has it', () => {
    const d = invoice({}, { field_pages: { seller: 2 } });
    expect(line(buildFactSheet([d]), 'продавець')).toBe('продавець: Fictiva Chemicals GmbH (invoice.pdf, стор. 2)');
  });
});

describe('fact sheet: missing facts', () => {
  it('lists «немає даних» for key facts no document gives', () => {
    const lines = renderFactSheet(buildFactSheet([invoice()]), 5000);
    const missing = lines.find((l) => l.startsWith('немає даних:')) ?? '';
    expect(missing).toContain('вага брутто');
    expect(missing).toContain('кількість місць');
    expect(missing).toContain('№ контракту');
    expect(missing).toContain('№ транспортного документа');
    expect(missing).not.toContain('продавець');
    expect(missing).not.toContain('№ інвойсу');
  });

  it('no «немає даних» line when everything is known', () => {
    const contract: FactDoc = { name: 'contract.pdf', fields: { doc_type: 'contract', contract_number: 'K-1' } };
    const awb: FactDoc = { name: 'awb.pdf', fields: { doc_type: 'transport', transport_doc_kind: 'awb', transport_doc_number: '123-45678901' } };
    const items = [{ name: 'Substance X', hs_code: '2933', quantity: 500, unit: 'kg', batch_no: 'B1' }];
    const lines = renderFactSheet(buildFactSheet([invoice({}, { line_items_brief: items }), pl(), contract, awb]), 5000);
    expect(lines.some((l) => l.startsWith('немає даних'))).toBe(false);
  });
});

describe('fact sheet: documents, containers, goods', () => {
  it('numbers, dates, totals and transport numbers per document', () => {
    const awb: FactDoc = {
      name: 'awb.pdf',
      fields: { doc_type: 'transport', transport_doc_kind: 'awb', transport_doc_number: '123-45678901', document_date: '2026-01-12', container_numbers: ['ABCU1234567'] },
    };
    const lines = renderFactSheet(buildFactSheet([invoice(), awb]), 5000);
    expect(lines).toContain('- інвойс FC-104 від 2026-01-05, 12000 EUR (invoice.pdf)');
    expect(lines).toContain('- AWB 123-45678901 від 2026-01-12 (awb.pdf)');
    expect(lines).toContain('контейнери: ABCU1234567 (awb.pdf)');
  });

  it('goods lines with HS, quantity + unit, batch', () => {
    const items = [{ name: 'Substance X', hs_code: '2933', quantity: 500, unit: 'kg', batch_no: 'B1' }];
    const lines = renderFactSheet(buildFactSheet([invoice({}, { line_items_brief: items, line_items_count: 1 })]), 5000);
    expect(lines).toContain('1) Substance X; HS 2933; 500 kg; партія B1');
  });
});

describe('fact sheet: Incoterms in / out', () => {
  it('trilateral: both declared terms are shown, differing document terms are not a conflict', () => {
    const contract = invoice({ name: 'contract.pdf' }, { doc_type: 'contract', incoterm: 'CPT Kyiv' });
    const lines = renderFactSheet(buildFactSheet([invoice(), contract], { incotermIn: 'FCA', incotermOut: 'CPT' }), 5000);
    expect(lines).toContain('Incoterms: вхідні FCA, вихідні CPT (картка поставки; трьохсторонній)');
    const docs = lines.find((l) => l.startsWith('Incoterms у документах:')) ?? '';
    expect(docs).toContain('CPT Kyiv (contract.pdf)');
    expect(docs).toContain('FCA Hamburg (invoice.pdf)');
    expect(lines.some((l) => l.includes('конфлікт') && l.startsWith('Incoterms'))).toBe(false);
  });

  it('bilateral: the card term is a candidate, a mismatch shows as conflict', () => {
    const l = line(buildFactSheet([invoice()], { incotermIn: 'DAP' }), 'Incoterms');
    expect(l).toBe('Incoterms: FCA Hamburg (invoice.pdf); конфлікт: FCA Hamburg (invoice.pdf) vs DAP (картка поставки)');
  });
});

describe('fact sheet: budget', () => {
  it('long lists go first; parties, conflicts and «немає даних» stay', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ name: `Substance number ${i} with a long trade name`, hs_code: '2933', quantity: 10, unit: 'kg', batch_no: `B${i}` }));
    const sheet = buildFactSheet([invoice({}, { line_items_brief: items, line_items_count: 30, net_weight_kg: 480 }), pl()]);
    const full = renderFactSheet(buildFactSheet([invoice({}, { line_items_brief: items, line_items_count: 30, net_weight_kg: 480 }), pl()]), 100000);
    const small = renderFactSheet(sheet, 600);
    expect(full.join('\n').length).toBeGreaterThan(600);
    expect(small.join('\n').length).toBeLessThanOrEqual(600);
    expect(small.some((l) => l.startsWith('продавець:'))).toBe(true);
    expect(small.some((l) => l.includes('конфлікт'))).toBe(true);
    expect(small.some((l) => l.startsWith('немає даних:'))).toBe(true);
  });

  it('the whole block respects maxChars', () => {
    const many = Array.from({ length: 40 }, (_, i) => invoice({ name: `inv-${i}.pdf` }, { invoice_number: `N-${i}`, seller: `Fictiva ${i}` }));
    expect(buildFactBlock(many, {}, 2000).length).toBeLessThanOrEqual(2000);
  });
});

describe('fact sheet: FCL grouping', () => {
  it('facts are grouped per lot, files outside a lot go under «Без партії»', () => {
    const a = invoice({ name: 'a-invoice.pdf', lotId: 'L1' }, { seller: 'Fictiva One Ltd' });
    const b = invoice({ name: 'b-invoice.pdf', lotId: 'L2' }, { seller: 'Fictiva Two Ltd' });
    const c = invoice({ name: 'c-misc.pdf', lotId: null }, { seller: 'Fictiva Loose Ltd' });
    const block = buildFactBlock([a, b, c], {}, 5000, [
      { id: 'L1', name: 'Партія 1', supplier: 'Fictiva One Ltd', incotermIn: 'FCA', incotermOut: 'CPT' },
      { id: 'L2', name: 'Партія 2' },
    ]);
    const i1 = block.indexOf('[Партія «Партія 1»');
    const i2 = block.indexOf('[Партія «Партія 2»');
    const i3 = block.indexOf('[Без партії]');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(block.slice(i1, i2)).toContain('продавець: Fictiva One Ltd (a-invoice.pdf)');
    expect(block.slice(i1, i2)).toContain('вхідні FCA, вихідні CPT');
    expect(block.slice(i1, i2)).not.toContain('Fictiva Two');
    expect(block.slice(i2, i3)).toContain('продавець: Fictiva Two Ltd (b-invoice.pdf)');
    expect(block.slice(i3)).toContain('продавець: Fictiva Loose Ltd (c-misc.pdf)');
  });
});

describe('fact sheet: no false conflicts', () => {
  const countryLine = (a: string, b: string): string =>
    line(
      buildFactSheet([invoice({}, { country_of_origin: a }), invoice({ name: 'coo.pdf' }, { doc_type: 'certificate_of_origin', country_of_origin: b })]),
      'країна походження',
    );

  it('same company spelled differently is not a conflict', () => {
    const second = invoice({ name: 'contract.pdf' }, { doc_type: 'contract', seller: 'Fictiva Chemicals GmbH.', buyer: 'ТОВ Zoriana Trade' });
    const s = buildFactSheet([invoice({}, { buyer: 'Zoriana Trade LLC' }), second]);
    expect(line(s, 'продавець')).not.toContain('конфлікт');
  });

  it('country names are normalised (China / CN / P.R. China / КНР)', () => {
    for (const [a, b] of [['China', 'CN'], ['P.R. China', 'КНР'], ['PRC', 'Китай'], ['India', 'Індія'], ['Ukraine', 'UA'], ['Germany', 'Німеччина']]) {
      expect(countryLine(a!, b!), `${a} / ${b}`).not.toContain('конфлікт');
    }
    expect(countryLine('China', 'India')).toContain('конфлікт');
  });

  it('two invoice legs with different seller / buyer pairs are not a conflict', () => {
    const leg1 = invoice({ name: 'inv-supplier.pdf' }, { seller: 'Fictiva Chemicals GmbH', buyer: 'Prime Force UK Ltd', incoterm: 'FCA Hamburg' });
    const leg2 = invoice({ name: 'inv-consignee.pdf' }, { seller: 'Prime Force UK Ltd', buyer: 'TOV Zoriana Trade', incoterm: 'DAP Kyiv' });
    const s = buildFactSheet([leg1, leg2]);
    for (const l of ['продавець', 'покупець', 'Incoterms']) expect(line(s, l), l).not.toContain('конфлікт');
  });

  it('within one leg a different seller / Incoterms rule is still a conflict', () => {
    const a = invoice({ name: 'inv-a.pdf' });
    const b = invoice({ name: 'contract.pdf' }, { doc_type: 'contract', seller: 'Other Seller SA' });
    expect(line(buildFactSheet([a, b]), 'продавець')).toContain('конфлікт');
    const c = invoice({ name: 'contract.pdf' }, { doc_type: 'contract', incoterm: 'DAP Kyiv' });
    expect(line(buildFactSheet([a, c]), 'Incoterms')).toContain('конфлікт');
  });

  it('weights come only from invoice / packing list / transport / МД, within 0.5 % or 1 kg', () => {
    const coa = invoice({ name: 'coa.pdf' }, { doc_type: 'quality_certificate', net_weight_kg: 123 });
    expect(line(buildFactSheet([pl(), coa]), 'вага нетто')).toBe('вага нетто: 500 кг (packing-list.pdf)');
    expect(line(buildFactSheet([pl(), invoice({}, { net_weight_kg: 500.8 })]), 'вага нетто')).not.toContain('конфлікт');
    expect(line(buildFactSheet([pl({}, { net_weight_kg: 50000 }), invoice({}, { net_weight_kg: 50200 })]), 'вага нетто')).not.toContain('конфлікт');
    expect(line(buildFactSheet([pl(), invoice({}, { net_weight_kg: 510 })]), 'вага нетто')).toContain('конфлікт');
  });

  it('drafts, copies and superseded originals of a revised file give no weight', () => {
    const docx = pl({ name: 'packing-list.docx' }, { gross_weight_kg: 700 });
    const copy = pl({ name: 'packing-list-2.pdf', head: 'PACKING LIST\nCOPY' }, { gross_weight_kg: 800 });
    const old = pl({ name: 'packing list.pdf' }, { gross_weight_kg: 600 });
    const revised = pl({ name: 'packing list revised.pdf' }, { gross_weight_kg: 540 });
    expect(line(buildFactSheet([docx, copy, old, revised]), 'вага брутто')).toBe('вага брутто: 540 кг (packing list revised.pdf)');
  });

  it('weakness sees «COPY» in the document head, and revised outranks the plain name', () => {
    const copy = invoice({ name: 'inv-a.pdf', head: 'COMMERCIAL INVOICE  COPY' }, { seller: 'Fictiva Chemicals' });
    const orig = invoice({ name: 'inv-b.pdf' });
    expect(line(buildFactSheet([copy, orig]), 'продавець')).toContain('продавець: Fictiva Chemicals GmbH (inv-b.pdf)');
    const plain = invoice({ name: 'inv.pdf' }, { seller: 'Fictiva A' });
    const rev = invoice({ name: 'inv revised.pdf' }, { seller: 'Fictiva B' });
    expect(line(buildFactSheet([plain, rev]), 'продавець')).toContain('продавець: Fictiva B (inv revised.pdf');
  });

  it('currentVersions keeps «Invoice.pdf» and «Invoice (1).pdf» apart when their parties differ', () => {
    const a = invoice({ name: 'Invoice.pdf', version: 1 });
    const b = invoice({ name: 'Invoice (1).pdf', version: 2 }, { seller: 'Prime Force UK Ltd', buyer: 'TOV Zoriana Trade' });
    expect(currentVersions([a, b])).toEqual([a, b]);
    const c = invoice({ name: 'Invoice (1).pdf', version: 2 });
    expect(currentVersions([a, c])).toEqual([c]);
  });
});
