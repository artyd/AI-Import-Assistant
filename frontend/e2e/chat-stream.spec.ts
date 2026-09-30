import { test, expect } from "@playwright/test";
import { mockWorkspace, sse, WSID } from "./mocks";

/**
 * Chat streaming (SSE-over-POST) with the backend mocked: tokens accumulate,
 * `done` completes the turn, an `error` event / HTTP error shows a Ukrainian
 * message (never a raw code), a stream without `done` is reported as
 * interrupted, and «Зупинити» aborts an in-flight answer.
 */
const CHAT = `/api/workspaces/${WSID}/chat`;

async function ask(page: import("@playwright/test").Page, text: string) {
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();
  await input.fill(text);
  await page.getByRole("button", { name: "Надіслати" }).click();
}

test.describe("Chat streaming", () => {
  test("tokens accumulate, tool events log, done completes the turn", async ({ page }) => {
    await mockWorkspace(page, (route, pathname, method) => {
      if (pathname === CHAT && method === "POST") {
        void route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            sse([
              { event: "token", data: { text: "Привіт, " } },
              { event: "tool_call", data: { tool: "get_checklist", input: {} } },
              { event: "tool_result", data: { tool: "get_checklist", summary: "Чекліст отримано" } },
              { event: "token", data: { text: "пакет повний." } },
            ]) +
            ": ping\n\n" +
            sse([
              {
                event: "done",
                data: {
                  message: "Привіт, пакет повний.",
                  citations: [{ file: "invoice.pdf", page: 2 }],
                  conversationId: "c1",
                  messageId: "m1",
                },
              },
            ]),
        });
        return true;
      }
      return false;
    });
    await page.goto(`/workspaces/${WSID}`);
    await ask(page, "Перевір комплектність");

    await expect(page.getByText("Привіт, пакет повний.")).toBeVisible();
    await expect(page.getByText("invoice.pdf · с.2")).toBeVisible();
    // Turn completed → the send button is back (no stop button).
    await expect(page.getByTestId("chat-stop")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toHaveValue("");
  });

  test("an error event shows a Ukrainian message instead of the raw code", async ({ page }) => {
    await mockWorkspace(page, (route, pathname, method) => {
      if (pathname === CHAT && method === "POST") {
        void route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sse([
            { event: "token", data: { text: "Частина" } },
            { event: "error", data: { message: "rate_limited" } },
          ]),
        });
        return true;
      }
      return false;
    });
    await page.goto(`/workspaces/${WSID}`);
    await ask(page, "Питання");

    await expect(page.getByText(/Забагато запитів — зачекайте хвилину/)).toBeVisible();
    await expect(page.getByText("rate_limited")).toHaveCount(0);
    await expect(page.getByText(/З’єднання перервано/)).toHaveCount(0);
  });

  test("an HTTP 429 maps to the Ukrainian rate-limit message", async ({ page }) => {
    await mockWorkspace(page, (route, pathname, method) => {
      if (pathname === CHAT && method === "POST") {
        void route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({ statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" }),
        });
        return true;
      }
      return false;
    });
    await page.goto(`/workspaces/${WSID}`);
    await ask(page, "Питання");
    await expect(page.getByText(/Забагато запитів — зачекайте хвилину/)).toBeVisible();
    await expect(page.getByText(/Rate limit exceeded/)).toHaveCount(0);
  });

  test("a stream that ends without done/error is reported as interrupted", async ({ page }) => {
    await mockWorkspace(page, (route, pathname, method) => {
      if (pathname === CHAT && method === "POST") {
        void route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sse([{ event: "token", data: { text: "Незавершена відповідь" } }]),
        });
        return true;
      }
      return false;
    });
    await page.goto(`/workspaces/${WSID}`);
    await ask(page, "Питання");

    await expect(page.getByText("Незавершена відповідь")).toBeVisible();
    await expect(
      page.getByText("З’єднання перервано. Відповідь може бути неповною.")
    ).toBeVisible();
  });

  test("the stop button aborts an in-flight answer", async ({ page }) => {
    let chatRequested = false;
    await mockWorkspace(page, (_route, pathname, method) => {
      if (pathname === CHAT && method === "POST") {
        chatRequested = true;
        return true; // never respond → the answer stays in flight
      }
      return false;
    });
    await page.goto(`/workspaces/${WSID}`);
    await ask(page, "Довге питання");

    const stop = page.getByTestId("chat-stop");
    await expect(stop).toBeVisible();
    await expect(page.getByText("Обмірковує…")).toBeVisible();
    expect(chatRequested).toBe(true);

    await stop.click();
    await expect(page.getByText("⏹ Відповідь зупинено.")).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Надіслати" })).toBeVisible();
    // An abort is not an error/interruption.
    await expect(page.getByText(/З’єднання перервано/)).toHaveCount(0);
  });
});
