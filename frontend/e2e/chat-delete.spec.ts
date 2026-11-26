import { test, expect } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/** A chat in the sidebar can be deleted: bin on hover → «Видалити?» → DELETE /api/conversations/:id. */
test("delete a chat from the sidebar", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "desktop only");
  const deleted: string[] = [];
  let convs = [
    { id: "11111111-1111-1111-1111-111111111111", title: "Тест конструктора", updated_at: "2026-11-26T10:00:00Z" },
    { id: "22222222-2222-2222-2222-222222222222", title: "Код УКТ ЗЕД", updated_at: "2026-11-25T10:00:00Z" },
  ];
  await mockWorkspace(page, async (route, pathname, method) => {
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (pathname === `/api/workspaces/${WSID}/conversations` && method === "GET") return (await json({ conversations: convs }), true);
    if (pathname.startsWith("/api/conversations/") && method === "DELETE") {
      const id = pathname.split("/").pop()!;
      deleted.push(id);
      convs = convs.filter((c) => c.id !== id);
      await route.fulfill({ status: 204, body: "" });
      return true;
    }
    return false;
  });
  await page.goto(`/workspaces/${WSID}`);
  const rows = page.getByTestId("conversation-row");
  await expect(rows).toHaveCount(2);
  await rows.first().hover();
  await page.getByTestId("conversation-delete").click();
  await page.getByTestId("conversation-delete-confirm").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Код УКТ ЗЕД");
  expect(deleted).toEqual(["11111111-1111-1111-1111-111111111111"]);
});
