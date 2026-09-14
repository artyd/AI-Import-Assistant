import { describe, it, expect } from 'vitest';
import { selectActualSheet, parseSheetDate, findDataHeader, type SheetInput } from '../sheets/selectActualSheet.js';

const tableRows = [
  ['Номенклатура', 'Кол-во', 'Цена'],
  ['Товар 1', 10, 100],
];
const noTableRows = [['Прайс станом на'], ['якийсь текст']];

const sheet = (name: string, hasTable = true): SheetInput => ({
  name,
  rows: hasTable ? tableRows : noTableRows,
});

describe('parseSheetDate', () => {
  it('парсить DD.MM з поточним роком', () => {
    const d = parseSheetDate('06.05', new Date(2026, 4, 6));
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(4);
    expect(d?.getDate()).toBe(6);
  });
  it('майбутню DD.MM відкочує на минулий рік', () => {
    const d = parseSheetDate('31.12', new Date(2026, 4, 6));
    expect(d?.getFullYear()).toBe(2025);
  });
  it('назва без дати → null', () => {
    expect(parseSheetDate('Субстанції', new Date(2026, 4, 6))).toBeNull();
  });
});

describe('findDataHeader', () => {
  it('знаходить рядок заголовків товарної таблиці', () => {
    expect(findDataHeader(tableRows)).toBe(0);
  });
  it('лист без товарної колонки → -1', () => {
    expect(findDataHeader(noTableRows)).toBe(-1);
  });
});

describe('selectActualSheet', () => {
  const today = new Date(2026, 4, 6); // 06.05.2026

  it('обирає лист із датою == сьогодні', () => {
    const sheets = [sheet('29.04'), sheet('30.04'), sheet('06.05'), sheet('Субстанції', false), sheet('Архів', false)];
    const r = selectActualSheet(sheets, today);
    expect(r.selected?.name).toBe('06.05');
    expect(r.reason).toContain('збігається');
    expect(r.ignored).toContain('Субстанції');
    expect(r.ignored).toContain('29.04');
  });

  it('без сьогоднішнього — бере найновіший не пізніше сьогодні', () => {
    const sheets = [sheet('02.05'), sheet('05.05')];
    const r = selectActualSheet(sheets, today);
    expect(r.selected?.name).toBe('05.05');
  });

  it('датований лист із таблицею виграє у недатованого', () => {
    const sheets = [sheet('Прайс', true), sheet('05.05', true)];
    const r = selectActualSheet(sheets, today);
    expect(r.selected?.name).toBe('05.05');
  });

  it('немає датованих — бере перший недатований із таблицею', () => {
    const sheets = [sheet('Субстанції', false), sheet('Прайс', true)];
    const r = selectActualSheet(sheets, today);
    expect(r.selected?.name).toBe('Прайс');
    expect(r.reason).toContain('найкраща таблиця');
  });
});
