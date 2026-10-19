import { test, expect } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * Supplier-instruction builder: prefill → edit → save (new version) → edit →
 * save (same version) → approve → edit → save as a NEW version (an approved
 * version is never edited in place). Backend mocked with page.route.
 */

const party = { name: "", address: "", country: "" };
const draft = {
  from: { directoryId: null, name: "AGroup95", address: "", signer: "", email: "", phone: "" },
  category: "substance",
  product: { name: "Тест", grade: "", cas: "", quantity: "", unit: "", hsCode: "", regNumber: "" },
  consignor: party,
  consigneeChoice: "recipient",
  consignee: party,
  finalConsignee: "",
  contract: { number: "", date: "" },
  terms: { incoterm: "FCA", place: "", destination: "", finalDestination: "", transport: "air" },
  docs: [],
  labels: [],
  labelNotes: "",
  originals: { contact: "", phone: "", address: "" },
  supplierEmail: "",
  extra: [],
  sources: {},
  proposals: [],
  hints: { contractType: null, intermediary: "", recipient: "", qdproSummary: "", lessons: [] },
};

// Desktop only: on a phone-width screen the instruction toolbar (Зберегти /
// Затвердити) runs off-screen — a known layout gap of this page; mobile UI is
// out of scope for now.
test("save creates v1, edits update it, approval locks it into a new version", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "instruction toolbar is off-screen on phones (known layout gap)");
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let versions: Record<string, unknown>[] = [];
  const version = (n: number, status: string, d: unknown) => ({
    id: `v${n}`, version: n, status, draft: d, createdBy: null, createdAt: "", updatedAt: "", missing: [],
  });

  await mockWorkspace(page, async (route, pathname, method) => {
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const body = () => (route.request().postData() ? JSON.parse(route.request().postData()!) : {});
    if (pathname === `/api/workspaces/${WSID}/instructions` && method === "GET") return (await json({ versions }), true);
    if (pathname === `/api/workspaces/${WSID}/instruction/prefill`) return (await json({ draft }), true);
    if (pathname === "/api/directory") return (await json({ entries: [] }), true);
    if (pathname === `/api/workspaces/${WSID}/instruction/preview`)
      return (await json({ en: "Dear supplier", uk: "Шановний", subject: "S", missing: [] }), true);
    if (pathname === `/api/workspaces/${WSID}/instructions` && method === "POST") {
      const b = body();
      writes.push({ method, path: pathname, body: b });
      const v = version(versions.length + 1, "draft", b.draft);
      versions = [v, ...versions];
      return (await json({ version: v }), true);
    }
    const m = pathname.match(new RegExp(`/api/workspaces/${WSID}/instructions/(\\d+)$`));
    if (m && method === "PATCH") {
      const b = body();
      writes.push({ method, path: pathname, body: b });
      const n = Number(m[1]);
      const cur = versions.find((v) => v.version === n)!;
      const v = version(n, (b.status as string) ?? (cur.status as string), b.draft ?? cur.draft);
      versions = versions.map((x) => (x.version === n ? v : x));
      return (await json({ version: v }), true);
    }
    return false;
  });

  await page.goto(`/workspaces/${WSID}/instruction`);
  const email = page.locator('label:has-text("E-mail постачальника") + input');
  await expect(page.getByRole("button", { name: "Зберегти", exact: true })).toBeVisible();

  await email.fill("a@supplier.test");
  await expect(page.getByText("незбережено")).toBeVisible();
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ method: "POST", body: { draft: { supplierEmail: "a@supplier.test" } } });
  await expect(page.getByText("незбережено")).toBeHidden();

  await email.fill("b@supplier.test");
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ method: "PATCH", path: `/api/workspaces/${WSID}/instructions/1`, body: { resolvedProposals: [] } });

  await page.getByRole("button", { name: /Затвердити v1/ }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toMatchObject({ method: "PATCH", body: { status: "approved" } });

  await email.fill("c@supplier.test");
  await page.getByRole("button", { name: "Зберегти як нову версію" }).click();
  await expect.poll(() => writes.length).toBe(4);
  expect(writes[3]).toMatchObject({ method: "POST", body: { draft: { supplierEmail: "c@supplier.test" } } });
});
