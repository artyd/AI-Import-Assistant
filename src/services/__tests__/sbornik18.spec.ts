import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../config.js', () => ({ config: {} }));

// Regressions from the live test on «Сборник 18 Китай» (196 files, 2026-10-06).

describe('decodeEntryName (zip names from non-UTF-8 Windows)', () => {
  it('decodes a GBK-encoded Cyrillic letter from a Chinese archive', async () => {
    const { decodeEntryName } = await import('../zip.js');
    // "Label of DL-АSPARTIC" — Cyrillic «А» stored in GBK as A7 A1.
    const buf = Buffer.concat([Buffer.from('Label of DL-'), Buffer.from([0xa7, 0xa1]), Buffer.from('SPARTIC.docx')]);
    expect(decodeEntryName({ path: buf.toString('utf8'), pathBuffer: buf, isUnicode: 0 })).toBe('Label of DL-АSPARTIC.docx');
  });

  it('decodes a Chinese GBK name', async () => {
    const { decodeEntryName } = await import('../zip.js');
    const buf = Buffer.from(new Uint8Array([0xb0, 0xb1, 0xcc, 0xc7, 0x2e, 0x64, 0x6f, 0x63])); // 氨糖.doc
    expect(decodeEntryName({ path: '', pathBuffer: buf, isUnicode: 0 })).toBe('氨糖.doc');
  });

  it('decodes a CP866 Russian name from a Russian/Ukrainian archiver', async () => {
    const { decodeEntryName } = await import('../zip.js');
    const buf = Buffer.from([0x91, 0xe7, 0xa5, 0xe2, 0x2e, 0x70, 0x64, 0x66]); // Счет.pdf
    expect(decodeEntryName({ path: '', pathBuffer: buf, isUnicode: 0 })).toBe('Счет.pdf');
  });

  it('keeps UTF-8 and flagged names as they are', async () => {
    const { decodeEntryName } = await import('../zip.js');
    const buf = Buffer.from('Інвойс.pdf', 'utf8');
    expect(decodeEntryName({ path: 'Інвойс.pdf', pathBuffer: buf, isUnicode: 0 })).toBe('Інвойс.pdf');
    expect(decodeEntryName({ path: 'plain.pdf', pathBuffer: Buffer.from('plain.pdf'), isUnicode: 1 })).toBe('plain.pdf');
  });
});

describe('classifyByFilename', () => {
  it('does not take CHED-P for a packing list because of «.PL.»', async () => {
    const { classifyByFilename } = await import('../classify.js');
    expect(classifyByFilename('CHEDP.PL.2026.0004620.pdf')).toBe('veterinary');
    expect(classifyByFilename('CHEDP.PL.2026.0004620 NOWY.pdf')).toBe('veterinary');
  });

  it('files vet statements, instructions and labels', async () => {
    const { classifyByFilename } = await import('../classify.js');
    expect(classifyByFilename('STATEMENT from Rivita.pdf')).toBe('veterinary');
    expect(classifyByFilename('HSNutra_BSE_Declaration_EN_PL.pdf')).toBe('veterinary');
    expect(classifyByFilename('deklaracja na produkty pośrednie rozdz.20 zał. XV.pdf')).toBe('veterinary');
    expect(classifyByFilename('инструкции парацетамол для Черв Зирка.doc')).toBe('instruction');
    expect(classifyByFilename('Label 10kg Ceftiofur HCl-01425110302-carton.pdf')).toBe('label');
    expect(classifyByFilename('PEG маркировка.pdf')).toBe('label');
    expect(classifyByFilename('Reiestratsiine_posvidchennia_ARTROLIK (вит С).pdf')).toBe('veterinary');
    expect(classifyByFilename('CMR shipping label.pdf')).toBe('transport'); // specific beats generic
  });

  it('keeps the existing rules', async () => {
    const { classifyByFilename } = await import('../classify.js');
    expect(classifyByFilename('Packing List-JLIN251215.pdf')).toBe('packing_list');
    expect(classifyByFilename('CMR Новалайт.pdf')).toBe('transport');
    expect(classifyByFilename('Scheduled report.pdf')).toBeNull(); // 'ched' only as a whole word
  });
});

describe('versionHints', () => {
  it('flags drafts, copies, telex releases and translations', async () => {
    const { versionHints } = await import('../fileHints.js');
    expect(versionHints('Draft CO.pdf')).toContain('чернетка/draft');
    expect(versionHints('HBL-D (9).pdf', 'BILL OF LADING ... COPY ...')).toEqual(
      expect.arrayContaining(['копія (COPY)', expect.stringContaining('повторне завантаження')]),
    );
    expect(versionHints('HBL-D TELEX (2) (1).pdf', 'TLX RELEASE')).toContain('telex release (фінальний коносамент)');
    expect(versionHints('переклад_CHEDP_Декларація_UA.docx')).toContain('переклад (не оригінал)');
    expect(versionHints('CO Original.pdf', 'ISSUED RETROSPECTIVELY')).toEqual(
      expect.arrayContaining(['фінальна/оригінал', 'видано заднім числом (ISSUED RETROSPECTIVELY)']),
    );
    expect(versionHints('Commercial Invoice.pdf', 'COMMERCIAL INVOICE')).toEqual([]);
    expect(versionHints('HBL-A TELEX.pdf', 'NON-NEGOTIABLE COPY ... TLX RELEASE')).not.toContain('копія (COPY)');
    expect(versionHints('проект контракту.docx')).toContain('чернетка/draft');
    expect(versionHints('designed_layout.pdf')).toEqual([]);
  });

  it('groups same-named files', async () => {
    const { baseNameKey } = await import('../fileHints.js');
    expect(baseNameKey('HBL-E TELEX (2) (1).pdf')).toBe(baseNameKey('HBL-E TELEX.pdf'));
  });
});

describe('pdfProvenance', () => {
  it('warns when a PDF was re-saved long after it was created', async () => {
    const { pdfProvenance } = await import('../fileHints.js');
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setCreationDate(new Date('2026-01-19T10:06:28Z'));
    doc.setModificationDate(new Date('2026-03-12T09:24:00Z'));
    doc.setProducer('Microsoft: Print To PDF');
    const buf = Buffer.from(await doc.save({ updateFieldAppearances: false }));
    const p = await pdfProvenance(buf);
    expect(p?.warning).toMatch(/змінено через \d+ дн/);
    expect(p?.producer).toBe('Microsoft: Print To PDF');
  });

  it('returns null for a non-PDF buffer', async () => {
    const { pdfProvenance } = await import('../fileHints.js');
    expect(await pdfProvenance(Buffer.from('not a pdf'))).toBeNull();
  });
});

describe('NUL characters never reach PostgreSQL (lost chat turns)', () => {
  it('cleans scanner-padded PDF metadata and drops encrypted garbage', async () => {
    const { cleanMeta } = await import('../fileHints.js');
    expect(cleanMeta('Canon MF410 Series / Adobe PSL 1.4e for Canon\u0000')).toBe('Canon MF410 Series / Adobe PSL 1.4e for Canon');
    expect(cleanMeta('r3Ö¼ˇÏt�ùcÔ•ø.ð?Eﬁùèï†ÈµlŽ¾²(ñë⁄Êt\u0013Ú!\u0010„³ˆ-=H²')).toBeUndefined();
    expect(cleanMeta('Microsoft® Word 2016')).toBe('Microsoft® Word 2016');
  });

  it('strips NUL from every string of a turn before it is stored', async () => {
    const { stripNul } = await import('../conversations.js');
    const nul = String.fromCharCode(0);
    const blocks = [{ role: 'user', content: [{ type: 'tool_result', content: 'Метадані PDF: Canon' + nul }] }];
    const out = JSON.stringify(stripNul(blocks));
    expect(out.includes(String.fromCharCode(92) + 'u0000')).toBe(false); // no escaped NUL in the stored JSON
    expect(JSON.parse(out)[0].content[0].content).toBe('Метадані PDF: Canon');
  });
});
