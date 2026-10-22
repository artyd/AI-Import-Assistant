import { test, expect } from "@playwright/test";
import { mockWorkspace, WSID } from "./mocks";

/**
 * Збірник (FCL, spec 006): the right panel shows Файли / Партії / Комплектність /
 * Аналіз / Журнал; lots carry traffic lights; opening a lot switches
 * «Комплектність» to it. Backend mocked with page.route. Desktop only.
 */

const FCL = "fcl-1";
const lot = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  supplier_name: `${name} Co Ltd`,
  source: "auto",
  status: "docs_in_progress",
  derived_status: "docs_in_progress",
  file_count: 4,
  consignee: "НОВАЛАЙТ",
  intake_complete: true,
  completeness: { done: 5, total: 5 },
  discrepancies: { confirmed: 0, suspected: 0 },
  risks: { error: 0, warning: 0 },
  context: {
    consignee: null,
    incoterm_in: "FOB",
    incoterm_out: null,
    product_category: "api",
    origin_country: "Китай",
    contract_type: "bilateral",
    contract_type_source: "auto",
    contract_type_reason: null,
    auto_fields: ["incoterm_in"],
  },
  ...over,
});

const overview = {
  fcl: {
    id: FCL,
    number: "Збірник 18",
    status: "docs_in_progress",
    derived_status: "docs_in_progress",
    level_status: "docs_complete",
    intake_complete: true,
    transport_mode: "sea",
    product_category: null,
    destination_country: null,
    eu_transit: null,
    eu_transit_derived: true,
    containers: ["ECMU4794246"],
    unassigned: 3,
  },
  checklist: [
    { requirement_key: "master_transport", label: "Морський коносамент (MBL)", stage: "docs", status: "verified", source_file_id: "m" },
    { requirement_key: "customs_declaration:Червона Зірка", label: "МД — Червона Зірка", stage: "customs", status: "missing", source_file_id: null },
  ],
  discrepancies: [],
  consignees: [{ name: "НОВАЛАЙТ", lots: ["Shandong"], customs_declaration_file_id: "d1" }],
  manifest: { file_name: "manifest.xlsx", built: false, matches: [] },
  risks: [],
  all_discrepancies: [
    { field: "net_weight_kg", expected: "5000", actual: "4900", severity: "error", kind: "confirmed", citations: [], lot: "Hebei" },
  ],
  lots: [lot("L1", "Shandong"), lot("L2", "Hebei", { discrepancies: { confirmed: 1, suspected: 0 } })],
};

test("an FCL shows lots with traffic lights and opens a lot in «Комплектність»", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "desktop-only feature");
  await page.addInitScript(() => {
    localStorage.setItem("shturman-app", JSON.stringify({ state: { chatKind: "consolidated", activeCollectionId: "fcl-1" }, version: 0 }));
  });
  await mockWorkspace(page, (route, pathname, method) => {
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/collections") {
      void json({ collections: [{ id: FCL, number: "Збірник 18", supplier: "", status: "docs_in_progress", created_at: "2026-10-01T00:00:00Z" }] });
      return true;
    }
    if (pathname === `/api/collections/${FCL}`) {
      void json({ collection: { id: FCL, number: "Збірник 18" }, folders: [{ id: "fo1", name: "Партія — Shandong", position: 3, lotId: "L1" }] });
      return true;
    }
    if (pathname === `/api/workspaces/${FCL}/fcl` && method === "GET") {
      void json(overview);
      return true;
    }
    if (pathname === `/api/workspaces/${FCL}/lots/L2`) {
      void json({ lot: overview.lots[1], checklist: [{ requirement_key: "invoice", status: "verified", source_file_id: "i" }], discrepancies: [], risks: [], parties: [] });
      return true;
    }
    if (pathname === `/api/workspaces/${FCL}/files`) {
      void json({ files: [] });
      return true;
    }
    return false;
  });

  await page.goto(`/workspaces/${WSID}`);

  await page.getByRole("button", { name: /Партії/ }).first().click();
  await expect(page.getByText("FCL ECMU4794246")).toBeVisible();
  await expect(page.getByText("Без партії: 3 файли")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hebei" })).toBeVisible();

  await page.getByRole("button", { name: "Hebei" }).click();
  await expect(page.getByLabel("Область перевірки")).toHaveValue("L2");
  await expect(page.getByText("Параметри партії")).toBeVisible();

  await page.getByLabel("Область перевірки").selectOption("fcl");
  await expect(page.getByText("МД — Червона Зірка")).toBeVisible();
});
