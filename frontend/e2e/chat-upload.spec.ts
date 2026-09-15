import { test, expect, type Page } from "@playwright/test";

/**
 * Chat file intake — drag-and-drop and paste. The backend is fully mocked with
 * page.route, so these run standalone (no PW_BACKEND needed). Both gestures STAGE
 * the file as a chip above the composer (no upload yet); the actual upload →
 * auto-classify only fires when the message is sent. We assert the chip appears,
 * then that pressing send fires the upload and the classify bubble reports the
 * folder (which also exercises the Ukrainian folder-label mapping).
 */
const WSID = "ws-test";
const WS = {
  id: WSID,
  number: "2026-0001",
  supplier: "SupplierABC",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
};

async function setupMocks(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("aia_token", "test-token");
    } catch {
      /* ignore */
    }
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    // Live file-status channel (EventSource) — keep it quiet.
    if (pathname.endsWith("/events")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    if (pathname === "/api/auth/me") return json({ user: { id: "u1", email: "t@t", name: "Тест" } });
    if (pathname === "/api/workspaces" && method === "GET") return json({ workspaces: [WS] });
    if (pathname === `/api/workspaces/${WSID}` && method === "GET")
      return json({ workspace: WS, folders: [] });
    if (pathname === `/api/workspaces/${WSID}/files` && method === "GET") return json({ files: [] });
    if (pathname === `/api/workspaces/${WSID}/conversations` && method === "GET")
      return json({ conversations: [] });
    if (pathname.endsWith("/checklist")) return json({ items: [], status: "docs_in_progress" });

    // Upload (multipart POST) → one created file.
    if (pathname === `/api/workspaces/${WSID}/files` && method === "POST") {
      return json({
        files: [{ id: "f1", folderId: null, name: "doc.pdf", type: "pdf", status: "queued" }],
      });
    }
    // Auto-classify → files it into the certificates folder.
    if (/\/files\/f1\/classify$/.test(pathname) && method === "POST") {
      return json({ fileId: "f1", folderName: "03_Certificates" });
    }

    return json({});
  });
}

async function makeFileTransfer(page: Page, name: string, type: string) {
  return page.evaluateHandle(
    ([n, t]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], n, { type: t }));
      return dt;
    },
    [name, type] as const
  );
}

test.describe("Chat file intake", () => {
  test("drag-and-drop stages the file, then send uploads and auto-files it", async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/workspaces/${WSID}`);

    const chat = page.getByTestId("chat-root");
    await expect(chat).toBeVisible();

    const dt = await makeFileTransfer(page, "invoice.pdf", "application/pdf");
    await chat.dispatchEvent("dragenter", { dataTransfer: dt });
    await chat.dispatchEvent("dragover", { dataTransfer: dt });
    await chat.dispatchEvent("drop", { dataTransfer: dt });

    // Staged as a chip above the composer — NOT uploaded yet.
    await expect(page.getByTestId("composer-pending")).toContainText("invoice.pdf");

    // Sending fires the upload + auto-classify.
    const uploadReq = page.waitForRequest(
      (r) => r.url().endsWith(`/workspaces/${WSID}/files`) && r.method() === "POST"
    );
    await page.getByRole("button", { name: "Надіслати" }).click();
    await uploadReq;

    // Classify bubble reports the folder via the Ukrainian label.
    await expect(page.getByText(/Віднесено до «03 · Сертифікати»/)).toBeVisible();
  });

  test("paste stages the file, then send uploads and auto-files it", async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/workspaces/${WSID}`);

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();

    // ClipboardEvent.clipboardData is read-only and can't be set via Playwright's
    // dispatchEvent, so build a paste event in-page with a DataTransfer attached
    // (React reads clipboardData off the native event) and dispatch it.
    await page.evaluate(
      ([name, type]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], name, { type }));
        const ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
        document.querySelector('[data-testid="chat-input"]')!.dispatchEvent(ev);
      },
      ["scan.png", "image/png"] as const
    );

    // Staged as a chip — NOT uploaded yet.
    await expect(page.getByTestId("composer-pending")).toContainText("scan.png");

    const uploadReq = page.waitForRequest(
      (r) => r.url().endsWith(`/workspaces/${WSID}/files`) && r.method() === "POST"
    );
    await page.getByRole("button", { name: "Надіслати" }).click();
    await uploadReq;

    await expect(page.getByText(/Віднесено до «03 · Сертифікати»/)).toBeVisible();
  });
});
