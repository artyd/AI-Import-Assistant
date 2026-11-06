// Wire shapes of /api/supply (spec 008). Mirrors src/supply/types.ts.

export type StepState = "active" | "done" | "pending";

export interface SupplyStep {
  id: string;
  name: string;
  plan: string; // YYYY-MM-DD or ""
  actual: string; // YYYY-MM-DD or ""
  state: StepState;
  note: string;
}

export interface SupplyShipment {
  id: string;
  name: string;
  category: string;
  action: string;
  note: string;
  archived: boolean;
  steps: SupplyStep[];
  custom: Record<string, string>;
  pinned: boolean; // starred: always on top
  groups: string[]; // SupplyGroup ids
  mode: SupplyMode; // '' = worked out from the steps
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplyField {
  id: string;
  name: string;
  type: "text" | "number";
}

export type SupplyMode = "" | "sea" | "air" | "rail" | "road" | "courier";

export interface SupplyGroup {
  id: string;
  name: string;
}

export interface SupplyMarks {
  pinned?: boolean;
  groups?: string[];
  mode?: SupplyMode;
}

export interface SupplyTemplate {
  id: string;
  name: string;
  stages: string[];
}

export interface SupplySettings {
  stages: string[];
  categories: string[];
  fields: SupplyField[];
  templates: SupplyTemplate[];
  groups: SupplyGroup[];
  categoryIcons: Record<string, string>; // category → icon key (lib/supply/logic.ts CATEGORY_ICONS)
}

export interface SupplyHistoryEntry {
  id: number;
  at: string;
  actor: string;
  kind: "shipment" | "mark" | "settings" | "legacy";
  text: string;
  shipmentId: string | null;
  undoable: boolean;
}

export interface SupplyData {
  shipments: SupplyShipment[];
  settings: SupplySettings;
  revision: string;
  canEdit: boolean;
}

export type ShipmentDraft = Pick<SupplyShipment, "name" | "category" | "action" | "note" | "steps" | "custom">;
