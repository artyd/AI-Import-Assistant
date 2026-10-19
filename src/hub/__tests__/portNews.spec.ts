import { describe, expect, it } from 'vitest';
import { placesMentioned } from '../portNews.js';

const codes = (t: string) => placesMentioned(t).map((p) => p.code).sort();

describe('port mentions in news', () => {
  it('finds ports by Ukrainian name with case endings', () => {
    expect(codes('Робота порту Одеси відновлена після атаки')).toContain('UAODS');
    expect(codes('У Чорноморську черги на розвантаження')).toContain('UAILK');
  });

  it('finds ports and airports by English name / alias', () => {
    expect(codes('Congestion at Constanța container terminal grows')).toContain('ROCND');
    expect(codes('Strike halts operations at Port of Antwerpen')).toContain('BEANR');
    expect(codes('Leipzig/Halle hub expands DHL capacity')).toEqual(expect.arrayContaining(['LEJ']));
  });

  it('finds border crossings by either side name', () => {
    expect(codes('Черги на Ягодині сягнули 900 фур')).toContain('UAYAG');
    expect(codes('Polish farmers block Dorohusk crossing again')).toContain('UAYAG');
  });

  it('ignores inland cities and unrelated words', () => {
    expect(codes('У Києві відбулася конференція')).toEqual([]);
    expect(codes('Freight rates fall on Asia–Europe trades')).toEqual([]);
  });
});

describe('short names', () => {
  it('match only exactly', () => {
    expect(codes('Порт Рені працює у штатному режимі')).toContain('UARNI');
    expect(codes('Ренту за склад підвищили')).toEqual([]);
  });
});
