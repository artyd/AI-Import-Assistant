/**
 * «Запитати Штурмана» from the right sidebar: a sidebar button becomes a message
 * in the chat (the agent answers with its tools and the files), instead of a raw
 * result rendered under the sidebar. The sidebar dispatches; the workspace page
 * switches the chat to the right kind and hands the text to <Chat>, which sends
 * it like a typed message once it is free.
 */

export type AskKind = "supply" | "consolidated";
export interface AskDetail {
  text: string;
  kind: AskKind;
}

// One bus per app bundle (sidebar and page share the module).
const listeners = new Set<(d: AskDetail) => void>();

export function askInChat(text: string, kind: AskKind): void {
  const t = text.trim();
  if (!t) return;
  for (const l of [...listeners]) l({ text: t, kind });
}

/** Subscribe to sidebar questions; returns the unsubscribe. */
export function onAsk(handler: (d: AskDetail) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

// ── the questions ────────────────────────────────────────────────────────────

/** «партії «X»» for a lot, «збірника» for the whole FCL, «» for a shipment. */
export type AskScope = { kind: "shipment" } | { kind: "fcl" } | { kind: "lot"; name: string };

function of(scope: AskScope): string {
  return scope.kind === "lot" ? ` партії «${scope.name}»` : scope.kind === "fcl" ? " збірника" : "";
}

export const askPrompts = {
  check: (s: AskScope) =>
    s.kind === "shipment"
      ? "Що не так з документами? Перевір пакет повністю."
      : s.kind === "fcl"
        ? "Що не так зі збірником? Перевір контейнер і всі партії."
        : `Що не так з документами${of(s)}? Перевір партію повністю.`,
  completeness: (s: AskScope) => `Що з комплектністю${of(s)}? Чого бракує і де це взяти?`,
  discrepancies: (s: AskScope) =>
    `Які розбіжності між документами${of(s)}? Лише справжні проблеми, з файлами; примітки окремо одним рядком.`,
  risks: (s: AskScope) => `Які ризики${of(s) || " по цьому постачанню"} і що з ними робити?`,
  next: (s: AskScope) => `Що робити далі${of(s)}? Коротко, по кроках.`,
  manifest: () => "Звір маніфест збірника з інвойсами партій: кількості, ціни, позиції без інвойсу.",
  /** A finding from the sidebar → «is this a real problem?», checked against the files. */
  finding: (f: { title: string; values?: string | null; files?: string | null; lot?: string | null }) =>
    `Поясни знахідку автоперевірки: «${f.title}»${f.lot ? ` (партія «${f.lot}»)` : ""}` +
    (f.values ? ` — ${f.values}` : "") +
    (f.files ? ` (${f.files})` : "") +
    ". Це справжня проблема? Перевір у файлах і скажи, що зробити.",
  missing: (label: string, s: AskScope) =>
    `Бракує «${label}»${of(s)}. Чи він справді потрібен для цього постачання і в кого його запросити?`,
};
