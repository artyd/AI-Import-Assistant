import { test, expect } from "@playwright/test";
import { mockWorkspace, sse, WSID } from "./mocks";

/**
 * «Не так» teaches Штурман: it asks what was wrong, the comment is POSTed as
 * feedback (the backend derives and stores a lesson), the lesson is shown, and the
 * corrected answer is requested at once as a new chat turn.
 */
const CHAT = `/api/workspaces/${WSID}/chat`;
const MSG = "11111111-2222-3333-4444-555555555555";

test("«Не так» → Штурман asks, learns, and re-answers", async ({ page }) => {
  const chatBodies: string[] = [];
  const feedback: unknown[] = [];
  await mockWorkspace(page, (route, pathname, method) => {
    if (pathname === CHAT && method === "POST") {
      chatBodies.push(route.request().postData() ?? "");
      const second = chatBodies.length > 1;
      void route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          { event: "token", data: { text: second ? "**Так, я пропустив ветсертифікат.**" : "**Пакет повний.**" } },
          {
            event: "done",
            data: {
              message: second ? "**Так, я пропустив ветсертифікат.**" : "**Пакет повний.**",
              citations: [],
              conversationId: "c1",
              messageId: second ? "66666666-2222-3333-4444-555555555555" : MSG,
            },
          },
        ]),
      });
      return true;
    }
    if (pathname === `/api/messages/${MSG}/feedback` && method === "POST") {
      const body = route.request().postDataJSON() as { rating: string; comment?: string };
      feedback.push(body);
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, feedbackId: "f1", lesson: body.comment ? { id: "l1", text: "Для кормових товарів перевіряй ветсертифікат", scope: "global" } : null }),
      });
      return true;
    }
    return false;
  });
  await page.goto(`/workspaces/${WSID}`);
  const input = page.getByTestId("chat-input");
  await input.fill("Перевір комплектність");
  await page.getByRole("button", { name: "Надіслати" }).click();
  await expect(page.getByText("Пакет повний.")).toBeVisible();

  await page.getByRole("button", { name: "Відповідь неправильна" }).click();
  await expect(page.getByText("Що не так у відповіді?")).toBeVisible();
  await page.getByPlaceholder(/ти не перевірив ветсертифікат/).fill("Товар кормовий — потрібен ветсертифікат");
  await page.getByRole("button", { name: "Надіслати й виправити" }).click();

  await expect(page.getByText(/Запамʼятав на майбутнє: «Для кормових товарів перевіряй ветсертифікат»/)).toBeVisible();
  await expect(page.getByText("Так, я пропустив ветсертифікат.")).toBeVisible();
  expect(feedback).toContainEqual({ rating: "down", comment: "Товар кормовий — потрібен ветсертифікат" });
  expect(chatBodies[1]).toContain("Відповідь вище неправильна. Що не так: Товар кормовий — потрібен ветсертифікат.");
});
