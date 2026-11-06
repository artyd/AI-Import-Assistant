import { describe, expect, it } from 'vitest';
import {
  hsCodesOf,
  importSectionOf,
  normalizeHsCode,
  qdproMeasures,
  requirementsFromQdpro,
} from '../qdproRequirements.js';

// Fictional fixtures shaped like the qdpro goodinfo ІМПОРТ tab (get_text("\n"):
// one heading / value per line). Not real tariff data.
const FEED_ADDITIVE_IMPORT = [
  'Пільгова ставка',
  '0%',
  'Повна ставка',
  '5%',
  'ПДВ',
  '20%',
  'Ветеринарно-санітарний контроль',
  'Код документу 5514 — міжнародний ветеринарний сертифікат',
  'Код документу 0853 — підтвердження проходження контролю',
  'Заборона ввезення товарів походженням з держави-агресора (постанова КМУ № 0000)',
].join('\n');

const PLANT_IMPORT = [
  'Пільгова ставка',
  '2%',
  'Фітосанітарний контроль',
  'Документ 5509 — фітосанітарний сертифікат',
  'Ліцензування імпорту',
  'Ліцензія на імпорт видається відповідно до постанови КМУ',
].join('\n');

const CHEMICAL_IMPORT = [
  'Пільгова ставка',
  '0%',
  'Прекурсори (таблиця IV Переліку наркотичних засобів, психотропних речовин і прекурсорів)',
  'Технічний регламент щодо безпечності хімічної продукції',
  'Товари подвійного використання: потрібен висновок уповноваженого органу',
].join('\n');

const NEGATED_IMPORT = [
  'Ветеринарно-санітарний контроль',
  'Не підлягає',
  'Фітосанітарний контроль не здійснюється',
  'Ліцензування експорту',
  'Пільгова ставка 0%',
].join('\n');

describe('requirementsFromQdpro — IMPORT measures → requirement keys', () => {
  it('veterinary-sanitary control → veterinary certificate', () => {
    expect(requirementsFromQdpro(FEED_ADDITIVE_IMPORT)).toEqual(['veterinary_certificate']);
    expect(qdproMeasures(FEED_ADDITIVE_IMPORT)[0]?.evidence).toBe('Ветеринарно-санітарний контроль');
  });

  it('phytosanitary control and import licensing', () => {
    expect(requirementsFromQdpro(PLANT_IMPORT)).toEqual(['phytosanitary_certificate', 'import_license']);
  });

  it('precursors, technical regulation and dual use — in a stable order', () => {
    expect(requirementsFromQdpro(CHEMICAL_IMPORT)).toEqual(['precursor_permit', 'conformity_document', 'dual_use_permit']);
  });

  it('a negated measure (same or next line) and export licensing are ignored', () => {
    expect(requirementsFromQdpro(NEGATED_IMPORT)).toEqual([]);
  });

  it('nothing known → nothing required; duty lines alone are not measures', () => {
    expect(requirementsFromQdpro('Пільгова ставка\n0%\nПовна ставка\n10%\nПДВ\n20%')).toEqual([]);
    expect(requirementsFromQdpro('')).toEqual([]);
  });

  it('one entry per key even when the measure repeats', () => {
    const text = 'Ветеринарно-санітарний контроль\nКод 5514\nВетеринарний контроль на кордоні';
    expect(qdproMeasures(text).map((m) => m.key)).toEqual(['veterinary_certificate']);
  });
});

describe('importSectionOf', () => {
  it('takes the ІМПОРТ tab, never export/transit', () => {
    const r = {
      tabs: [
        { label: 'ЕКСПОРТ', text: 'Ліцензування експорту' },
        { label: 'ІМПОРТ', text: FEED_ADDITIVE_IMPORT },
        { label: 'ТРАНЗИТ', text: 'Фітосанітарний контроль' },
      ],
    };
    expect(requirementsFromQdpro(importSectionOf(r))).toEqual(['veterinary_certificate']);
  });

  it('reads the «## РЕЖИМ: ІМПОРТ» section of a regime-labelled text', () => {
    const text = [
      '## ЗАГАЛЬНЕ (опис товару, тариф, спільні коментарі)',
      'Фітосанітарний контроль — для іншої підпозиції',
      '## РЕЖИМ: ІМПОРТ',
      'Ветеринарно-санітарний контроль',
      '## РЕЖИМ: ЕКСПОРТ',
      'Ліцензування',
    ].join('\n');
    expect(requirementsFromQdpro(importSectionOf({ text }))).toEqual(['veterinary_certificate']);
  });

  it('no import regime → empty (no guessing from common text)', () => {
    expect(importSectionOf({ tabs: [], text: 'Ветеринарно-санітарний контроль' })).toBe('');
  });
});

describe('HS codes of an extraction', () => {
  it('normalises to 10 digits, else null', () => {
    expect(normalizeHsCode('2922 41 00 00')).toBe('2922410000');
    expect(normalizeHsCode('2922.41')).toBeNull();
    expect(normalizeHsCode(null)).toBeNull();
  });

  it('top-level and line-item codes, de-duplicated', () => {
    expect(
      hsCodesOf({ hs_code: '2922410000', line_items: [{ hs_code: '2922 41 00 00' }, { hs_code: '1234567890' }, { hs_code: null }, null] }),
    ).toEqual(['2922410000', '1234567890']);
    expect(hsCodesOf(null)).toEqual([]);
  });
});
