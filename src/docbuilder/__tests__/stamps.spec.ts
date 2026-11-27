import { describe, expect, it } from 'vitest';
import mammoth from 'mammoth';
import PizZip from 'pizzip';
import { DOC_KINDS, parseData } from '../schema.js';
import { bundledTemplate, fillTemplate } from '../render.js';
import { tagsFor } from '../templateData.js';
import { sampleData } from '../sample.js';
import { STAMP_PLACES, applyStamps, imageInfo, positionPreviewStamps, stampTags, type StampImage } from '../stamps.js';

// A 2×1 transparent PNG — a stand-in for a seal (real seals never go in the repo).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAC0lEQVR4nGNgQAcAAAkAAX6+xNEAAAAASUVORK5CYII=',
  'base64',
);
const STAMP_ID = '11111111-1111-4111-8111-111111111111';
const images = new Map<string, StampImage>([[STAMP_ID, { id: STAMP_ID, mime: 'image/png', image: PNG, width: 2, height: 1 }]]);

describe('stamp images', () => {
  it('reads the size of a PNG and refuses other files', () => {
    expect(imageInfo(PNG)).toEqual({ mime: 'image/png', width: 2, height: 1 });
    expect(imageInfo(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('stamp places in the bundled templates', () => {
  for (const kind of DOC_KINDS) {
    it(`${kind}: every place has its {stamp_…} tag and empty places leave no trace`, async () => {
      const tpl = await bundledTemplate(kind);
      const zip = new PizZip(tpl);
      const xml = Object.keys(zip.files)
        .filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
        .map((n) => zip.file(n)!.asText())
        .join('');
      for (const p of STAMP_PLACES[kind]) expect(xml).toContain(`{stamp_${p.place}}`);
      const out = fillTemplate(tpl, { ...tagsFor(kind, sampleData(kind)), ...stampTags(kind, []) });
      const text = (await mammoth.extractRawText({ buffer: out })).value;
      expect(text).not.toMatch(/stamp_|§/i);
    });
  }
});

describe('placing a stamp', () => {
  it('turns the tag into a floating picture with its relationship and content type', async () => {
    const kind = 'contract' as const;
    const data = parseData(kind, { ...sampleData(kind), stamps: [{ stampId: STAMP_ID, place: 'seller', size: 40, dx: 12, dy: -5 }] });
    expect(data.stamps).toHaveLength(1);
    const filled = fillTemplate(await bundledTemplate(kind), { ...tagsFor(kind, data), ...stampTags(kind, data.stamps) });
    const out = applyStamps(filled, data.stamps, images);
    const zip = new PizZip(out);
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).not.toContain('§STAMP');
    expect(xml.match(/<wp:anchor /g)).toHaveLength(1);
    expect(xml).toContain('<wp:extent cx="1440000" cy="720000"/>'); // 40 mm wide, half as tall
    expect(xml).toContain('<wp:posOffset>432000</wp:posOffset>'); // dx 12 mm
    expect(xml).toContain('<wp:posOffset>-180000</wp:posOffset>'); // dy −5 mm
    expect(zip.file('word/_rels/document.xml.rels')!.asText()).toMatch(/Id="rIdStamp1"[^>]*Target="media\/stamp_11111111\.png"/);
    expect(zip.file('word/media/stamp_11111111.png')).toBeTruthy();
    expect(zip.file('[Content_Types].xml')!.asText()).toMatch(/Extension="png"/i);

    // The preview shows it, lifted out of the text flow.
    const { value } = await mammoth.convertToHtml({ buffer: out });
    const html = positionPreviewStamps(value);
    expect(html).toContain('class="docb-stamp"');
    expect(html).toContain('<p style="position:relative">');
    expect(html).toContain('width:calc(var(--mm, 2.6px) * 40)');
  });

  it('drops a stamp whose picture was deleted, and stacks two stamps on one place', async () => {
    const kind = 'appendix' as const;
    const ghost = '22222222-2222-4222-8222-222222222222';
    const stamps = parseData(kind, { stamps: [{ stampId: ghost, place: 'seller' }, { stampId: STAMP_ID, place: 'seller' }, { stampId: STAMP_ID, place: 'buyer' }] }).stamps;
    expect(stampTags(kind, stamps).stamp_seller).toBe('§STAMP0§§STAMP1§');
    const filled = fillTemplate(await bundledTemplate(kind), { ...tagsFor(kind, sampleData(kind)), ...stampTags(kind, stamps) });
    const xml = new PizZip(applyStamps(filled, stamps, images)).file('word/document.xml')!.asText();
    expect(xml.match(/<wp:anchor /g)).toHaveLength(2);
    expect(xml.match(/r:embed="rIdStamp1"/g)).toHaveLength(2); // one image part, used twice
  });

  it('keeps bad placements out', () => {
    const d = parseData('invoice', { stamps: [{ stampId: 'nope', place: 'invoice' }] });
    expect(d.stamps).toEqual([]);
    const ok = parseData('invoice', { stamps: [{ stampId: STAMP_ID, place: 'invoice', size: 999 }] });
    expect(ok.stamps[0]!.size).toBe(38);
  });
});

describe('stamps on every page', () => {
  it('a footer stamp lands in the footer with a relationship of its own', async () => {
    const kind = 'contract' as const;
    const stamps = parseData(kind, { stamps: [{ stampId: STAMP_ID, place: 'page_seller' }] }).stamps;
    const filled = fillTemplate(await bundledTemplate(kind), { ...tagsFor(kind, sampleData(kind)), ...stampTags(kind, stamps) });
    const zip = new PizZip(applyStamps(filled, stamps, images));
    const footer = Object.keys(zip.files).find((n) => /^word\/footer\d*\.xml$/.test(n) && zip.file(n)!.asText().includes('<wp:anchor'));
    expect(footer).toBeTruthy();
    expect(zip.file(footer!.replace('word/', 'word/_rels/') + '.rels')!.asText()).toContain('rIdStamp1');
    expect(zip.file('word/document.xml')!.asText()).not.toContain('<wp:anchor');
  });

  it('the invoice letterhead seal steps aside when an own stamp is placed on the invoice', () => {
    const d = parseData('invoice', { ...sampleData('invoice'), stamp: true, stamps: [{ stampId: STAMP_ID, place: 'invoice' }] });
    expect(tagsFor('invoice', d).stamp).toBe(false);
    expect(tagsFor('invoice', { ...d, stamps: [] }).stamp).toBe(true);
  });
});
