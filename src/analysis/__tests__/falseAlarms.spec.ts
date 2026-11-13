import { describe, it, expect } from 'vitest';
import { checkPrecursor, lookupUktzedCode } from '../engines/classify.js';
import { resolveLine } from '../engines/resolve.js';
import { buildOriginOptions, categoryChecks } from '../engines/origin.js';
import { calibrateRisk } from '../engines/risk.js';

describe('checkPrecursor: ціле слово + вузькі коди', () => {
  it('кофеїн (2939300000) не є попередником ефедрину', () => {
    expect(checkPrecursor('Caffeine anhydrous', '2939300000')).toBeNull();
    expect(resolveLine({ name: 'Кофеїн безводний', qtyKg: 1, unitPrice: 1 }).precursor).toBeNull();
  });
  it('справжній ефедрин за назвою і за 293941 лишається', () => {
    expect(checkPrecursor('Ephedrine HCl', null)?.table).toBe(1);
    expect(checkPrecursor('Невідомий товар', '2939410000')?.matchedByCode).toBe(true);
  });
  it('pseudoephedrine / norephedrine не потрапляють у запис ephedrine', () => {
    expect(checkPrecursor('Pseudoephedrine HCl', null)?.note).toContain('Список I');
    expect(checkPrecursor('Norephedrine', null)?.note).toContain('Список I ЄС/UA');
  });
  it('apomorphine, diacetone, toluenesulfonic acid не збігаються з morphine/acetone/toluene', () => {
    expect(checkPrecursor('Apomorphine HCl', null)).toBeNull();
    expect(checkPrecursor('Диацетон акриламід', null)).toBeNull();
    expect(checkPrecursor('p-Toluenesulfonic acid', null)).toBeNull();
  });
  it('кириличний відмінок ефедрину збігається, а коди «інші» (293399) не дають fentanyl-тривоги', () => {
    expect(checkPrecursor('Ефедрину сульфат', null)).not.toBeNull();
    expect(checkPrecursor('Omeprazole', '2933990000')).toBeNull();
  });
});

describe('Повідон-йод ≠ повідон', () => {
  it('має власний код 3905999000, а не ПВП 3905909000', () => {
    expect(lookupUktzedCode('Повідон-йод «Медлев»')?.code).toBe('3905999000');
    expect(lookupUktzedCode('Povidone iodine USP')?.code).toBe('3905999000');
  });
  it('ПВП без йоду лишається 3905909000', () => {
    expect(lookupUktzedCode('Повідон К30')?.code).toBe('3905909000');
  });
  it('невідома «X-йод» не схлопується до X', () => {
    expect(lookupUktzedCode('Повідон-йод')?.code).not.toBe('3905909000');
  });
});

describe('Походження: фіто лише для сировини', () => {
  const reds = (o: ReturnType<typeof buildOriginOptions>) =>
    o.filter((p) => p.key === 'plant').flatMap((p) => [...p.euChecks, ...p.uaChecks, ...p.transitChecks]).filter((c) => c.status === 'red');
  it('МКЦ (3912) з KB-пінінгом «рослинне» не має red-фіто', () => {
    const opts = buildOriginOptions(
      { name: 'Мікрокристалічна целюлоза 101', uctzedCode: '3912310000', originType: 'рослинне', productionMethod: 'кислотний гідроліз целюлозної пульпи' },
      { key: 'plant', confidence: 'high' },
    );
    expect(opts.find((o) => o.recommended)?.key).toBe('plant');
    expect(reds(opts)).toHaveLength(0);
  });
  it('ментол (2906) «рослинне або синтетичне» — без red-фіто', () => {
    const opts = buildOriginOptions(
      { name: 'Levomenthol', uctzedCode: '2906110000', originType: 'рослинне або синтетичне', productionMethod: 'синтез/гідрогенізація тимолу' },
      { key: 'plant', confidence: 'medium' },
    );
    expect(reds(opts)).toHaveLength(0);
  });
  it('справжня рослинна сировина (гл. 12) зберігає red-фіто', () => {
    const opts = buildOriginOptions({ name: 'Herbal leaf', uctzedCode: '1211900000', originType: 'рослинне' }, { key: 'plant', confidence: 'high' });
    expect(reds(opts).length).toBeGreaterThan(0);
  });
  it('«Медлев» не додає тваринне походження через «мед»', () => {
    const keys = buildOriginOptions({ name: 'Повідон-йод Медлев', uctzedCode: '3905999000' }).map((o) => o.key);
    expect(keys).not.toContain('animal');
  });
});

describe('АФІ/ЛЗ-2 — умовна вимога', () => {
  it('«Фармацевтична/косметична» категорія без «АФІ» не дає вимог АФІ', () => {
    const r = categoryChecks('Фармацевтичний/косметичний ексципієнт');
    expect(r.ua).toHaveLength(0);
    expect(categoryChecks('Фармацевтична / харчова / косметична речовина').ua.some((c) => /Держлікслужба/.test(c.item))).toBe(false);
  });
  it('«графіт» не збігається з «афі»', () => {
    expect(categoryChecks('Графіт технічний').ua).toHaveLength(0);
  });
  it('категорія з АФІ → лише умовна жовта перевірка ЛЗ-2', () => {
    const r = categoryChecks('АФІ / Харчова добавка');
    const lz = r.ua.find((c) => /Держлікслужба/.test(c.item));
    expect(lz?.status).toBe('yellow');
    expect(lz?.item).toMatch(/якщо/);
  });
});

describe('calibrateRisk: ПДВ 7 % не критичний', () => {
  it('Критичний лише через підставу ПДВ → Середній + «уточнити»', () => {
    const r = calibrateRisk('Критичний', 'Підставу пільгового ПДВ 7 % не підтверджено', false);
    expect(r.risk).toBe('Середній');
    expect(r.riskNote).toMatch(/^Уточнити підставу ПДВ 7/);
  });
  it('прекурсор або заборона лишаються Критичними', () => {
    expect(calibrateRisk('Критичний', 'ПДВ 7 % та прекурсор', false).risk).toBe('Критичний');
    expect(calibrateRisk('Критичний', 'ПДВ', true).risk).toBe('Критичний');
  });
  it('нижчі рівні не чіпаємо', () => {
    expect(calibrateRisk('Низький', 'ПДВ 7 %', false).risk).toBe('Низький');
  });
});
