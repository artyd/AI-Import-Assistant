import { describe, it, expect } from 'vitest';
import { calculatePayments, incotermCoverage, FREIGHT_FALLBACK_MULTIPLIER } from '../engines/payment.js';
import { CalcRequest } from '../types/contract.js';

/** Хелпер: одна позиція + shipment, з дефолтами через zod-parse. */
function calc(
  shipment: Partial<{
    incoterm: string;
    currency: string;
    freight: number | null;
    insurance: number | null;
    fxToUAH: number | null;
    fxDate: string | null;
  }>,
  lines: Array<Record<string, unknown>>,
) {
  const req = CalcRequest.parse({
    shipment: { incoterm: 'CIF', currency: 'USD', ...shipment },
    lines,
  });
  return calculatePayments(req);
}

describe('incotermCoverage', () => {
  it('FOB/EXW не включають фрахт і страхування', () => {
    expect(incotermCoverage('FOB')).toEqual({ freightIncluded: false, insuranceIncluded: false });
    expect(incotermCoverage('EXW')).toEqual({ freightIncluded: false, insuranceIncluded: false });
  });
  it('CIF включає фрахт і страхування', () => {
    expect(incotermCoverage('CIF')).toEqual({ freightIncluded: true, insuranceIncluded: true });
  });
  it('CFR включає фрахт, але не страхування', () => {
    expect(incotermCoverage('CFR')).toEqual({ freightIncluded: true, insuranceIncluded: false });
  });
});

describe('calculatePayments — митна вартість', () => {
  it('CIF: митна вартість = вартість товару (фрахт вже включено), не estimated', () => {
    const r = calc({ incoterm: 'CIF' }, [
      { name: 'A', qtyKg: 100, unitPrice: 10, dutyRatePercent: 5, dutyRateSource: 'db' },
    ]);
    const l = r.lines[0]!;
    expect(l.goodsValue.value).toBe(1000);
    expect(l.customsValue.value).toBe(1000);
    expect(l.customsValue.estimated).toBe(false);
    expect(l.customsValue.source).toBe('user');
    expect(l.duty!.value).toBe(50); // 1000 * 5%
    expect(l.vat!.value).toBe(210); // (1000+50) * 20%
    expect(l.totalPayable!.value).toBe(260);
    expect(l.needsReview).toBe(false);
  });

  it('FOB + фрахт + страхування: реальна митна вартість FOB+F+I', () => {
    const r = calc({ incoterm: 'FOB', freight: 200, insurance: 50 }, [
      { name: 'A', qtyKg: 100, unitPrice: 10, dutyRatePercent: 5, dutyRateSource: 'db' },
    ]);
    const l = r.lines[0]!;
    expect(l.customsValue.value).toBe(1250);
    expect(l.customsValue.estimated).toBe(false);
    expect(l.duty!.value).toBe(62.5);
    expect(l.vat!.value).toBe(262.5); // (1250+62.5)*20%
    expect(l.totalPayable!.value).toBe(325);
  });

  it('EXW без фрахту: fallback ×1.10, ПОЗНАЧЕНО estimated + needsReview', () => {
    const r = calc({ incoterm: 'EXW' }, [
      { name: 'A', qtyKg: 100, unitPrice: 10, dutyRatePercent: 5, dutyRateSource: 'db' },
    ]);
    const l = r.lines[0]!;
    expect(l.customsValue.value).toBe(1000 * FREIGHT_FALLBACK_MULTIPLIER);
    expect(l.customsValue.estimated).toBe(true);
    expect(l.customsValue.source).toBe('fallback');
    expect(l.needsReview).toBe(true);
    expect(l.duty!.estimated).toBe(true);
    expect(l.warnings.some((w) => w.includes('орієнтовно'))).toBe(true);
  });
});

describe('calculatePayments — ПДВ за режимом', () => {
  it('7% для зареєстрованих ліків замість 20%', () => {
    const med = calc({ incoterm: 'CIF' }, [
      { name: 'ЛЗ', qtyKg: 100, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db', vatRegime: 'medicine_7' },
    ]).lines[0]!;
    expect(med.vatRatePercent).toBe(0.07);
    expect(med.vat!.value).toBe(70); // 1000 * 7%

    const std = calc({ incoterm: 'CIF' }, [
      { name: 'Хім', qtyKg: 100, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db', vatRegime: 'standard_20' },
    ]).lines[0]!;
    expect(std.vat!.value).toBe(200); // 1000 * 20%
  });

  it('0% ПДВ', () => {
    const l = calc({ incoterm: 'CIF' }, [
      { name: 'X', qtyKg: 10, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db', vatRegime: 'zero_0' },
    ]).lines[0]!;
    expect(l.vat!.value).toBe(0);
  });
});

describe('calculatePayments — ставка мита', () => {
  it('DCFTA 0% vs MFN 5% дають різне мито', () => {
    const dcfta = calc({ incoterm: 'CIF' }, [
      { name: 'X', qtyKg: 100, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db' },
    ]).lines[0]!;
    const mfn = calc({ incoterm: 'CIF' }, [
      { name: 'X', qtyKg: 100, unitPrice: 10, dutyRatePercent: 5, dutyRateSource: 'db' },
    ]).lines[0]!;
    expect(dcfta.duty!.value).toBe(0);
    expect(mfn.duty!.value).toBe(50);
  });

  it('невідома ставка → мито null, але ПДВ нараховується на митну вартість, needsReview', () => {
    const l = calc({ incoterm: 'CIF' }, [
      { name: 'X', qtyKg: 100, unitPrice: 10, dutyRatePercent: null },
    ]).lines[0]!;
    // Мито невідоме → не рахуємо, але ПДВ 20% нараховується на митну вартість
    // (1000), а не пропускається — інакше загальний ПДВ занижується.
    expect(l.duty).toBeNull();
    expect(l.vat!.value).toBe(200);
    expect(l.vat!.estimated).toBe(true);
    expect(l.totalPayable!.value).toBe(200);
    expect(l.needsReview).toBe(true);
  });

  it('ставка від AI позначається estimated + needsReview', () => {
    const l = calc({ incoterm: 'CIF' }, [
      { name: 'X', qtyKg: 100, unitPrice: 10, dutyRatePercent: 6.5, dutyRateSource: 'ai' },
    ]).lines[0]!;
    expect(l.dutyRatePercent!.estimated).toBe(true);
    expect(l.duty!.estimated).toBe(true);
    expect(l.needsReview).toBe(true);
  });
});

describe('calculatePayments — акциз, FX, розподіл, зведена', () => {
  it('акциз входить у базу ПДВ і в total', () => {
    const l = calc({ incoterm: 'CIF' }, [
      { name: 'X', qtyKg: 100, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db', exciseAmountPerKg: 2 },
    ]).lines[0]!;
    expect(l.excise.value).toBe(200);
    expect(l.vat!.value).toBe(240); // (1000+0+200)*20%
    expect(l.totalPayable!.value).toBe(440); // 0 duty + 200 excise + 240 vat
  });

  it('курс UAH застосовується до митної вартості', () => {
    const l = calc({ incoterm: 'CIF', fxToUAH: 40, fxDate: '2026-07-29' }, [
      { name: 'X', qtyKg: 100, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db' },
    ]).lines[0]!;
    expect(l.customsValueUAH!.value).toBe(40000);
  });

  it('фрахт розподіляється по позиціях пропорційно вартості', () => {
    const r = calc({ incoterm: 'FOB', freight: 300 }, [
      { name: 'A', qtyKg: 100, unitPrice: 10, dutyRatePercent: 0, dutyRateSource: 'db' }, // goods 1000, 1/3
      { name: 'B', qtyKg: 100, unitPrice: 20, dutyRatePercent: 0, dutyRateSource: 'db' }, // goods 2000, 2/3
    ]);
    expect(r.lines[0]!.customsValue.value).toBe(1100); // 1000 + 100
    expect(r.lines[1]!.customsValue.value).toBe(2200); // 2000 + 200
  });

  it('зведена агрегує суми і прапорці', () => {
    const r = calc({ incoterm: 'EXW' }, [
      { name: 'A', qtyKg: 100, unitPrice: 10, dutyRatePercent: 5, dutyRateSource: 'db' },
    ]);
    expect(r.summary.anyEstimated).toBe(true);
    expect(r.summary.anyNeedsReview).toBe(true);
    expect(r.summary.totalCustomsValue.value).toBe(1100);
    expect(r.summary.currency).toBe('USD');
  });
});
