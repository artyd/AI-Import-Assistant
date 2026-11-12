import { describe, expect, it } from "vitest";
import { hasFindings, letterRequest } from "../letterFromAnswer";

const answer = [
  "**Пакет неповний: бракує CMR.**",
  "",
  "| Що | Де | Дія |",
  "|---|---|---|",
  "| **Немає CMR** | — | запросити в перевізника |",
  "| **Різні IBAN** у двох рахунках | ADV-1001; PRO-1001 | звірити реквізити до оплати |",
  "| **Розбіжності немає:** брутто — у PL обидві цифри | PL стор. 1 | — |",
  "",
  "Решта збігається: нетто 500 кг.",
  "",
  "Дія: запросити комерційний інвойс.",
].join("\n");

describe("letter from an answer", () => {
  it("an answer with a problem table and an action has findings", () => {
    expect(hasFindings(answer)).toBe(true);
    expect(hasFindings("**48 500,00 USD**, CIF Гданськ.")).toBe(false);
  });

  it("the request lists the problem rows (not the header, not refuted ones) and the action", () => {
    const r = letterRequest(answer)!;
    expect(r).toContain("- Немає CMR — запросити в перевізника");
    expect(r).toContain("- Різні IBAN у двох рахунках — ADV-1001; PRO-1001 — звірити реквізити до оплати");
    expect(r).not.toContain("Що — Де — Дія");
    expect(r).not.toContain("Розбіжності немає");
    expect(r).toContain("Дія: запросити комерційний інвойс.");
    expect(letterRequest("без таблиці")).toBeNull();
  });

  it("the short form: numbered «що — де → дія» lines are findings", () => {
    const short = [
      "**2 проблеми: бракує CMR, нетто не збігається.**",
      "1. **Немає CMR** → запросити в перевізника.",
      "2. **Нетто** — INV-0421 стор. 2: 25 000 кг ≠ PL-0421 стор. 1: 20 000 кг → запросити виправлений PL.",
      "Решта збігається: брутто.",
    ].join("\n");
    expect(hasFindings(short)).toBe(true);
    const r = letterRequest(short)!;
    expect(r).toContain("- Немає CMR → запросити в перевізника.");
    expect(r).toContain("- Нетто — INV-0421 стор. 2: 25 000 кг ≠ PL-0421 стор. 1: 20 000 кг → запросити виправлений PL.");
    // A plain numbered list without actions is not a findings list.
    expect(hasFindings("1. Інвойс\n2. PL")).toBe(false);
  });
});
