import { test, expect, type Page } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * Конструктор документів (spec 012) against an in-memory fake of
 * /api/docbuilder. The real .docx output is covered by the backend tests
 * (src/docbuilder/__tests__/render.spec.ts); here: the logist's flow.
 * Desktop only (the mobile layout is frozen for now).
 */

type Doc = { id: string; kind: "contract" | "invoice"; number: string; title: string; data: Record<string, any>; contractId: string | null; createdAt: string; updatedAt: string };

function fakeBackend() {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const now = "2026-11-26T10:00:00.000Z";
  const parties: Record<string, any>[] = [
    {
      id: "p-seller", role: "seller", note: "", code: "",
      nameEn: "ACME TRADING LIMITED", nameUk: "ACME TRADING LIMITED", countryEn: "United Kingdom", countryUk: "Об'єднане Королівство",
      signatoryEn: "director John Smith", signatoryUk: "директора Джона Сміта", basisEn: "Memorandum of Association", basisUk: "Установчого договору",
      addressEn: "1 Test Street, London", addressUk: "1 Test Street, London", requisitesEn: "IBAN GB00", requisitesUk: "IBAN GB00",
    },
    {
      id: "p-buyer", role: "buyer", note: "", code: "PTB",
      nameEn: '"TEST BUYER" LLC', nameUk: "ТОВ «ТЕСТ ПОКУПЕЦЬ»", countryEn: "Ukraine", countryUk: "Україна",
      signatoryEn: "Director Ivanenko Olena", signatoryUk: "Директора Іваненко Олени", basisEn: "Statute", basisUk: "Статуту",
      addressEn: "Kharkiv, Ukraine", addressUk: "м. Харків", requisitesEn: "Code 00000000", requisitesUk: "Код 00000000",
    },
  ];
  const products: Record<string, any>[] = [
    { id: "pr-1", nameEn: "Boric acid", nameUk: "Борна кислота", hs: "2810009000", reg: "UA/18432/01/01", manufacturer: "TEST PHARMA", countryEn: "India", countryUk: "Індія" },
  ];
  const docs: Doc[] = [];
  const puts: Record<string, any>[] = [];
  const renders: { kind: string; format: string; data: any }[] = [];
  const total = (d: any) => (d.items ?? []).reduce((s: number, i: any) => s + i.qty * i.price, 0);
  const title = (kind: string, d: any) => [d.number || "без номера", kind === "contract" ? d.buyer?.nameEn : d.toName].filter(Boolean).join(" · ");
  return { parties, products, docs, puts, renders, id, now, total, title };
}

async function setup(page: Page) {
  const fb = fakeBackend();
  await mockWorkspace(page, async (route, pathname, method) => {
    if (!pathname.startsWith("/api/docbuilder")) return false;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body = () => JSON.parse(route.request().postData() || "{}");
    const parts = pathname.split("/").filter(Boolean); // api, docbuilder, x, id?, sub?
    const [, , coll, docId, sub] = parts;

    if (coll === "parties") {
      if (method === "GET") return (await json({ parties: fb.parties }), true);
      if (method === "POST") {
        const p = { ...body(), id: fb.id("p") };
        fb.parties.push(p);
        return (await json({ party: p }, 201), true);
      }
    }
    if (coll === "products") {
      if (method === "GET") return (await json({ products: fb.products }), true);
      if (method === "POST") {
        const p = { ...body(), id: fb.id("pr") };
        fb.products.push(p);
        return (await json({ product: p }, 201), true);
      }
    }
    if (coll === "render") {
      const b = body();
      fb.renders.push(b);
      if (b.format === "docx") {
        await route.fulfill({
          status: 200,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          headers: { "content-disposition": `attachment; filename="Contract.docx"; filename*=UTF-8''${encodeURIComponent(`Контракт ${b.data.number.replace(/\//g, "-")}.docx`)}` },
          body: "PK-fake-docx",
        });
        return true;
      }
      const rows = (b.data.items ?? []).map((i: any) => `<tr><td>${i.nameEn}</td><td>${i.qty}</td><td>${i.price}</td></tr>`).join("");
      return (await json({ html: `<p>${b.kind === "contract" ? "CONTRACT" : "INVOICE"} No. ${b.data.number}</p><table>${rows}</table>`, total: fb.total(b.data) }), true);
    }
    if (coll === "documents") {
      if (!docId && method === "GET")
        return (
          await json({
            documents: fb.docs.map((d) => ({ id: d.id, kind: d.kind, number: d.number, title: d.title, contractId: d.contractId, date: d.data.date, currency: d.data.currency, total: fb.total(d.data), updatedAt: d.updatedAt })),
          }),
          true
        );
      if (!docId && method === "POST") {
        const b = body();
        const d: Doc = { id: fb.id("d"), kind: b.kind, number: b.data.number, title: fb.title(b.kind, b.data), data: b.data, contractId: b.contractId ?? null, createdAt: fb.now, updatedAt: fb.now };
        fb.docs.unshift(d);
        return (await json({ document: d }, 201), true);
      }
      const d = fb.docs.find((x) => x.id === docId);
      if (!d) return (await json({ error: "not_found" }, 404), true);
      if (sub === "invoice" && method === "POST") {
        const c = d.data;
        const inv: Doc = {
          id: fb.id("d"), kind: "invoice", number: "", title: fb.title("invoice", { toName: c.buyer.nameEn }), contractId: d.id, createdAt: fb.now, updatedAt: fb.now,
          data: {
            number: "", date: "2026-11-26", contractRef: `${c.number} dated May 22, 2026`, toName: c.buyer.nameEn, toAddress: c.buyer.addressEn,
            consignorName: c.seller.nameEn, consignorAddress: c.seller.addressEn, currency: c.currency, incoterm: c.incoterm, incoPlaceEn: c.incoPlaceEn, incoYear: c.incoYear,
            originEn: "", pallets: "", stamp: true,
            items: c.items.map((i: any) => ({ nameEn: i.nameEn, reg: i.reg, manufacturer: i.manufacturer, countryEn: i.countryEn, qty: i.qty, price: i.price })),
            batches: c.items.map((i: any) => ({ nameEn: i.nameEn, reg: i.reg, batch: "", net: i.qty, gross: 0, packages: "", packagesCount: 0 })),
          },
        };
        fb.docs.unshift(inv);
        return (await json({ document: inv }, 201), true);
      }
      if (method === "GET") return (await json({ document: d }), true);
      if (method === "PUT") {
        const b = body();
        fb.puts.push(b.data);
        Object.assign(d, { data: b.data, number: b.data.number, title: fb.title(d.kind, b.data) });
        return (await json({ document: d }), true);
      }
      if (method === "DELETE") {
        fb.docs.splice(fb.docs.indexOf(d), 1);
        await route.fulfill({ status: 204, body: "" });
        return true;
      }
    }
    return false;
  });
  await page.goto(`/workspaces/${WSID}`);
  await page.getByTestId("nav-docs").click();
  await expect(page.getByTestId("docb-view")).toBeVisible();
  return fb;
}

test.describe("Конструктор документів", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === "mobile", "desktop only"));

  test("contract: buyer from the directory → auto number, goods from the catalogue, live preview, autosave, Word", async ({ page }) => {
    const fb = await setup(page);
    await page.getByTestId("docb-new-contract").click();
    await expect(page.getByTestId("docb-title")).toContainText("Контракт");

    // The seller comes prefilled from the directory; pick the buyer.
    await page.getByTestId("party-buyer-pick").selectOption("p-buyer");
    const number = await page.getByTestId("contract-number").inputValue();
    expect(number).toMatch(/^\d{8}\/PTB$/);

    await page.getByTestId("add-from-catalog").click();
    await page.getByTestId("catalog-item").first().click();
    await page.getByTestId("item-qty").fill("1000");
    await page.getByTestId("item-price").fill("4,36");
    await expect(page.getByTestId("contract-total")).toContainText("4 360,00");

    // Preview renders the current data; autosave sends the edit.
    await expect(page.locator(".docb-paper")).toContainText(`CONTRACT No. ${number}`);
    await expect(page.locator(".docb-paper")).toContainText("Boric acid");
    await expect(page.getByTestId("docb-save-state")).toContainText("Збережено");
    await expect.poll(() => fb.puts.at(-1)?.items?.[0]?.price).toBe(4.36);
    expect(fb.puts.at(-1)?.buyer?.nameEn).toBe('"TEST BUYER" LLC');
    expect(fb.puts.at(-1)?.seller?.nameEn).toBe("ACME TRADING LIMITED");

    // The «check every field» warning always sits under the form.
    await expect(page.getByTestId("docb-check-notice")).toContainText("перевірте всі поля");

    // Everything required is filled → no gaps banner.
    await expect(page.getByTestId("docb-gaps")).toHaveCount(0);

    const dl = page.waitForEvent("download");
    await page.getByTestId("docb-download").click();
    const file = await dl;
    expect(file.suggestedFilename()).toBe(`Контракт ${number.replace("/", "-")}.docx`);
    expect(fb.renders.at(-1)?.format).toBe("docx");

    // The list shows the saved contract.
    await expect(page.getByTestId("docb-doc-row").first()).toContainText(number);
  });

  test("invoice from a contract carries the goods; the packing list checks net weight", async ({ page }) => {
    const fb = await setup(page);
    await page.getByTestId("docb-new-contract").click();
    await page.getByTestId("party-buyer-pick").selectOption("p-buyer");
    await page.getByTestId("add-from-catalog").click();
    await page.getByTestId("catalog-item").first().click();
    await page.getByTestId("item-qty").fill("1000");
    await page.getByTestId("item-price").fill("4,36");
    await expect.poll(() => fb.puts.at(-1)?.items?.[0]?.qty).toBe(1000);

    await page.getByTestId("docb-make-invoice").click();
    await expect(page.getByTestId("docb-title")).toContainText("Інвойс");
    await expect(page.getByTestId("invoice-contract-ref")).toHaveValue(/\/PTB dated/);
    await expect(page.getByTestId("invoice-item")).toHaveCount(1);
    await expect(page.getByTestId("invoice-total")).toContainText("4 360,00");
    await expect(page.locator(".docb-paper")).toContainText("INVOICE No.");

    // Gaps: number, batch nr, gross — and no weight mismatch yet.
    await expect(page.getByTestId("docb-gaps")).toContainText("номер інвойсу");
    await expect(page.getByTestId("docb-gaps")).not.toContainText("нетто");

    await page.getByTestId("invoice-number").fill("TB-26/015");
    await page.getByTestId("batch-nr").fill("B-1");
    await page.getByTestId("batch-gross").fill("1080");
    await expect(page.getByTestId("docb-gaps")).toHaveCount(0);

    // A second batch breaks the net-weight balance → warned, not blocked.
    await page.getByTestId("add-batch").click();
    await expect(page.getByTestId("docb-gaps")).toContainText("у пакувальному листі нетто 2 000 кг");
    await expect(page.getByTestId("docb-download")).toBeEnabled();

    // The invoice row points at its contract.
    await expect(page.getByTestId("docb-doc-row").first()).toContainText("до ");
  });

  test("directory: add a company, then pick it in a contract", async ({ page }) => {
    const fb = await setup(page);
    await page.getByTestId("docb-open-directory").click();
    await expect(page.getByTestId("dir-party-row")).toHaveCount(2);
    await page.getByTestId("dir-add").click();
    await page.getByTestId("dir-party-name-en").fill('"NEW CLIENT" LLC');
    await page.getByTestId("dir-party-save").click();
    await expect(page.getByTestId("dir-party-row")).toHaveCount(3);
    expect(fb.parties.at(-1)?.nameEn).toBe('"NEW CLIENT" LLC');

    await page.getByTestId("dir-tab-products").click();
    await expect(page.getByTestId("dir-product-row")).toHaveCount(1);

    await page.getByTestId("docb-new-contract").click();
    await page.getByTestId("party-buyer-pick").selectOption({ label: '"NEW CLIENT" LLC' });
    await expect.poll(() => fb.puts.at(-1)?.buyer?.nameEn).toBe('"NEW CLIENT" LLC');
  });

  test("a new company typed in the document goes to the directory with its role", async ({ page }) => {
    const fb = await setup(page);
    await page.getByTestId("docb-new-contract").click();
    await page.getByTestId("party-buyer-pick").selectOption("__new");
    await page.getByTestId("party-buyer").getByLabel("Назва (EN)").fill('"FRESH BUYER" LLC');
    await page.getByTestId("party-buyer").getByRole("button", { name: "＋ У довідник" }).click();
    await expect(page.getByTestId("party-buyer").getByRole("button", { name: "✓ У довіднику" })).toBeVisible();
    expect(fb.parties.at(-1)).toMatchObject({ nameEn: '"FRESH BUYER" LLC', role: "buyer" });

    // Another consignee, typed by hand → saved as «Вантажоодержувач».
    await page.getByTestId("consignee-same").uncheck();
    await page.getByTestId("party-consignee-pick").selectOption("__new");
    await page.getByTestId("party-consignee").getByLabel("Назва (EN)").fill('"WAREHOUSE" LLC');
    await page.getByTestId("party-consignee").getByRole("button", { name: "＋ У довідник" }).click();
    await expect.poll(() => fb.parties.at(-1)?.role).toBe("consignee");

    // In the directory, every role has its own «＋» button.
    await page.getByTestId("docb-open-directory").click();
    await page.getByTestId("dir-add-consignee").click();
    await expect(page.getByTestId("dir-party-form")).toBeVisible();
    await expect(page.getByTestId("dir-group-consignee")).toContainText('"WAREHOUSE" LLC');
  });

  test("delete asks for a second click", async ({ page }) => {
    const fb = await setup(page);
    await page.getByTestId("docb-new-contract").click();
    await expect(page.getByTestId("docb-title")).toBeVisible();
    await page.getByTestId("docb-delete").click();
    await page.getByTestId("docb-delete-confirm").click();
    await expect(page.getByTestId("docb-doc-row")).toHaveCount(0);
    expect(fb.docs).toHaveLength(0);
  });
});
