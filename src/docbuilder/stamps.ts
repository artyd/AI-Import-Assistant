import PizZip from 'pizzip';
import { query } from '../db/pool.js';
import type { DocKind, StampPlacement } from './schema.js';

/**
 * Seals and signatures on trade documents. The team uploads its stamp images
 * (PNG with a transparent background, one company may have several variants)
 * into a shared library (doc_stamps); a document lists where each one goes:
 * which stamp, which place, how big, and a fine shift. A template marks every
 * place with a `{stamp_<place>}` tag; on render the tag becomes a floating
 * picture over the text, like a real stamp pressed over the signature.
 */

/** The places a bundled template offers, per document kind, with the default shift (mm). */
export const STAMP_PLACES: Record<DocKind, { place: string; label: string; dx: number; dy: number }[]> = {
  contract: [
    { place: 'seller', label: 'Реквізити — Продавець', dx: 40, dy: 0 },
    { place: 'buyer', label: 'Реквізити — Покупець', dx: 40, dy: 0 },
    { place: 'spec_seller', label: 'Специфікація — Продавець', dx: 10, dy: 6 },
    { place: 'spec_buyer', label: 'Специфікація — Покупець', dx: 100, dy: 6 },
    { place: 'page_seller', label: 'Кожна сторінка — підпис Продавця', dx: 22, dy: -16 },
    { place: 'page_buyer', label: 'Кожна сторінка — підпис Покупця', dx: 128, dy: -16 },
  ],
  appendix: [
    { place: 'seller', label: 'Підпис Продавця', dx: 35, dy: -6 },
    { place: 'buyer', label: 'Підпис Покупця', dx: 35, dy: -6 },
    { place: 'page_seller', label: 'Кожна сторінка — підпис Продавця', dx: 22, dy: -16 },
    { place: 'page_buyer', label: 'Кожна сторінка — підпис Покупця', dx: 128, dy: -16 },
  ],
  invoice: [
    { place: 'invoice', label: 'Інвойс — внизу', dx: 25, dy: 0 },
    { place: 'packing', label: 'Пакувальний лист — внизу', dx: 25, dy: 0 },
  ],
  ua_invoice: [
    { place: 'seller', label: 'Підпис постачальника', dx: 40, dy: -10 },
    { place: 'buyer', label: 'Підпис отримувача (накладна)', dx: 40, dy: -10 },
  ],
};

export interface StampImage {
  id: string;
  mime: 'image/png' | 'image/jpeg';
  image: Buffer;
  width: number;
  height: number;
}

/** Pixel size and type of a PNG / JPEG, or null for anything else. */
export function imageInfo(buf: Buffer): { mime: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

const token = (n: number) => `§STAMP${n}§`;

/** `{stamp_<place>}` → the tokens of the stamps placed there ('' elsewhere, so the tag vanishes). */
export function stampTags(kind: DocKind, placements: StampPlacement[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const p of STAMP_PLACES[kind]) tags[`stamp_${p.place}`] = '';
  placements.forEach((p, n) => {
    const key = `stamp_${p.place}`;
    tags[key] = (tags[key] ?? '') + token(n);
  });
  return tags;
}

const EMU_PER_MM = 36000;
const emu = (mm: number) => Math.round(mm * EMU_PER_MM);
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Width, height, shift of a placed stamp, mm — also the preview's alt text («stamp:w:h:dx:dy»). */
export function stampBox(p: StampPlacement, img: Pick<StampImage, 'width' | 'height'>) {
  const w = p.size;
  const h = img.width > 0 ? (p.size * img.height) / img.width : p.size;
  return { w, h, dx: p.dx, dy: p.dy };
}

function drawingXml(n: number, rid: string, p: StampPlacement, img: StampImage): string {
  const b = stampBox(p, img);
  const cx = emu(b.w);
  const cy = emu(b.h);
  const id = 9100 + n;
  const alt = `stamp:${b.w.toFixed(1)}:${b.h.toFixed(1)}:${b.dx.toFixed(1)}:${b.dy.toFixed(1)}`;
  return (
    `<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251700000 + n}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="column"><wp:posOffset>${emu(b.dx)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${emu(b.dy)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="Stamp ${n + 1}" descr="${esc(alt)}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="stamp${n + 1}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:anchor></w:drawing>`
  );
}

/**
 * Turns the stamp tokens a filled document carries into floating pictures —
 * in the body and in headers / footers (a stamp in the footer repeats on every
 * page): the image goes into word/media, gets a relationship from the part
 * that shows it and a content type, and the token inside its <w:t> becomes a
 * <w:drawing> in the same run. A token whose stamp is missing just disappears.
 */
export function applyStamps(docx: Buffer, placements: StampPlacement[], images: Map<string, StampImage>): Buffer {
  const zip = new PizZip(docx);
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  const exts = new Set<string>();
  let touched = false;

  for (const part of parts) {
    let xml = zip.file(part)!.asText();
    if (!xml.includes('§STAMP')) continue;
    touched = true;
    const root = xml.match(/<w:(document|hdr|ftr) /)?.[0] ?? '<w:document ';
    if (!/xmlns:wp="/.test(xml.slice(0, 4000))) xml = xml.replace(root, `${root}xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" `);
    if (!/xmlns:r="/.test(xml.slice(0, 4000))) xml = xml.replace(root, `${root}xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `);

    const relsPath = part.replace(/^word\/(.*)$/, 'word/_rels/$1.rels');
    let rels =
      zip.file(relsPath)?.asText() ??
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const media = new Map<string, string>(); // stampId → rId within this part

    xml = xml.replace(/§STAMP(\d+)§/g, (_m, nRaw: string) => {
      const n = Number(nRaw);
      const p = placements[n];
      const img = p ? images.get(p.stampId) : undefined;
      if (!p || !img) return '';
      let rid = media.get(img.id);
      if (!rid) {
        rid = `rIdStamp${media.size + 1}`;
        const ext = img.mime === 'image/png' ? 'png' : 'jpeg';
        exts.add(ext);
        const target = `media/stamp_${img.id.slice(0, 8)}.${ext}`;
        zip.file(`word/${target}`, img.image);
        rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`);
        media.set(img.id, rid);
      }
      return `</w:t>${drawingXml(n, rid, p, img)}<w:t xml:space="preserve">`;
    });
    zip.file(part, xml);
    zip.file(relsPath, rels);
  }
  if (!touched) return docx;

  let types = zip.file('[Content_Types].xml')?.asText() ?? '';
  for (const ext of exts) {
    if (!new RegExp(`Extension="${ext}"`, 'i').test(types)) {
      types = types.replace('</Types>', `<Default Extension="${ext}" ContentType="image/${ext}"/></Types>`);
    }
  }
  zip.file('[Content_Types].xml', types);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The images a document's placements need, in one query. */
export async function loadStampImages(placements: StampPlacement[]): Promise<Map<string, StampImage>> {
  const ids = [...new Set(placements.map((p) => p.stampId))];
  if (!ids.length) return new Map();
  const { rows } = await query<{ id: string; mime: StampImage['mime']; image: Buffer; width: number; height: number }>(
    'SELECT id, mime, image, width, height FROM doc_stamps WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * mammoth renders a floating picture inline, where its anchor is. For the live
 * preview the stamp is lifted out of the flow and placed by its shift, scaled
 * by `--mm` (pixels per millimetre of the preview sheet, set by the page).
 */
export function positionPreviewStamps(html: string): string {
  let out = html.replace(/<img ([^>]*?)alt="stamp:([\d.-]+):([\d.-]+):([\d.-]+):([\d.-]+)"([^>]*)\/?>/g, (_m, a: string, w: string, _h: string, dx: string, dy: string, b: string) => {
    const mm = (v: string) => `calc(var(--mm, 2.6px) * ${Number(v)})`;
    return `<img ${a}${b} alt="" class="docb-stamp" style="position:absolute;left:${mm(dx)};top:${mm(dy)};width:${mm(w)};max-width:none;height:auto;pointer-events:none;z-index:2" />`;
  });
  // The paragraph that holds a stamp is its frame (like the column / paragraph in Word).
  out = out.replace(/<p>((?:(?!<\/p>).)*?class="docb-stamp")/gs, '<p style="position:relative">$1');
  return out;
}
