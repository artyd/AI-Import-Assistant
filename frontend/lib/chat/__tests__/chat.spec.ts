import { describe, expect, it, vi } from "vitest";
import { initialTurn, runTurn, turnContent, turnReducer, type TurnEvent, type TurnState } from "../turn";
import { activeQuestions, answersRecord, intakePatch, surveyMessage, withAnswer } from "../survey";
import { SURVEY_QUESTIONS } from "@/lib/surveyQuestions";

const play = (events: TurnEvent[]): TurnState => events.reduce(turnReducer, initialTurn);
const done = { message: "", citations: [], conversationId: "c1", messageId: "m1" } as never;

describe("chat turn", () => {
  it("tokens accumulate; done prefers the server's final message", () => {
    const s = play([{ type: "token", text: "При" }, { type: "token", text: "віт" }]);
    expect(turnContent(s)).toBe("Привіт");
    expect(turnContent(turnReducer(s, { type: "done", done: { ...(done as object), message: "Фінал" } as never }))).toBe("Фінал");
    expect(turnContent(turnReducer(s, { type: "done", done }))).toBe("Привіт");
  });

  it("an error keeps the partial text and adds the reason", () => {
    expect(turnContent(play([{ type: "token", text: "Част" }, { type: "error", message: "Ліміт" }]))).toBe("Част\n\n⚠️ Ліміт");
    expect(turnContent(play([{ type: "error", message: "Ліміт" }]))).toBe("⚠️ Ліміт");
  });

  it("stopping keeps what arrived; a failed request says so", () => {
    expect(turnContent(play([{ type: "token", text: "Так" }, { type: "aborted" }]))).toBe("Так\n\n⏹ Відповідь зупинено.");
    expect(turnContent(play([{ type: "failed" }]))).toBe("⚠️ Помилка з’єднання з сервером.");
  });

  it("terminal states are final; tools are recorded", () => {
    const s = play([{ type: "tool_call", tool: "read_file" }, { type: "done", done }, { type: "token", text: "late" }, { type: "aborted" }]);
    expect(s.phase).toBe("done");
    expect(s.tools).toEqual(["read_file"]);
  });

  it("runTurn drives the reducer from the SSE stream and reports a network failure", async () => {
    vi.resetModules();
    vi.doMock("@/lib/sse", () => ({
      streamChat: async (_p: string, _b: unknown, h: { onToken: (e: { text: string }) => void; onDone: (e: unknown) => void }) => {
        h.onToken({ text: "А" });
        h.onDone(done);
      },
    }));
    const { runTurn: run } = await import("../turn");
    const updates: string[] = [];
    const final = await run("/x", { message: "m" }, { onUpdate: (t) => updates.push(t.phase) }, new AbortController().signal);
    expect(final.phase).toBe("done");
    expect(updates).toEqual(["streaming", "done"]);
    vi.doUnmock("@/lib/sse");
  });

  it("a thrown stream is a failed turn, an aborted one is stopped", async () => {
    vi.resetModules();
    vi.doMock("@/lib/sse", () => ({ streamChat: async () => { throw new Error("net"); } }));
    const { runTurn: run } = await import("../turn");
    expect((await run("/x", { message: "m" }, { onUpdate: () => {} }, new AbortController().signal)).phase).toBe("failed");
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await run("/x", { message: "m" }, { onUpdate: () => {} }, ctrl.signal)).phase).toBe("aborted");
    vi.doUnmock("@/lib/sse");
  });

  it("exports runTurn", () => expect(typeof runTurn).toBe("function"));
});

describe("survey", () => {
  const q = SURVEY_QUESTIONS.find((x) => x.intake)!;
  const opt = q.options.find((o) => o.value !== "other")!;
  const a = { id: q.id, question: q.question, label: opt.label, value: opt.value, q };

  it("skips questions whose field the autopilot already filled", () => {
    const field = SURVEY_QUESTIONS.find((x) => x.skipIfFilled)!.skipIfFilled!;
    expect(activeQuestions({ [field]: true }).length).toBeLessThan(SURVEY_QUESTIONS.length);
    expect(activeQuestions()).toHaveLength(SURVEY_QUESTIONS.length);
  });

  it("a re-answer replaces the previous one", () => {
    expect(withAnswer([a], { ...a, label: "інше" })).toHaveLength(1);
  });

  it("answers → record, intake patch and one message", () => {
    expect(answersRecord([a])).toEqual({ [q.id]: { question: q.question, answer: opt.label } });
    const patch = intakePatch([a]);
    expect(patch[q.intake!.field]).toBe(q.intake!.use === "value" ? opt.value : opt.label);
    expect(intakePatch([{ ...a, value: "other" }])).toEqual({});
    expect(surveyMessage([a])).toContain(`• ${q.question}\n  → ${opt.label}`);
  });
});
