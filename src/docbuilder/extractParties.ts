import { anthropic } from '../lib/anthropic/client.js';
import { runWithAnthropicLimit } from '../lib/anthropic/limiter.js';
import { config } from '../lib/config.js';
import { convertToMarkdown } from '../ingest/markdown/convert.js';
import { inferFileType } from '../shipments/folders.js';
import { PARTY_ROLES, UNITS, partySchema, productSchema, type Party, type Product } from './schema.js';

/**
 * «Додати з документа»: an old contract / invoice the team already has → the
 * companies (with requisites, bank, signatory) and goods it states, as
 * candidates for the directory. Claude only copies what is written; the user
 * reviews every candidate before it is saved.
 */
export interface PartyCandidate extends Party {
  role: (typeof PARTY_ROLES)[number];
}

const str = { type: 'string' } as const;
const TOOL = {
  name: 'record_companies',
  description: 'Record every company and every product the document states, copying the text exactly as written.',
  input_schema: {
    type: 'object' as const,
    properties: {
      companies: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: [...PARTY_ROLES], description: 'seller (продавець/постачальник), buyer (покупець), consignee (вантажоодержувач), consignor (відправник/виробник), other' },
            nameEn: { ...str, description: 'Company name in English/Latin as written, e.g. "NOVOVETTEKH" LLC' },
            nameUk: { ...str, description: 'Company name in Ukrainian as written, e.g. ТОВ «НОВОВЕТТЕХ»; empty if absent' },
            countryEn: str,
            countryUk: str,
            signatoryEn: { ...str, description: 'Who signs, as written after "represented by"/"in person of", e.g. Director Abramova Alina' },
            signatoryUk: { ...str, description: 'Як написано після «в особі», напр. Директора Абрамової Аліни' },
            basisEn: { ...str, description: 'e.g. Statute, Memorandum of Association' },
            basisUk: { ...str, description: 'напр. Статуту' },
            addressEn: str,
            addressUk: str,
            requisitesEn: { ...str, description: 'Address, registration code, bank, SWIFT, IBAN/account, correspondent bank — one item per line, exactly as written (English column)' },
            requisitesUk: { ...str, description: 'The same block from the Ukrainian column, if the document has one' },
          },
          required: ['role', 'nameEn'],
        },
      },
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nameEn: str,
            nameUk: str,
            hs: { ...str, description: 'HS / УКТ ЗЕД code digits if stated' },
            reg: { ...str, description: 'Ukrainian registration (UA/xxxxx/xx/xx …) if stated' },
            manufacturer: str,
            countryEn: { ...str, description: 'Country of origin / manufacturer country' },
            countryUk: str,
            unit: { type: 'string', enum: [...UNITS] },
          },
          required: ['nameEn'],
        },
      },
    },
    required: ['companies', 'products'],
  },
};

const INSTRUCTION =
  'Це торговий документ (контракт, специфікація, інвойс, пакувальний лист). Витягни ВСІ компанії, які в ньому названі, ' +
  'і ВСІ товари. Копіюй текст рівно так, як написано — нічого не вигадуй і не перекладай сам: якщо української (або англійської) ' +
  'версії немає, залиш поле порожнім. Реквізити (адреса, код ЄДРПОУ/реєстраційний номер, банк, SWIFT, IBAN/рахунок, банк-кореспондент) ' +
  'переписуй построково. Роль визнач за текстом документа. Запиши результат інструментом record_companies.';

export async function extractCompanies(buf: Buffer, fileName: string): Promise<{ companies: PartyCandidate[]; products: Product[]; note: string | null }> {
  const conv = await convertToMarkdown(buf, inferFileType(fileName), fileName);
  const text = conv.pages.map((p) => p.markdown).join('\n\n').trim().slice(0, 80_000);
  if (!text) return { companies: [], products: [], note: conv.note ?? 'Документ не прочитався — спробуйте PDF або .docx.' };

  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await runWithAnthropicLimit(() =>
      anthropic.messages.create({
        model: config.EXTRACTION_MODEL,
        max_tokens: 16000,
        output_config: { effort: config.EXTRACTION_EFFORT },
        tools: [TOOL],
        // Forced tool_choice is a 400 on current models — steer with the prompt, retry once.
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: `${INSTRUCTION}\n\nФайл: ${fileName}\n\n${text}` }],
      }),
    );
    const block = msg.content.find((b) => b.type === 'tool_use');
    if (block && block.type === 'tool_use') {
      const input = block.input as { companies?: unknown[]; products?: unknown[] };
      const companies = (input.companies ?? []).flatMap((c) => {
        const p = partySchema.safeParse(c);
        const role = (c as { role?: string }).role;
        if (!p.success || !(p.data.nameEn || p.data.nameUk)) return [];
        return [{ ...p.data, role: (PARTY_ROLES as readonly string[]).includes(role ?? '') ? (role as PartyCandidate['role']) : 'other' }];
      });
      const products = (input.products ?? []).flatMap((x) => {
        const p = productSchema.safeParse(x);
        return p.success && (p.data.nameEn || p.data.nameUk) ? [p.data] : [];
      });
      return { companies, products, note: conv.partial ? 'Документ прочитано частково — перевірте реквізити.' : null };
    }
    if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'refusal') break;
  }
  return { companies: [], products: [], note: 'Не вдалося розпізнати компанії в документі.' };
}
