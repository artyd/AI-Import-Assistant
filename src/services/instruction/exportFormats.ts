import { AlignmentType, Document, Packer, Paragraph, TextRun, BorderStyle } from 'docx';
import { htmlToPdf } from '../pdf.js';
import { renderBlocks, letterSubject, type Block, type Lang } from './render.js';
import type { InstructionDraft } from './types.js';

/**
 * DOCX and PDF of the instruction letter — both built from the SAME block list
 * as the text, with the chosen group company as letterhead.
 */
const esc = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function runs(text: string, opts: { bold?: boolean; size?: number } = {}): TextRun[] {
  return text.split('\n').map((line, i) => new TextRun({ text: line, bold: opts.bold, size: opts.size, break: i > 0 ? 1 : undefined }));
}

export async function instructionDocx(d: InstructionDraft, lang: Lang): Promise<Buffer> {
  const head: Paragraph[] = [];
  if (d.from.name.trim()) {
    head.push(new Paragraph({ children: runs(d.from.name, { bold: true, size: 26 }) }));
    const sub = [d.from.address, [d.from.phone, d.from.email].filter(Boolean).join(' · ')].filter((x) => x.trim()).join('\n');
    if (sub) head.push(new Paragraph({ children: runs(sub, { size: 18 }) }));
    head.push(
      new Paragraph({
        border: { bottom: { color: '2F6FEB', space: 4, style: BorderStyle.SINGLE, size: 8 } },
        children: [],
        spacing: { after: 240 },
      }),
    );
  }
  const body = renderBlocks(d, lang).map((b: Block) => {
    switch (b.kind) {
      case 'title':
        return new Paragraph({ children: runs(b.text, { bold: true, size: 26 }), spacing: { after: 200 } });
      case 'h':
        return new Paragraph({ children: runs(b.text, { bold: true }), spacing: { before: 200, after: 60 } });
      case 'li':
        return new Paragraph({ children: runs(b.text), bullet: { level: 0 } });
      default:
        return new Paragraph({ children: runs(b.text), spacing: { after: 120 } });
    }
  });
  const doc = new Document({
    title: letterSubject(d),
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: [...head, ...body] }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export function instructionHtml(d: InstructionDraft, lang: Lang): string {
  const body = renderBlocks(d, lang)
    .reduce<string[]>((acc, b, i, all) => {
      const prev = all[i - 1];
      if (b.kind === 'li' && prev?.kind !== 'li') acc.push('<ul>');
      if (b.kind !== 'li' && prev?.kind === 'li') acc.push('</ul>');
      const t = esc(b.text).replace(/\n/g, '<br>');
      acc.push(b.kind === 'title' ? `<h1>${t}</h1>` : b.kind === 'h' ? `<h2>${t}</h2>` : b.kind === 'li' ? `<li>${t}</li>` : `<p>${t}</p>`);
      if (i === all.length - 1 && b.kind === 'li') acc.push('</ul>');
      return acc;
    }, [])
    .join('');
  const contacts = [d.from.address, d.from.phone, d.from.email].filter((x) => x.trim()).map(esc).join(' · ');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(letterSubject(d))}</title>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:16mm 18mm}
body{font-family:"Hanken Grotesk",system-ui,"Segoe UI",Arial,sans-serif;color:#0d0d0f;font-size:11.5pt;line-height:1.5;margin:0}
.lh{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #2f6feb;padding-bottom:8px;margin-bottom:18px}
.lh b{font-size:15pt;font-weight:800}.lh span{color:#8b8b94;font-size:9pt;display:block;margin-top:2px}
.lh i{font-style:normal;color:#8b8b94;font-size:8.5pt}
h1{font-size:13.5pt;margin:0 0 12px}h2{font-size:11.5pt;margin:14px 0 4px}p{margin:0 0 8px}ul{margin:0 0 8px;padding-left:20px}
</style></head><body>
${d.from.name.trim() ? `<div class="lh"><div><b>${esc(d.from.name)}</b>${contacts ? `<span>${contacts}</span>` : ''}</div><i>${new Date().toLocaleDateString('uk-UA')}</i></div>` : ''}
${body}</body></html>`;
}

export function instructionPdf(d: InstructionDraft, lang: Lang): Promise<Buffer> {
  return htmlToPdf(instructionHtml(d, lang));
}
