import { z } from 'zod';

/**
 * Схема виводу AI — ТІЛЬКИ описові/класифікаційні поля.
 * Жодних грошей (мито/ПДВ/митна вартість) — їх рахує детермінований движок.
 * Кількість/ціна беруться з таблиці, не від AI.
 *
 * NOTE(B-1): це лише zod-схема типів; жодного виклику AI тут немає. Використовується
 * xlsx-експортом для типізації опційного блоку перевірок. Заповнення цих полів
 * (реальний виклик моделі) — B-2.
 */
export const CheckStatus = z.enum(['green', 'yellow', 'red']);

/** status лишаємо рядком (моделі бувають вільні) — нормалізуємо в UI. */
export const CheckItem = z.object({
  item: z.string(),
  status: z.string().default('yellow'),
  note: z.string().default(''),
});

export const AiItem = z.object({
  name: z.string(),
  suggestedUctzedCode: z.string().nullable().default(null),
  codeBasis: z.string().default(''),
  originType: z.string().nullable().default(null),
  productionMethod: z.string().nullable().default(null),
  originShortNote: z.string().default(''),
  category: z.string().default(''),
  applications: z.string().default(''),
  hazardAnalysis: z.string().default(''),
  storageRequirements: z.string().default(''),
  euChecks: z.array(CheckItem).default([]),
  uaChecks: z.array(CheckItem).default([]),
  risk: z.string().nullable().default(null),
  riskNote: z.string().default(''),
  /** true, якщо факту немає в CONTEXT — потребує перевірки людиною. */
  needsReview: z.boolean().default(false),
});
export type AiItem = z.infer<typeof AiItem>;

export const AiResponse = z.object({
  items: z.array(AiItem),
  criticalAlert: z.string().default(''),
  nctsList: z.array(z.string()).default([]),
});
export type AiResponse = z.infer<typeof AiResponse>;
