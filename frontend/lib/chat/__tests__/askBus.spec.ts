import { describe, expect, it } from "vitest";
import { askInChat, askPrompts, onAsk } from "../askBus";

describe("askBus", () => {
  it("delivers a sidebar question to the subscriber and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = onAsk((d) => seen.push(`${d.kind}:${d.text}`));
    askInChat("  Що з комплектністю?  ", "supply");
    askInChat("   ", "supply"); // empty → ignored
    off();
    askInChat("after", "consolidated");
    expect(seen).toEqual(["supply:Що з комплектністю?"]);
  });

  it("phrases the questions per scope", () => {
    expect(askPrompts.check({ kind: "shipment" })).toBe("Що не так з документами? Перевір пакет повністю.");
    expect(askPrompts.check({ kind: "fcl" })).toContain("збірником");
    expect(askPrompts.completeness({ kind: "lot", name: "Xi'an TaiCheng" })).toBe(
      "Що з комплектністю партії «Xi'an TaiCheng»? Чого бракує і де це взяти?",
    );
    expect(askPrompts.risks({ kind: "shipment" })).toBe("Які ризики по цьому постачанню і що з ними робити?");
    expect(askPrompts.risks({ kind: "fcl" })).toBe("Які ризики збірника і що з ними робити?");
  });

  it("a finding question names the finding, its values, files and lot", () => {
    const q = askPrompts.finding({ title: "Вага брутто", values: "10 720 → 10 150", files: "«PL.pdf», «HBL-C.pdf»", lot: "Xi'an" });
    expect(q).toBe(
      "Поясни знахідку автоперевірки: «Вага брутто» (партія «Xi'an») — 10 720 → 10 150 («PL.pdf», «HBL-C.pdf»). Це справжня проблема? Перевір у файлах і скажи, що зробити.",
    );
  });

});
