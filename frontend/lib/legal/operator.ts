/**
 * Operator details for the legal pages (/privacy, /terms) — the ONLY place to
 * fill them in. A value written as «[…]» is a placeholder: the pages show it
 * as is until the operator replaces it. `hasPlaceholders()` lists what is left.
 */
export const OPERATOR = {
  /** Повна назва юридичної особи / ФОП. */
  legalName: "[Назва юридичної особи]",
  /** Код ЄДРПОУ. */
  edrpou: "[Код ЄДРПОУ]",
  /** Юридична адреса. */
  address: "[Юридична адреса]",
  /** Пошта для запитів щодо персональних даних і з питань умов. */
  contactEmail: "[email для запитів щодо даних]",
  /** Де розташований сервер, на якому зберігаються файли й база даних. */
  serverLocation: "[Країна та місто розташування сервера]",
  /** Дата останньої редакції і набрання чинності. */
  effectiveDate: "[Дата редакції]",
  /** Строк зберігання технічних журналів (логів). */
  logRetention: "[не довше 30 днів]",
} as const;

export type OperatorField = keyof typeof OPERATOR;

/** A value still in «[…]» form has not been filled in. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return v.startsWith("[") && v.endsWith("]");
}

/** Names of the fields that are still placeholders. */
export function placeholderFields(): OperatorField[] {
  return (Object.keys(OPERATOR) as OperatorField[]).filter((k) => isPlaceholder(OPERATOR[k]));
}

export function hasPlaceholders(): boolean {
  return placeholderFields().length > 0;
}
