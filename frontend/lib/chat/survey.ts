import {
  SURVEY_QUESTIONS,
  type SurveyAnswers,
  type SurveyIntakeField,
  type SurveyQuestion,
} from "@/lib/surveyQuestions";

/** One answered survey question. */
export interface SurveyAnswer {
  id: string;
  question: string;
  label: string;
  value: string;
  q: SurveyQuestion;
}

/** Questions for this run — those whose intake field is already filled (autopilot) are skipped. */
export function activeQuestions(prefilled?: Partial<Record<SurveyIntakeField, boolean>>): SurveyQuestion[] {
  return SURVEY_QUESTIONS.filter((q) => !q.skipIfFilled || !prefilled?.[q.skipIfFilled]);
}

/** Record or replace the answer to one question. */
export function withAnswer(answers: SurveyAnswer[], a: SurveyAnswer): SurveyAnswer[] {
  return [...answers.filter((x) => x.id !== a.id), a];
}

/** The persisted form of the answers. */
export function answersRecord(answers: SurveyAnswer[]): SurveyAnswers {
  return Object.fromEntries(answers.map((a) => [a.id, { question: a.question, answer: a.label }]));
}

/** The deterministic intake patch from each question's `intake` mapping. */
export function intakePatch(answers: SurveyAnswer[]): Partial<Record<SurveyIntakeField, string>> {
  const patch: Partial<Record<SurveyIntakeField, string>> = {};
  for (const a of answers) {
    const m = a.q.intake;
    if (!m || a.value === "other") continue;
    if (m.skipValues?.includes(a.value)) continue;
    patch[m.field] = m.use === "value" ? a.value : a.label;
  }
  return patch;
}

/** The ONE chat message that hands every answer to the agent. */
export function surveyMessage(answers: SurveyAnswer[]): string {
  const lines = answers.map((a) => `• ${a.question}\n  → ${a.label}`).join("\n");
  return (
    "Я пройшов коротке опитування про постачання (дані вже збережено в картці постачання). " +
    "Ось відповіді — коротко підсумуй план перевірки з урахуванням пріоритету і що ще варто уточнити:\n\n" +
    lines
  );
}
