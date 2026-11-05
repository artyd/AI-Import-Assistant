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
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplyField {
  id: string;
  name: string;
  type: "text" | "number";
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
}

export interface SupplyHistoryEntry {
  id: number;
  at: string;
  actor: string;
  kind: "shipment" | "settings" | "legacy";
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
