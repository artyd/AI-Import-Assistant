import { anthropic } from '../lib/anthropic/client.js';
import { runWithAnthropicLimit } from '../lib/anthropic/limiter.js';
import { config } from '../lib/config.js';
import { query } from '../db/pool.js';
import { loadFileMarkdown } from '../ingest/markdown/store.js';
import { OTHER_CATEGORIES, type OtherCategory } from '../shipments/folders.js';

/**
 * The «Інше» category of a paper that is not part of the customs package and
 * points to no lot (spec 007: nothing is left unfiled): a payment, a letter, a
 * permit, a table, a photo — or a file that could not be read. Decided once and
 * kept on the file (`files.other_category`).
 */
const KEYS = Object.keys(OTHER_CATEGORIES) as OtherCategory[];

export async function otherCategoryOf(file: { id: string; name: string; type: string }): Promise<OtherCategory> {
  const { rows } = await query<{ other_category: string | null; extraction_status: string | null; status: string }>(
    'SELECT other_category, extraction_status, status FROM files WHERE id = $1',
    [file.id],
  );
  const known = rows[0]?.other_category;
  if (known && (KEYS as string[]).includes(known)) return known as OtherCategory;

  const md = await loadFileMarkdown(file.id).catch(() => null);
  const text = md ? md.pages.map((p) => p.markdown).join('\n').trim() : '';
  let cat: OtherCategory;
  if (rows[0]?.status === 'error' || rows[0]?.extraction_status === 'unreadable' || (!text && file.type !== 'image')) cat = 'unread';
  else if (file.type === 'image' && text.length < 200) cat = 'photos';
  else if (file.type === 'xlsx' || file.type === 'csv') cat = 'tables';
  else cat = (await classifyOther(file.name, text).catch(() => null)) ?? (file.type === 'image' ? 'photos' : 'other');

  await query('UPDATE files SET other_category = $2 WHERE id = $1', [file.id, cat]);
  return cat;
}

/** One cheap Haiku call: which «Інше» sub-folder a non-customs paper belongs in. */
async function classifyOther(name: string, text: string): Promise<OtherCategory | null> {
  const msg = await runWithAnthropicLimit(() =>
    anthropic.messages.create({
      model: config.CLASSIFY_MODEL,
      // Adaptive thinking counts against max_tokens — leave room for the answer.
      max_tokens: 2000,
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content:
            'Це файл з пакета документів імпортної поставки, але не митний документ партії. ' +
            'Віднеси його до ОДНІЄЇ категорії й відповідай лише її ключем:\n' +
            'finance — рахунки, платіжки, акти, оплати послуг (брокер, перевізник, склад);\n' +
            'correspondence — листи, претензії, відповіді, листування;\n' +
            'permits — дозволи, реєстраційні посвідчення, ліцензії, довіреності, декларації виробника, ветеринарні/санітарні документи;\n' +
            'tables — таблиці, звіти, аналітика, розрахунки;\n' +
            'photos — фото, зображення без змістовного тексту;\n' +
            'other — усе інше.\n\n' +
            `Назва файлу: ${name}\n\n${text.slice(0, 6000)}`,
        },
      ],
    }),
  );
  const answer = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .toLowerCase();
  return KEYS.find((k) => k !== 'unread' && answer.includes(k)) ?? null;
}
