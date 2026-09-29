// Shipment survey — a SHORT guided confirmation Штурман asks only for what the
// documents can't reliably infer. Auto-detection (contract_type, parties,
// Incoterms, origin) is persisted by the worker, so those questions are skipped
// when the field is already filled — a 10-question survey collapses to ~2-3.
// UA-only, following the repo convention of module-level maps (no i18n library).
//
// Answers persist DETERMINISTICALLY on the client: each question with an `intake`
// mapping is written straight to the workspace via PATCH /intake (using the
// machine `value` where the sidebar expects a slug), so the sidebar updates
// immediately. The agent turn is then advisory only (summary + priority).

export type SurveyStatus = "not_started" | "in_progress" | "completed" | "skipped";

// Persisted answers, keyed by question id → the question text + the chosen answer
// label. Stored in workspaces.survey_answers (JSONB) for resumability.
export type SurveyAnswers = Record<string, { question: string; answer: string }>;

// Workspace intake fields the survey can write directly.
export type SurveyIntakeField = "contract_type" | "transport_mode" | "product_category";

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
  /** Deterministic client-side persistence to a workspace intake field. */
  intake?: {
    field: SurveyIntakeField;
    /** Store the option's machine `value` (slug) or its human `label`. */
    use: "value" | "label";
    /** Option values that mean "leave unset" (e.g. "unknown" → keep auto). */
    skipValues?: string[];
  };
  /** Skip this card when the workspace already has this field set (autopilot). */
  skipIfFilled?: SurveyIntakeField;
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
    intake: { field: "contract_type", use: "value", skipValues: ["unknown", "other"] },
    skipIfFilled: "contract_type",
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
    intake: { field: "transport_mode", use: "value" },
    skipIfFilled: "transport_mode",
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
    intake: { field: "product_category", use: "label" },
    skipIfFilled: "product_category",
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
  },
];
