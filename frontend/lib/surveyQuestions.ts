// Shipment survey — the 10 guided questions Штурман asks to build a complete
// picture of a delivery (contract structure, invoicing, consignor/consignee,
// Incoterms, transport, product form, broker, priority). UA-only, following the
// repo convention of module-level label maps (no i18n library).
//
// The survey is CLIENT-DRIVEN: cards are shown one at a time in the chat thread,
// answers are collected locally, then submitted to the agent as a single normal
// chat message (see Chat.tsx). `feeds` documents which sidebar field / analysis
// decision each answer informs — it is not used at runtime.

export type SurveyStatus = "not_started" | "in_progress" | "completed" | "skipped";

// Persisted answers, keyed by question id → the question text + the chosen answer
// label. Stored in workspaces.survey_answers (JSONB) for resumability.
export type SurveyAnswers = Record<string, { question: string; answer: string }>;

export interface SurveyOption {
  value: string;
  label: string;
}

export interface SurveyQuestion {
  id: string;
  question: string;
  options: SurveyOption[];
  /** Allow a free-text "Інше…" answer. Defaults to true. */
  allowOther?: boolean;
  /** Which sidebar field / analysis-plan decision the answer feeds (documentation). */
  feeds?: string;
}

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  {
    id: "contract_structure",
    question: "Яка структура контракту цього постачання?",
    options: [
      { value: "bilateral", label: "Постачальник → AGroup95 (прямий імпорт)" },
      { value: "trilateral", label: "Постачальник → PrimeForce → AGroup95" },
      { value: "unknown", label: "Ще не знаю / визначити автоматично" },
    ],
    feeds: "contract_type (+ source=survey); 2-leg vs 1-leg analysis",
  },
  {
    id: "invoices_ag95",
    question: "Хто виставляє інвойс кінцевому покупцю (AGroup95)?",
    options: [
      { value: "manufacturer", label: "Виробник напряму" },
      { value: "trader", label: "Торговий постачальник (не виробник)" },
      { value: "primeforce", label: "PrimeForce" },
    ],
    feeds: "seller party; reinforces bilateral/trilateral",
  },
  {
    id: "consignor_consignee",
    question: "Хто вантажовідправник (consignor) і хто вантажоодержувач (consignee)?",
    options: [
      { value: "supplier_ag95", label: "Відправник — постачальник, одержувач — AGroup95" },
      { value: "supplier_prime", label: "Відправник — постачальник, одержувач — PrimeForce" },
      { value: "prime_ag95", label: "Відправник — PrimeForce, одержувач — AGroup95" },
    ],
    feeds: "parties slots; reconcile party axis",
  },
  {
    id: "payer",
    question: "Хто платник за товар / за перевезення?",
    options: [
      { value: "ag95_direct", label: "AGroup95 платить постачальнику напряму" },
      { value: "via_prime", label: "AGroup95 платить PrimeForce, Prime — постачальнику" },
      { value: "split", label: "Розділено (товар і перевезення окремо)" },
    ],
    feeds: "value-chain / markup logic; number of commercial layers",
  },
  {
    id: "price_differs",
    question:
      "Чи відрізняються ціни між наборами документів (Постачальник→Prime та Prime→AGroup95)?",
    options: [
      { value: "markup", label: "Так, є націнка (різні суми)" },
      { value: "same", label: "Ні, ціни однакові" },
      { value: "single_set", label: "Лише один набір документів" },
      { value: "unknown", label: "Не знаю" },
    ],
    feeds: "markup-expected branch in reconcile (suppresses false value-mismatch)",
  },
  {
    id: "incoterms",
    question: "Які умови постачання (Incoterms) і на якому плечі?",
    options: [
      { value: "single", label: "Одні умови на все постачання" },
      { value: "split", label: "Різні: вхідні (Supplier→Prime) та вихідні (Prime→AG95)" },
      { value: "unknown", label: "Ще не визначено" },
    ],
    feeds: "incoterm_in / incoterm_out; incoterm-split checks",
  },
  {
    id: "transport",
    question: "Який вид транспорту цього постачання?",
    options: [
      { value: "road", label: "Авто" },
      { value: "sea", label: "Море" },
      { value: "air", label: "Авіа" },
      { value: "rail", label: "Залізниця / комбінований" },
    ],
    feeds: "transport_mode; checklist transport docs",
  },
  {
    id: "product_form",
    question: "У якій формі товар? (за замовчуванням припускаємо «субстанція/АФІ»)",
    options: [
      { value: "substance", label: "Субстанція (АФІ)" },
      { value: "finished", label: "Готовий продукт" },
      { value: "in_bulk", label: "In-bulk / напівфабрикат" },
      { value: "equipment", label: "Обладнання / інше" },
    ],
    feeds: "product_category; HS-code path, required certs",
  },
  {
    id: "broker_forwarder",
    question: "Чи залучені брокер / експедитор?",
    options: [
      { value: "broker", label: "Митний брокер" },
      { value: "forwarder", label: "Транспортний експедитор" },
      { value: "both", label: "І брокер, і експедитор" },
      { value: "none", label: "Ні" },
    ],
    feeds: "extra parties roles; checklist (transit/forwarding docs)",
  },
  {
    id: "priority",
    question: "Що перевірити першочергово?",
    options: [
      { value: "completeness", label: "Комплектність документів" },
      { value: "discrepancies", label: "Розбіжності інвойс/пакувальний/контракт" },
      { value: "classification", label: "Класифікація УКТ ЗЕД / дозволи" },
      { value: "all", label: "Терміново — усе одразу" },
    ],
    feeds: "analysis-plan ordering; urgency/priority",
  },
];
