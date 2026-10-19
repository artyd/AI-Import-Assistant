import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let gate: (() => void) | null = null;

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    calls.push(path);
    if (path.includes("slow") && path.endsWith("/checklist")) await new Promise<void>((r) => (gate = r));
    if (path.endsWith("/checklist")) return { items: [{ requirement_key: path, status: "missing", source_file_id: null }] };
    if (path.endsWith("/risks")) return { risks: [] };
    return { parties: [{ id: "p", role: "sender", company_name: "X" }] };
  }),
}));

const { useShipmentData } = await import("../shipmentData");

beforeEach(() => {
  calls.length = 0;
  useShipmentData.setState({ workspaceId: null, revision: 0, checklist: null, risks: null, parties: null });
});

describe("shipment data store", () => {
  it("load fetches checklist, risks and parties once each", async () => {
    await useShipmentData.getState().load("w1");
    expect(calls.sort()).toEqual(["/api/workspaces/w1/checklist", "/api/workspaces/w1/parties", "/api/workspaces/w1/risks"]);
    expect(useShipmentData.getState().parties).toHaveLength(1);
  });

  it("invalidate bumps the revision and reloads everything", async () => {
    await useShipmentData.getState().load("w1");
    const rev = useShipmentData.getState().revision;
    calls.length = 0;
    useShipmentData.getState().invalidate();
    expect(useShipmentData.getState().revision).toBe(rev + 1);
    expect(useShipmentData.getState().parties).toBeNull(); // reloading
    await vi.waitFor(() => expect(calls).toHaveLength(3));
  });

  it("a response for a shipment the user already left is dropped", async () => {
    const slow = useShipmentData.getState().load("slow");
    await useShipmentData.getState().load("w2");
    gate?.();
    await slow;
    expect(useShipmentData.getState().checklist?.[0]?.requirement_key).toBe("/api/workspaces/w2/checklist");
  });
});
