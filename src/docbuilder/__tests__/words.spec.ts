import { describe, expect, it } from 'vitest';
import { amountWordsEn, amountWordsUk, enNumber, ukNumber, ukPlural } from '../words.js';
import { dateCompact, dateEn, dateUk, moneyEn, moneyUk, priceUk, qtyUk } from '../format.js';

describe('amounts in words — as the team writes them in contracts', () => {
  it('matches the real contracts', () => {
    expect(amountWordsUk(865, 'USD')).toBe("вісімсот шістдесят п'ять доларів США 00 центів");
    expect(amountWordsUk(25010, 'USD')).toBe("двадцять п'ять тисяч десять доларів США 00 центів");
    expect(amountWordsUk(4360, 'USD')).toBe('чотири тисячі триста шістдесят доларів США 00 центів');
    expect(amountWordsUk(12320, 'USD')).toBe('дванадцять тисяч триста двадцять доларів США 00 центів');
    expect(amountWordsEn(865, 'USD')).toBe('eight hundred sixty-five US dollars and zero cents');
    expect(amountWordsEn(25010, 'USD')).toBe('twenty-five thousand ten US dollars and zero cents');
  });

  it('agrees Ukrainian numerals with the noun', () => {
    expect(ukNumber(1000)).toBe('одна тисяча');
    expect(ukNumber(2000)).toBe('дві тисячі');
    expect(ukNumber(5000)).toBe("п'ять тисяч");
    expect(ukNumber(11000)).toBe('одинадцять тисяч');
    expect(ukNumber(21000)).toBe('двадцять одна тисяча');
    expect(ukNumber(2_000_001)).toBe('два мільйони один');
    expect(amountWordsUk(1, 'USD')).toBe('один долар США 00 центів');
    expect(amountWordsUk(22.01, 'USD')).toBe('двадцять два долари США 01 цент');
    expect(amountWordsUk(60600.5, 'EUR')).toBe('шістдесят тисяч шістсот євро 50 центів');
    expect([1, 2, 5, 11, 14, 21, 112].map(ukPlural)).toEqual([0, 1, 2, 2, 2, 0, 2]);
  });

  it('writes English numbers', () => {
    expect(enNumber(0)).toBe('zero');
    expect(enNumber(101)).toBe('one hundred one');
    expect(enNumber(1_250_000)).toBe('one million two hundred fifty thousand');
    expect(amountWordsEn(1.01, 'EUR')).toBe('one euro and one cent');
  });
});

describe('number and date formats', () => {
  it('formats like the originals', () => {
    expect(moneyUk(25010)).toBe('25 010,00');
    expect(moneyEn(25010)).toBe('25,010.00');
    expect(moneyUk(865)).toBe('865,00');
    expect(qtyUk(2200)).toBe('2 200');
    expect(qtyUk(1033.4)).toBe('1 033,4');
    expect(priceUk(1.73)).toBe('1,73');
    expect(priceUk(2)).toBe('2,00');
    expect(priceUk(4.3612)).toBe('4,3612');
    expect(dateEn('2026-07-31')).toBe('July 31, 2026');
    expect(dateUk('2026-08-04')).toBe('4 серпня 2026 р.');
    expect(dateCompact('2026-08-04')).toBe('04082026');
    expect(dateEn('bad')).toBe('');
  });
});
