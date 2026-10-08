import { describe, expect, it } from 'vitest';
import { describePosition, whereNowText, type WhereNow } from '../whereNow.js';
import { kyivHour } from '../../sheet/sync.js';

describe('describePosition', () => {
  it('names the nearby port, or the distance to the nearest one', () => {
    expect(describePosition([54.40, 18.66])).toMatch(/^біля /); // Gdańsk
    expect(describePosition([34.0, 25.0])).toMatch(/^~\d+ км від /); // open Mediterranean
  });
});

describe('whereNowText', () => {
  const base: WhereNow = {
    label: 'Сорбітол',
    number: 'MSBU3441255',
    forwarder: 'DSV',
    status: 'В дорозі',
    where: 'біля Порт-Саїд',
    source: 'орієнтовно — за датами виходу/прибуття і маршрутом',
    progress: 62,
    eta: '2026-10-22',
    etaEstimated: false,
    plan: '2026-10-19',
    delayDays: 3,
    trackUrl: 'https://www.msc.com/x',
  };
  it('lists where, how known, progress, ETA vs plan and the delay', () => {
    const t = whereNowText([base]);
    expect(t).toContain('**Сорбітол** (MSBU3441255) · везе DSV');
    expect(t).toContain('де: біля Порт-Саїд — орієнтовно');
    expect(t).toContain('пройдено ~62%');
    expect(t).toContain('ETA 22.10');
    expect(t).toContain('план у таблиці 19.10');
    expect(t).toContain('⚠ запізнюється на 3 дн');
  });
  it('says so when nothing is tracked', () => {
    expect(whereNowText([])).toMatch(/немає/);
  });
});

describe('kyivHour', () => {
  it('is the Kyiv wall-clock hour', () => {
    expect(kyivHour(new Date('2026-10-09T05:30:00Z'))).toBe(8); // UTC+3 in October
    expect(kyivHour(new Date('2026-12-09T05:30:00Z'))).toBe(7); // UTC+2 in winter
  });
});
