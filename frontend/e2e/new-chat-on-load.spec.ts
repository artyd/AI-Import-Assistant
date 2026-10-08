import { test, expect } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * A page (re)load opens a NEW chat — the previous conversation stays in the
 * sidebar history and opens on click.
 */

const CONV = { id: "c-old", title: "Стара розмова про Метопрен", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-07T09:00:00Z" };
const OLD_ANSWER = "Попередня відповідь Штурмана про інвойс";

test("reload opens a new chat; the old one is in the history", async ({ page }, info) => {
  let opened = 0;
  await mockWorkspace(page, async (route, pathname) => {
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === `/api/workspaces/${WSID}/conversations`) return (await json({ conversations: [CONV] }), true);
    if (pathname === `/api/workspaces/${WSID}/conversations/${CONV.id}`) {
      opened += 1;
      return (
        await json({
          conversationId: CONV.id,
          messages: [
            { id: "m1", role: "user", content: "Що з інвойсом?" },
            { id: "m2", role: "assistant", content: OLD_ANSWER },
          ],
        }),
        true
      );
    }
    return false;
  });

  await page.goto(`/workspaces/${WSID}`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  const history = page.getByRole("button", { name: /Стара розмова про Метопрен/ });
  await expect(history.first()).toBeAttached();
  await page.waitForTimeout(800);
  await expect(page.getByText(OLD_ANSWER)).toHaveCount(0);
  expect(opened).toBe(0);

  await page.reload();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText(OLD_ANSWER)).toHaveCount(0);

  // The history still opens the old conversation (desktop: the sidebar sits beside the chat).
  if (info.project.name !== "mobile") {
    await history.first().click();
    await expect(page.getByText(OLD_ANSWER)).toBeVisible();
    expect(opened).toBe(1);
  }
});
