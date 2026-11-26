import { describe, expect, it } from "vitest";
import {
  batchTotals,
  contractGaps,
  contractNumber,
  emptyContract,
  emptyInvoice,
  invoiceGaps,
  isAutoNumber,
  itemsTotal,
  packingMismatches,
  snapshot,
  todayIso,
  type DirectoryParty,
} from "../model";

const buyer: DirectoryParty = {
  id: "1", role: "buyer", note: "x", code: "PNS",
  nameEn: '"TEST" LLC', nameUk: "ТОВ «ТЕСТ»", countryEn: "Ukraine", countryUk: "Україна",
  signatoryEn: "Director A", signatoryUk: "Директора А", basisEn: "Statute", basisUk: "Статуту",
  addressEn: "Kharkiv", addressUk: "Харків", requisitesEn: "IBAN", requisitesUk: "IBAN",
};

describe("contract number — date + buyer suffix", () => {
  it("follows the team convention", () => {
    expect(contractNumber("2026-07-31", "PNS")).toBe("31072026/PNS");
    expect(contractNumber("2026-08-04", "")).toBe("04082026");
    expect(contractNumber("bad", "PNS")).toBe("");
  });
  it("recognises an auto number so a date or buyer change can refresh it", () => {
    expect(isAutoNumber("")).toBe(true);
    expect(isAutoNumber("31072026/PNS")).toBe(true);
    expect(isAutoNumber("31072026")).toBe(true);
    expect(isAutoNumber("APPENDIX 21")).toBe(false);
  });
});

describe("snapshot", () => {
  it("drops directory-only fields", () => {
    const s = snapshot(buyer);
    expect(s).not.toHaveProperty("id");
    expect(s).not.toHaveProperty("role");
    expect(s.code).toBe("PNS");
  });
});

describe("totals and checks", () => {
  it("sums lines without float drift", () => {
    expect(itemsTotal([{ qty: 500, price: 1.73 }, { qty: 0.1, price: 0.2 }])).toBe(865.02);
  });

  it("flags a packing list whose net weight does not match the invoice", () => {
    const inv = {
      ...emptyInvoice(null, "2026-08-17"),
      items: [{ nameEn: "Boric acid", reg: "", manufacturer: "", countryEn: "", unit: "kg" as const, qty: 1000, price: 4.36 }],
      batches: [
        { nameEn: "Boric acid", reg: "", batch: "A", net: 600, gross: 650, packages: "", packagesCount: 24 },
        { nameEn: "Boric acid", reg: "", batch: "B", net: 300, gross: 330, packages: "", packagesCount: 12 },
      ],
    };
    expect(packingMismatches(inv)).toHaveLength(1);
    expect(batchTotals(inv.batches)).toEqual({ net: 900, gross: 980, packages: 36 });
    inv.batches[1]!.net = 400;
    expect(packingMismatches(inv)).toEqual([]);
    expect(invoiceGaps(inv)).toEqual(["номер інвойсу", "посилання на контракт", "одержувач (To:)"]);
  });

  it("lists what a contract still misses", () => {
    const c = emptyContract(null, "2026-08-04");
    expect(contractGaps(c)).toContain("покупець");
    expect(contractGaps({ ...c, buyer: snapshot(buyer), seller: snapshot(buyer), items: [] })).toEqual(["товари специфікації"]);
  });

  it("formats today as ISO", () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("phase 2 helpers", () => {
  it("tonnes count as kg in the packing check, pieces are skipped", async () => {
    const { packingMismatches, emptyInvoice } = await import("../model");
    const inv = {
      ...emptyInvoice(null, "2026-08-17"),
      items: [
        { nameEn: "Stearic acid", reg: "", manufacturer: "", countryEn: "", unit: "t" as const, qty: 2, price: 1000 },
        { nameEn: "Capsules", reg: "", manufacturer: "", countryEn: "", unit: "pcs" as const, qty: 5000, price: 0.01 },
      ],
      batches: [{ nameEn: "Stearic acid", reg: "", batch: "A", net: 2000, gross: 2050, packages: "", packagesCount: 80 }],
    };
    expect(packingMismatches(inv)).toEqual([]);
  });

  it("totals of a Ukrainian invoice include VAT", async () => {
    const { uaTotals, docTotal, emptyUaInvoice, uaInvoiceGaps } = await import("../model");
    expect(uaTotals({ items: [{ qty: 100, price: 120 }], vatRate: 20 })).toEqual({ net: 12000, vat: 2400, total: 14400 });
    const d = { ...emptyUaInvoice(null, "2026-02-10"), items: [{ name: "Кислота", unit: "кг" as const, qty: 10, price: 50 }] };
    expect(docTotal("ua_invoice", d)).toBe(600);
    expect(uaInvoiceGaps(d)).toContain("постачальник");
  });

  it("history lines read in Ukrainian", async () => {
    const { eventLabel } = await import("../model");
    expect(eventLabel({ action: "status:sent", note: "", at: "", user: "" })).toBe("позначено «Відправлено»");
    expect(eventLabel({ action: "created", note: "з контракту 1/PSB", at: "", user: "" })).toBe("створено — з контракту 1/PSB");
  });
});
