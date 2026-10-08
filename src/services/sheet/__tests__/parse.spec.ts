import { describe, expect, it } from 'vitest';
import {
  approxWarehouseDate,
  carrierFromUrl,
  mapColumns,
  numbersFromUrl,
  parseCsv,
  parseSheetDate,
  parseTrackingTab,
  parseWarehouseTab,
  pickNumber,
  reconcileYears,
  statusFromText,
  trimGrid,
} from '../parse.js';
import { matchLogist } from '../sync.js';
import { periodRange } from '../../../agent/sheetTools.js';

const TODAY = '2026-10-09';

// Same layout as the team sheet (Аркуш3), synthetic data.
const HEADER = [
  '№ листа', '', 'Товар', 'Кто везет', '', '', '№ контейнер', '№ ТТН', 'Дата прибытия планируемая', 'Место прибытия', '',
  'Дата выхода', '', 'Место выхода', 'Морская Линия', 'Комментарий', 'Место растаможки', 'Склад выгрузки', '', '',
];
const row = (cells: Record<number, string>) => HEADER.map((_, i) => cells[i] ?? '');

describe('parseCsv', () => {
  it('handles quotes, commas and newlines inside cells', () => {
    expect(parseCsv('a,"b,c","d ""q""\nline2"\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "q"\nline2'],
      ['1', '2', '3'],
    ]);
  });
});

describe('parseSheetDate', () => {
  it('reads full dates in the usual formats', () => {
    expect(parseSheetDate('19.03.2025', TODAY)).toEqual({ date: '2025-03-19', guessed: false });
    expect(parseSheetDate('16/01/2026', TODAY)).toEqual({ date: '2026-01-16', guessed: false });
    expect(parseSheetDate('17.9.2026', TODAY)).toEqual({ date: '2026-09-17', guessed: false });
    expect(parseSheetDate('2026-10-12', TODAY)).toEqual({ date: '2026-10-12', guessed: false });
    expect(parseSheetDate('5/3/26', TODAY)).toEqual({ date: '2026-03-05', guessed: false });
  });

  it('guesses the year nearest to the reference date', () => {
    expect(parseSheetDate('11/09', TODAY)).toEqual({ date: '2026-09-11', guessed: true });
    expect(parseSheetDate('27/11', TODAY)).toEqual({ date: '2026-11-27', guessed: true });
    expect(parseSheetDate('15/01', '2026-12-20')).toEqual({ date: '2027-01-15', guessed: true });
    expect(parseSheetDate('25/12', '2025-11-01')).toEqual({ date: '2025-12-25', guessed: true });
  });

  it('falls back to month-first only when day-first is impossible', () => {
    expect(parseSheetDate('9/18/26', TODAY)).toEqual({ date: '2026-09-18', guessed: false });
    expect(parseSheetDate('Friday, 9/18/26 4:33 PM', TODAY, true)).toEqual({ date: '2026-09-18', guessed: false });
  });

  it('rejects garbage and impossible dates', () => {
    expect(parseSheetDate('', TODAY)).toBeNull();
    expect(parseSheetDate('Мультикс', TODAY)).toBeNull();
    expect(parseSheetDate('31.02.2026', TODAY)).toBeNull();
  });

  it('reads a Sheets serial day number', () => {
    expect(parseSheetDate('46304', TODAY)).toEqual({ date: '2026-10-09', guessed: false });
  });
});

describe('reconcileYears', () => {
  it('puts a guessed arrival in the departure year or the next one', () => {
    const [, a] = reconcileYears({ date: '2025-02-26', guessed: false }, { date: '2027-02-27', guessed: true });
    expect(a!.date).toBe('2025-02-27');
    const [, b] = reconcileYears({ date: '2026-12-20', guessed: false }, { date: '2026-01-25', guessed: true });
    expect(b!.date).toBe('2027-01-25');
  });
  it('puts a guessed departure before an explicit arrival', () => {
    const [d] = reconcileYears({ date: '2026-12-25', guessed: true }, { date: '2026-01-31', guessed: false });
    expect(d!.date).toBe('2025-12-25');
  });
});

describe('statusFromText', () => {
  it('finds the most advanced status and its date', () => {
    expect(statusFromText(['растаможен 23/04/2025'], TODAY)).toEqual({ status: 'customs', date: { date: '2025-04-23', guessed: false } });
    expect(statusFromText(['доставлено клиенту 03/04/2025'], TODAY)!.status).toBe('delivered');
    expect(statusFromText(['Delivered\nFriday, 9/18/2026 at 4:33 pm'], TODAY)).toEqual({
      status: 'delivered',
      date: { date: '2026-09-18', guessed: false },
    });
    expect(statusFromText(['прибыл в порт, ждем выгрузку'], TODAY)!.status).toBe('arrived');
    expect(statusFromText(['ждем букинг'], TODAY)).toBeNull();
    expect(statusFromText(['GDANSK BALTIC HUB Vessel arrival (MAERSK SARAT) 03 Oct 2026 Discharge'], TODAY)!.status).toBe('arrived');
  });
});

describe('tracking numbers', () => {
  it('reads numbers hidden in carrier links', () => {
    expect(numbersFromUrl('https://www.searates.com/container/tracking/?number=SZLU9420727&type=CT&sealine=COSU')).toContain('SZLU9420727');
    expect(numbersFromUrl('https://www.maersk.com/tracking/MRSU6298959')).toContain('MRSU6298959');
    expect(numbersFromUrl('https://www.dhl.com/de-en/home/tracking/tracking-express.html?submit=1&tracking-id=49%208129%204286')).toContain('49 8129 4286');
    const msc = `https://www.msc.com/en/track-a-shipment?params=${encodeURIComponent(Buffer.from('trackingNumber=MEDU7603441&trackingMode=0').toString('base64'))}`;
    expect(numbersFromUrl(msc)).toContain('MEDU7603441');
  });

  it('takes the line from the link host or the SCAC', () => {
    expect(carrierFromUrl('https://www.searates.com/container/tracking/?number=X&sealine=MSCU')).toBe('msc');
    expect(carrierFromUrl('https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do')).toBe('evergreen');
    expect(carrierFromUrl('https://ua.meest.com/parcel-track?parcel_number=UA1')).toBe('meest');
    expect(carrierFromUrl('not a url')).toBeNull();
  });

  it('picks the number + carrier from the cells or the link', () => {
    expect(pickNumber(['Трансвосток', ''], 'https://www.searates.com/container/tracking/?number=SZLU9420727&sealine=COSU')).toMatchObject({
      number: 'SZLU9420727',
      carrier: 'cosco',
      kind: 'container',
      mode: 'sea',
    });
    expect(pickNumber(['', 'UA2446015FL00070G'], 'https://ua.meest.com/parcel-track?parcel_number=UA2446015FL00070G')).toMatchObject({
      number: 'UA2446015FL00070G',
      carrier: 'meest',
      mode: 'courier',
    });
    expect(pickNumber(['', '49 8129 4286'], 'https://www.dhl.com/x?tracking-id=49%208129%204286')).toMatchObject({ number: '4981294286', carrier: 'dhl' });
    expect(pickNumber(['', '1,42551E+11'], '')).toBeNull();
  });
});

describe('mapColumns', () => {
  it('maps named and unnamed columns by position', () => {
    const c = mapColumns(HEADER, [row({ 2: 'X', 14: 'https://www.maersk.com/tracking/MRSU6298959' })]);
    expect(c.named.product).toBe(2);
    expect(c.named.arrival).toBe(8);
    expect(c.named.trackUrl).toBe(14);
    expect(c.ref).toBe(1);
    expect(c.weight).toBe(4);
    expect(c.line).toBe(5);
    expect(c.destination2).toBe(10);
    expect(c.logist).toBe(12);
    expect(c.extra).toEqual([18, 19]);
  });
});

describe('parseTrackingTab', () => {
  const grid = [
    HEADER,
    row({ 2: 'Старий товар', 8: '19.03.2025', 11: '27.01.2025', 15: 'растаможен 23/04/2025' }),
    row({ 2: 'Метрибузин', 6: 'Трансвосток', 8: '01.10.2026', 11: '01.08.2026', 18: 'растаможен 05/10' }),
    row({ 2: 'Холіна хлорид', 3: 'Мультикс', 6: 'MSBU1491088', 8: '27/11', 9: 'Гданськ', 11: '22/09', 12: 'Люда', 13: 'Шанхай', 14: 'https://www.msc.com/en/track-a-shipment' }),
    row({ 2: 'Зразок папаїну', 7: 'UA2677413HJ00110G', 11: '25/09', 14: 'https://meest.cn/tracking/' }),
    row({ 2: 'Без дат', 6: 'Ксиоми/ДСВ' }),
    row({ 0: '', 6: '17.9.2026', 7: '18.11.2026', 8: '62' }),
  ];
  const rows = parseTrackingTab(grid, TODAY);

  it('parses every product row (and skips the totals line)', () => {
    expect(rows.map((r) => r.product)).toEqual(['Старий товар', 'Метрибузин', 'Холіна хлорид', 'Зразок папаїну', 'Без дат']);
    expect(rows[0]!.rowIndex).toBe(2);
  });

  it('reads an active sea row with guessed years, logist and route', () => {
    const r = rows[2]!;
    expect(r).toMatchObject({
      number: 'MSBU1491088',
      carrier: 'msc',
      mode: 'sea',
      forwarder: 'Мультикс',
      logist: 'Люда',
      origin: 'Шанхай',
      destination: 'Гданськ',
      status: 'in_transit',
      active: true,
    });
    expect(r.departure).toEqual({ date: '2026-09-22', guessed: true });
    expect(r.arrival).toEqual({ date: '2026-11-27', guessed: true });
    // A year-less date simply takes the year — no "guessed" issue any more.
    expect(r.issues).not.toContain('year_guessed');
  });

  it('marks cleared / old rows inactive and keeps the status date', () => {
    expect(rows[0]).toMatchObject({ status: 'customs', active: false });
    expect(rows[1]).toMatchObject({ status: 'customs', active: false });
    expect(rows[1]!.statusDate!.date).toBe('2026-10-05');
    expect(rows[1]!.forwarder).toBe('Трансвосток');
    expect(rows[1]!.issues).toContain('container_not_number');
  });

  it('flags data problems', () => {
    expect(rows[4]!.issues).toEqual(expect.arrayContaining(['no_dates', 'container_not_number']));
    expect(rows[4]!.recent).toBe(true);
    expect(rows[3]).toMatchObject({ number: 'UA2677413HJ00110G', carrier: 'meest', status: 'in_transit', active: true });
  });

  it('flags a passed plan without clearance as overdue', () => {
    const late = parseTrackingTab([HEADER, row({ 2: 'Запізнення', 8: '01.10.2026', 11: '01.08.2026' })], TODAY)[0]!;
    expect(late.issues).toContain('overdue');
    expect(late.active).toBe(true);
  });

  it('gives stable, unique keys', () => {
    const again = parseTrackingTab(grid, TODAY);
    expect(again.map((r) => r.key)).toEqual(rows.map((r) => r.key));
    const dup = parseTrackingTab([HEADER, row({ 2: 'X', 11: '01.08.2026' }), row({ 2: 'X', 11: '01.08.2026' })], TODAY);
    expect(new Set(dup.map((r) => r.key)).size).toBe(2);
  });
});

describe('warehouse tab', () => {
  const grid = [
    ['номенклатура ', 'кол-во ', 'когда?', 'в БЦ', 'в Харьков'],
    ['лизин сульфат ', '36000', 'конец этой недели-след', '11000', '12900'],
    ['Стовпець 1', 'кол-во', 'прибытие', 'в БЦ'],
    ['сорбитол', '24000', 'на этой неделе', 'не влезет'],
  ];
  it('skips repeated header rows', () => {
    const rows = parseWarehouseTab(grid);
    expect(rows.map((r) => r.product)).toEqual(['лизин сульфат', 'сорбитол']);
    expect(rows[1]).toMatchObject({ qty: '24000', when: 'на этой неделе', fits: 'не влезет' });
  });
  it('dates only what is written; relative phrases get no date', () => {
    expect(approxWarehouseDate('на этой неделе', '2026-10-07')).toBeNull();
    expect(approxWarehouseDate('конец этой недели-след', '2026-10-07')).toBeNull();
    expect(approxWarehouseDate('на следующей неделе', '2026-10-07')).toBeNull();
    expect(approxWarehouseDate('12.10', '2026-10-07')).toEqual({ date: '2026-10-12', guessed: true });
    expect(approxWarehouseDate('когда-нибудь', '2026-10-07')).toBeNull();
    expect(approxWarehouseDate('16.01 в порт', '2026-10-08')).toEqual({ date: '2026-01-16', guessed: true });
  });
});

describe('trimGrid', () => {
  it('drops empty rows and trailing empty columns', () => {
    expect(trimGrid([['', 'Черноморськ', 'Гданськ', '', ''], ['', '', '', '', ''], ['море', '5950', '4700', '', '']])).toEqual([
      ['', 'Черноморськ', 'Гданськ'],
      ['море', '5950', '4700'],
    ]);
  });
});

describe('matchLogist', () => {
  const users = [
    { id: '1', name: 'Людмила Коваль' },
    { id: '2', name: 'Яна' },
    { id: '3', name: 'Артем' },
  ];
  it('matches by first name or a shared stem', () => {
    expect(matchLogist('Люда', users)?.id).toBe('1');
    expect(matchLogist('Яна', users)?.id).toBe('2');
    expect(matchLogist('Олег', users)).toBeNull();
    expect(matchLogist('', users)).toBeNull();
  });
});

describe('periodRange', () => {
  it('computes week / month windows in Kyiv dates', () => {
    expect(periodRange('week', TODAY)).toEqual(['2026-10-05', '2026-10-11']);
    expect(periodRange('next_week', TODAY)).toEqual(['2026-10-12', '2026-10-18']);
    expect(periodRange('month', TODAY)).toEqual(['2026-10-01', '2026-10-31']);
    expect(periodRange('next_month', '2026-12-03')).toEqual(['2027-01-01', '2027-01-31']);
    expect(periodRange('tomorrow', TODAY)).toEqual(['2026-10-10', '2026-10-10']);
  });
});

// ── Layout after the 2026-10 sheet edit: «Кол-во», two «Морская линия» columns,
//    a named «Логист» column, full dates. Synthetic data. ──────────────────────
import { cargoType, normalizeForwarder, pickTrackLink } from '../parse.js';

const HEADER2 = [
  '№ листа', '', 'Товар', 'Кто везет', 'Кол-во', 'Морская линия', '№ контейнер', '№ ТТН', 'Дата прибытия планируемая',
  'Место прибытия', 'Дата выхода', 'Место выхода', 'Морская Линия', 'Комментарий', 'Место растаможки', 'Склад выгрузки', 'Логист',
];
const row2 = (c: Record<number, string>) => HEADER2.map((_, i) => c[i] ?? '');

describe('new sheet layout', () => {
  const grid = [
    HEADER2,
    row2({ 2: 'Старий 2025', 3: 'мультикс', 8: '19.03.2025', 10: '27.01.2025', 12: 'https://www.maersk.com/tracking/MRSU6298959' }),
    row2({ 2: 'Сорбітол', 3: 'дсв', 4: '24 т', 5: 'MSC', 6: 'MSBU3441255', 8: '22.10.2026', 9: 'Гданськ', 10: '24.08.2026', 12: 'https://www.msc.com/en/track-a-shipment', 16: 'Яна' }),
    row2({ 2: 'Образцы аспирин', 3: 'ФЕДЕКС', 7: '875455189623', 8: '24.10.2026', 10: '15.10.2026', 12: 'https://www.fedex.com/fedextrack/?trknbr=875455189623' }),
    row2({ 2: 'Сборник Китай 24', 3: 'Мультикс', 9: 'Гданськ', 10: '10.10.2026', 12: 'https://www.searates.com/container/tracking/?number=TGHU1234567&sealine=CMDU' }),
  ];
  const rows = parseTrackingTab(grid, TODAY);

  it('finds the link column by content and the line-name column by header', () => {
    const cols = mapColumns(HEADER2, grid.slice(1));
    expect(cols.named.trackUrl).toBe(12);
    expect(cols.line).toBe(5);
    expect(cols.weight).toBe(4);
    expect(cols.logist).toBe(16);
  });

  it('reads line, quantity, logist and the number', () => {
    expect(rows[1]).toMatchObject({ line: 'MSC', weight: '24 т', logist: 'Яна', number: 'MSBU3441255', carrier: 'msc', forwarder: 'DSV', cargoType: 'fcl' });
  });

  it('flags a written year far from the working year as a likely typo', () => {
    const typo = parseTrackingTab([HEADER2, row2({ 2: 'Цефотаксим', 8: '03.09', 10: '28.08.2028' })], TODAY)[0]!;
    expect(typo.issues).toContain('date_suspicious');
    expect(rows[1]!.issues).not.toContain('date_suspicious');
  });

  it('keeps only rows of the working year in scope', () => {
    expect(rows[0]).toMatchObject({ inScope: false, active: false });
    expect(rows.slice(1).every((r) => r.inScope)).toBe(true);
  });

  it('prefers the sheet link unless it lacks the number', () => {
    expect(rows[2]!.trackLink).toBe('https://www.fedex.com/fedextrack/?trknbr=875455189623');
    expect(rows[1]!.trackLink).toContain('MSBU3441255'); // bare MSC page → carrier link with the number
  });

  it('classifies cargo type', () => {
    expect(rows[2]!.cargoType).toBe('samples');
    expect(rows[3]!.cargoType).toBe('groupage');
  });
});

describe('normalizeForwarder', () => {
  it('merges spellings and drops non-names', () => {
    expect(normalizeForwarder('мультикс', null)).toBe('Мультикс');
    expect(normalizeForwarder('еврофорвардинг', null)).toBe('Еврофорвард');
    expect(normalizeForwarder('Ксиоми/ДСВ', null)).toBe('Ксиоми / DSV');
    expect(normalizeForwarder('ДХЛ', null)).toBe('DHL');
    expect(normalizeForwarder('Мист на ТИ', null)).toBe('Мист');
    expect(normalizeForwarder('8843 2207 3047', null)).toBe('');
    expect(normalizeForwarder('', 'fedex')).toBe('FedEx');
    expect(normalizeForwarder('', 'msc')).toBe('');
  });
});

describe('cargoType', () => {
  it('uses keywords first, then the mode', () => {
    expect(cargoType('Образец хлорамфеникол', 'courier')).toBe('samples');
    expect(cargoType('Сборник Малайзия 6', 'sea')).toBe('groupage');
    expect(cargoType('Аллопуринол БХФЗ LCL', 'sea')).toBe('lcl');
    expect(cargoType('Цефиксим', 'air')).toBe('air');
    expect(cargoType('Спиносад', 'courier')).toBe('parcel');
    expect(cargoType('лизин сульфат 2 конт', null)).toBe('fcl');
    expect(cargoType('Висмут', null)).toBe('other');
  });
});

describe('pickTrackLink', () => {
  it('keeps a sheet link that carries the number, else builds one', () => {
    expect(pickTrackLink('https://x.test/?n=MSBU3441255', 'MSBU3441255', 'msc')).toBe('https://x.test/?n=MSBU3441255');
    expect(pickTrackLink('https://www.msc.com/en/track-a-shipment', 'MSBU3441255', 'msc')).toContain('MSBU3441255');
    expect(pickTrackLink('', '875455189623', 'fedex')).toContain('875455189623');
    expect(pickTrackLink('https://www.lufthansa-cargo.com/x', null, null)).toBe('https://www.lufthansa-cargo.com/x');
    expect(pickTrackLink('', null, null)).toBeNull();
  });
});
