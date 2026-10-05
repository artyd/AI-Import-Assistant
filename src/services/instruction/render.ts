import type { InstructionDraft } from './types.js';

/**
 * Deterministic letter renderer (0 tokens). One block list feeds the plain
 * text (copy / e-mail), the DOCX and the PDF, so all formats say the same thing.
 * EN is the letter sent to the supplier; UK is the internal check version.
 */
export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'li'; text: string };

export type Lang = 'en' | 'uk';

const ph = (v: string, placeholder: string): string => (v.trim() ? v.trim() : `[${placeholder}]`);

const TRANSPORT_EN: Record<InstructionDraft['terms']['transport'], { mode: string; doc: string; after: string }> = {
  air: { mode: 'by air', doc: 'MAWB and HAWB', after: 'Please send the MAWB / HAWB and a copy of the export declaration right after shipment.' },
  sea: { mode: 'by sea', doc: 'Bill of Lading', after: 'Please provide the telex release of the Bill of Lading and a copy of the export declaration after shipment.' },
  road: { mode: 'by road', doc: 'CMR consignment note', after: 'Please send the CMR with the carrier’s stamp and a copy of the export declaration after shipment.' },
  multimodal: { mode: 'multimodal', doc: 'transport documents for every leg', after: 'Please send the transport documents of every leg and a copy of the export declaration after shipment.' },
};
const TRANSPORT_UK: Record<InstructionDraft['terms']['transport'], { mode: string; doc: string; after: string }> = {
  air: { mode: 'авіа', doc: 'MAWB і HAWB', after: 'Після відвантаження — MAWB/HAWB і копія експортної декларації.' },
  sea: { mode: 'море', doc: 'коносамент (B/L)', after: 'Після відвантаження — телекс-реліз коносамента і копія експортної декларації.' },
  road: { mode: 'авто', doc: 'CMR', after: 'Після відвантаження — CMR з відміткою перевізника і копія експортної декларації.' },
  multimodal: { mode: 'мультимодальний', doc: 'транспортні документи кожного плеча', after: 'Після відвантаження — документи кожного плеча і копія експортної декларації.' },
};

function productLine(d: InstructionDraft, lang: Lang): string {
  const p = d.product;
  const parts = [ph(p.name, lang === 'en' ? 'PRODUCT' : 'ТОВАР'), p.grade, p.cas && `CAS ${p.cas}`].filter(Boolean).join(', ');
  const qty = p.quantity.trim() ? ` ${p.quantity.trim()} ${p.unit}` : '';
  const hs = p.hsCode.trim() ? (lang === 'en' ? ` (HS code ${p.hsCode.trim()})` : ` (УКТ ЗЕД ${p.hsCode.trim()})`) : '';
  return `${parts}${qty ? `,${qty}` : ''}${hs}`;
}

const partyLines = (p: { name: string; address: string; country: string }, placeholder: string): string =>
  [ph(p.name, placeholder), [p.address, p.country].filter((x) => x.trim()).join(', ')].filter(Boolean).join('\n');

export function renderBlocks(d: InstructionDraft, lang: Lang): Block[] {
  const en = lang === 'en';
  const t = (en ? TRANSPORT_EN : TRANSPORT_UK)[d.terms.transport];
  const checkedDocs = d.docs.filter((x) => x.checked);
  const labels = d.labels.filter((x) => x.checked);
  const b: Block[] = [];
  const contractRef = d.contract.number.trim()
    ? `${d.contract.number.trim()}${d.contract.date.trim() ? (en ? ` dated ${d.contract.date.trim()}` : ` від ${d.contract.date.trim()}`) : ''}`
    : `[${en ? 'CONTRACT NO.' : '№ КОНТРАКТУ'}]`;
  const product = d.product.name.trim() || (en ? '[PRODUCT]' : '[ТОВАР]');
  const qty = d.product.quantity.trim() ? ` ${d.product.quantity.trim()} ${d.product.unit}` : '';

  b.push({
    kind: 'title',
    text: en
      ? `Shipping instructions — ${product}${qty} / Contract ${contractRef}`
      : `Інструкція з відвантаження — ${product}${qty} / контракт ${contractRef}`,
  });
  if (en) {
    b.push({ kind: 'p', text: 'Dear Sirs,' });
    b.push({ kind: 'p', text: `Please confirm our shipping instructions for ${productLine(d, 'en')}.` });
    b.push({ kind: 'p', text: 'All shipping documents must be issued in English. Names to be indicated in all documents and on the labels:' });
  } else {
    b.push({ kind: 'p', text: 'Внутрішня українська версія для перевірки — постачальнику не надсилається.' });
    b.push({ kind: 'p', text: `Просимо підтвердити інструкції для ${productLine(d, 'uk')}.` });
  }

  b.push({ kind: 'h', text: en ? '1) Consignor' : '1) Відправник' });
  b.push({ kind: 'p', text: partyLines(d.consignor, en ? 'CONSIGNOR' : 'ВІДПРАВНИК') });
  b.push({ kind: 'h', text: en ? '2) Consignee' : '2) Одержувач' });
  b.push({ kind: 'p', text: partyLines(d.consignee, en ? 'CONSIGNEE' : 'ОДЕРЖУВАЧ') });
  if (d.finalConsignee.trim()) {
    b.push({ kind: 'p', text: `${en ? 'Final consignee' : 'Кінцевий вантажоодержувач'}: ${d.finalConsignee.trim()}` });
  }

  const terms = [
    `${en ? 'Contract' : 'Контракт'}: ${contractRef}`,
    `${en ? 'Terms of delivery' : 'Умови поставки'}: ${ph(d.terms.incoterm, 'INCOTERMS')} ${ph(d.terms.place, en ? 'PLACE' : 'МІСЦЕ')}`,
    d.terms.destination.trim() && `${en ? 'Port / airport of destination' : 'Порт / аеропорт призначення'}: ${d.terms.destination.trim()}`,
    d.terms.finalDestination.trim() && `${en ? 'Final destination' : 'Кінцевий пункт'}: ${d.terms.finalDestination.trim()}`,
    `${en ? 'Mode of transport' : 'Вид транспорту'}: ${t.mode}`,
  ].filter((x): x is string => !!x);
  b.push({ kind: 'p', text: terms.join('\n') });
  if (d.product.regNumber.trim()) {
    b.push({
      kind: 'p',
      text: en
        ? `Ukrainian registration: ${d.product.regNumber.trim()} — must appear on the labels.`
        : `Реєстраційний номер ${d.product.regNumber.trim()} — обовʼязково на етикетці.`,
    });
  }

  b.push({ kind: 'h', text: en ? '3) Drafts for our approval before shipment' : '3) Чернетки на погодження до відвантаження' });
  b.push({
    kind: 'p',
    text: en
      ? 'Please do not stick labels on the goods and do not issue originals without our written confirmation:'
      : 'Не клеїти етикетки й не випускати оригінали без нашого письмового підтвердження:',
  });
  b.push({ kind: 'li', text: en ? 'Draft of the label' : 'Чернетка етикетки' });
  for (const x of checkedDocs) if (x.key !== 'insurance' && x.key !== 'export_decl') b.push({ kind: 'li', text: en ? x.label : x.labelUk || x.label });
  b.push({ kind: 'li', text: en ? `Draft of the ${t.doc}` : `Чернетка: ${t.doc}` });
  b.push({ kind: 'li', text: en ? 'Photos of the packages with labels before shipment' : 'Фото упаковок з етикетками до відвантаження' });

  b.push({ kind: 'h', text: en ? '4) Label content' : '4) Етикетка' });
  if (labels.length) for (const x of labels) b.push({ kind: 'li', text: en ? x.label : x.labelUk || x.label });
  else b.push({ kind: 'li', text: en ? '[add label fields]' : '[додайте поля етикетки]' });
  if (d.labelNotes.trim()) b.push({ kind: 'p', text: `${en ? 'Note' : 'Примітка'}: ${d.labelNotes.trim()}` });
  b.push({ kind: 'p', text: en ? 'The packages must be clean and undamaged.' : 'Упаковка має бути чистою й неушкодженою.' });

  b.push({ kind: 'h', text: en ? '5) After shipment' : '5) Після відвантаження' });
  b.push({ kind: 'p', text: t.after });
  if (checkedDocs.some((x) => x.key === 'insurance')) {
    b.push({ kind: 'p', text: en ? 'Please send the insurance policy as well.' : 'Також — страховий поліс.' });
  }

  b.push({ kind: 'h', text: en ? '6) Originals by courier, separately from the goods' : '6) Оригінали курʼєром, окремо від вантажу' });
  const originals = checkedDocs.filter((x) => ['coo', 'coa', 'invoice_pl', 'vet', 'phyto', 'insurance'].includes(x.key));
  for (const x of originals) {
    const wet = ['coo', 'coa', 'vet', 'phyto'].includes(x.key);
    b.push({ kind: 'li', text: en ? `${x.label}${wet ? ' (original, wet seal)' : ''}` : `${x.labelUk || x.label}${wet ? ' (оригінал з печаткою)' : ''}` });
  }
  const o = d.originals;
  b.push({
    kind: 'p',
    text: [
      `${en ? 'To' : 'Кому'}: ${ph(o.contact, en ? 'CONTACT' : 'КОНТАКТ')}, ${en ? 'tel.' : 'тел.'} ${ph(o.phone, en ? 'PHONE' : 'ТЕЛЕФОН')}`,
      ph(o.address, en ? 'DELIVERY ADDRESS' : 'АДРЕСА'),
    ].join('\n'),
  });

  if (d.extra.length) {
    b.push({ kind: 'h', text: en ? '7) Additional requirements' : '7) Додаткові вимоги' });
    for (const x of d.extra) b.push({ kind: 'p', text: en ? x.en : x.uk });
  }

  if (en) {
    b.push({ kind: 'p', text: 'Looking forward to your confirmation.\nKind regards,' });
    b.push({ kind: 'p', text: [d.from.signer, d.from.name].filter((x) => x.trim()).join('\n') || '[SIGNATURE]' });
  }
  return b;
}

export function blocksToText(blocks: Block[]): string {
  const out: string[] = [];
  for (const x of blocks) {
    if (x.kind === 'li') out.push(`- ${x.text}`);
    else {
      if (out.length) out.push('');
      out.push(x.text);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function renderText(d: InstructionDraft, lang: Lang): string {
  return blocksToText(renderBlocks(d, lang));
}

/** E-mail subject used by mailto and the DOCX/PDF title. */
export function letterSubject(d: InstructionDraft): string {
  const qty = d.product.quantity.trim() ? ` ${d.product.quantity.trim()} ${d.product.unit}` : '';
  return `Shipping instructions — ${d.product.name.trim() || 'product'}${qty}${d.contract.number.trim() ? ` / ${d.contract.number.trim()}` : ''}`;
}
