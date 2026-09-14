import { describe, it, expect } from 'vitest';
import { inferOriginCandidateKeys, buildOriginOptions, categoryChecks, originKeyFromType } from '../engines/origin.js';

describe('inferOriginCandidateKeys', () => {
  it('гл.29 (2941 антибіотик) → синтетичне + ферментаційне', () => {
    const keys = inferOriginCandidateKeys({ name: 'Амоксицилін', uctzedCode: '2941100000' });
    expect(keys).toContain('synthetic');
    expect(keys).toContain('fermentation');
  });
  it('3913 → природні полімери: рослинне/тваринне/ферментаційне/змішане', () => {
    const keys = inferOriginCandidateKeys({ name: 'Гіалуронова кислота', uctzedCode: '3913900090' });
    for (const k of ['plant', 'animal', 'fermentation', 'mixed'] as const) expect(keys).toContain(k);
  });
  it('ключові слова (gelatin) → тваринне', () => {
    expect(inferOriginCandidateKeys({ name: 'Gelatin bovine' })).toContain('animal');
  });
});

describe('originKeyFromType + пінінг', () => {
  it('ферментаційне → fermentation, рекомендоване з high при пінінгу', () => {
    expect(originKeyFromType('ферментаційне')).toBe('fermentation');
    const opts = buildOriginOptions(
      { name: 'L-Лізин', uctzedCode: '2922410000', originType: 'ферментаційне' },
      { key: 'fermentation', confidence: 'high' },
    );
    const rec = opts.find((o) => o.recommended);
    expect(rec?.key).toBe('fermentation');
    expect(rec?.confidence).toBe('high');
  });
});

describe('categoryChecks', () => {
  it('подвійне призначення → export control (red) у ЄС і UA', () => {
    const ch = categoryChecks('Кормова амінокислота / ПОДВІЙНЕ ПРИЗНАЧЕННЯ');
    expect(ch.eu.some((x) => /export control/i.test(x.item) && x.status === 'red')).toBe(true);
    expect(ch.ua.some((x) => /Держекспортконтроль/.test(x.item))).toBe(true);
  });
  it('АФІ → Держлікслужба (red) в UA', () => {
    const ch = categoryChecks('АФІ (активна фармацевтична субстанція)');
    expect(ch.ua.some((x) => /Держлікслужба/.test(x.item) && x.status === 'red')).toBe(true);
  });
  it('нейтральна категорія → без спец-перевірок', () => {
    const ch = categoryChecks('Промислова хімія');
    expect(ch.eu.length + ch.ua.length).toBe(0);
  });
});
