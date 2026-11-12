import { describe, expect, it } from 'vitest';
import { extractFigures, findValue, checkFigures, type CorpusDoc } from '../answerCheck.js';

const doc = (file: string, ...pages: (string | [number, string])[]): CorpusDoc => ({
  file,
  pages: pages.map((p, i) => (typeof p === 'string' ? { page: i + 1, text: p } : { page: p[0], text: p[1] })),
});

describe('findValue — normalisation', () => {
  it('treats 1 000,50 = 1000.50 = 1,000.50 as the same amount', () => {
    for (const text of ['Total: 1 000,50 USD', 'Total: 1000.50 USD', 'Total: 1,000.50 USD', 'Total: 1 000,50']) {
      for (const v of ['1 000,50', '1000.50', '1,000.50']) {
        expect(findValue(v, [doc('inv.pdf', text)]).status, `${v} in ${text}`).not.toBe('not_found');
      }
    }
  });

  it('does not match a different amount or a number inside a longer one', () => {
    expect(findValue('1000.50', [doc('a', 'Total 1000.51')]).status).toBe('not_found');
    expect(findValue('25', [doc('a', 'Qty 1250 and 12.25 and 2025-01-01')]).status).toBe('not_found');
    expect(findValue('50', [doc('a', 'Sum 1000.50')]).status).toBe('not_found');
  });

  it('matches trailing-zero variants (1000.5 vs 1000.50)', () => {
    expect(findValue('1000.5', [doc('a', 'Sum 1000.50')]).status).toBe('found');
  });

  it('matches units across languages: «25 кг» vs «25kg»', () => {
    expect(findValue('25 кг', [doc('pl.pdf', 'Net weight: 25kg')]).status).toBe('found');
    expect(findValue('25 kg', [doc('pl.pdf', 'Вага нетто 25 кг')]).status).toBe('found');
  });

  it('reports number_only when the number is there but not next to the unit', () => {
    const r = findValue('25 кг', [doc('pl.pdf', 'Qty | 25 |')]);
    expect(r.status).toBe('number_only');
    expect(r.foundIn[0]).toEqual({ file: 'pl.pdf', page: 1 });
  });

  it('matches HS codes however they are spaced', () => {
    const t = 'HS code 2915.90.00.00 and also 2915 90 00 00 and 2915900000';
    for (const v of ['2915 90 00 00', '2915900000', '2915.90.00.00']) {
      expect(findValue(v, [doc('a', t)]).status).toBe('found');
    }
    expect(findValue('2915900001', [doc('a', t)]).status).toBe('not_found');
  });

  it('matches alphanumeric numbers regardless of case, dashes and spacing', () => {
    expect(findValue('msku 1234567', [doc('a', 'Container MSKU1234567')]).status).toBe('found');
    expect(findValue('inv–2024–001', [doc('a', 'Invoice No. INV-2024-001 dated')]).status).toBe('found');
    expect(findValue('INV-2024-002', [doc('a', 'Invoice No. INV-2024-001')]).status).toBe('not_found');
  });

  it('matches dates across notations', () => {
    expect(findValue('12.03.2025', [doc('a', 'Date: 2025-03-12')]).status).toBe('found');
    expect(findValue('2025-03-12', [doc('a', 'Дата 12/03/2025')]).status).toBe('found');
    expect(findValue('13.03.2025', [doc('a', 'Date: 2025-03-12')]).status).toBe('not_found');
  });

  it('reports every file and page where the value is found', () => {
    const r = findValue('4 500,00', [
      doc('contract.pdf', 'nothing', 'Price 4500.00 per ton'),
      doc('invoice.pdf', [3, 'Amount 4 500,00']),
      doc('other.pdf', 'no'),
    ]);
    expect(r.status).toBe('found');
    expect(r.foundIn).toEqual([
      { file: 'contract.pdf', page: 2 },
      { file: 'invoice.pdf', page: 3 },
    ]);
  });

  it('omits the page for page-less documents', () => {
    const r = findValue('777', [{ file: 'a.docx', pages: [{ page: null, text: 'Ref 777' }] }]);
    expect(r.foundIn).toEqual([{ file: 'a.docx' }]);
  });
});

describe('extractFigures', () => {
  const raws = (t: string) => extractFigures(t).map((f) => f.raw);

  it('picks quantities with units, HS codes, document numbers, dates, containers, amounts', () => {
    const t =
      'Вага нетто 25 000 кг, код 2915 90 00 00, інвойс № INV-2024-001 від 12.03.2025, ' +
      'контейнер MSKU1234567, сума 12 345,67 USD, мито 5%.';
    const r = extractFigures(t);
    const kinds = Object.fromEntries(r.map((f) => [f.kind, f.raw]));
    expect(kinds.quantity).toBeDefined();
    expect(r.some((f) => f.kind === 'hs' && /2915/.test(f.raw))).toBe(true);
    expect(r.some((f) => f.kind === 'docnumber' && /INV-2024-001/.test(f.raw))).toBe(true);
    expect(r.some((f) => f.kind === 'date' && f.raw === '12.03.2025')).toBe(true);
    expect(r.some((f) => f.kind === 'container' && f.raw === 'MSKU1234567')).toBe(true);
    expect(r.some((f) => /12 345,67/.test(f.raw))).toBe(true);
    expect(r.some((f) => /25 000\s?кг/.test(f.raw))).toBe(true);
    expect(r.some((f) => /5\s?%/.test(f.raw))).toBe(true);
  });

  it('skips list numbering, bare years and page references', () => {
    const t = '1. Перший пункт\n2) Другий пункт\n1.2 Розділ\nУ 2024 році. Див. стор. 12 та стор. 3-4, p. 7, арк. 5.';
    expect(raws(t)).toEqual([]);
  });

  it('does not take the year of a date or a small count as a figure on its own', () => {
    expect(raws('Є 3 файли і 12 сторінок')).toEqual([]);
  });

  it('skips advisory HS candidates and lines marked as a conclusion', () => {
    expect(raws('Можливий код-кандидат: 2915 90 00 00')).toEqual([]);
    expect(raws('Разом 12 345,67 USD (висновок)')).toEqual([]);
  });

  it('deduplicates the same figure', () => {
    expect(raws('25 кг і ще раз 25 кг').length).toBe(1);
  });
});

describe('checkFigures', () => {
  it('returns only the figures no document supports', () => {
    const docs = [doc('inv.pdf', 'Net 25 000 kg, amount 12 345,67 USD, date 2025-03-12')];
    const figures = extractFigures('Вага 25 000 кг, сума 12 345,67 USD, дата 12.03.2025, контейнер MSKU7654321.');
    const bad = checkFigures(figures, docs);
    expect(bad).toEqual(['MSKU7654321']);
  });

  it('counts a number without its unit as supported', () => {
    const figures = extractFigures('Вага 25 кг.');
    expect(checkFigures(figures, [doc('pl', 'Qty | 25 |')])).toEqual([]);
  });
});
