import { z } from 'zod';

/** A calendar day `YYYY-MM-DD`, or '' when not known yet. */
const day = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'date must be YYYY-MM-DD');

export const stepSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  plan: day.default(''),
  actual: day.default(''),
  state: z.enum(['active', 'done', 'pending']),
  note: z.string().max(1000).default(''),
});
export type SupplyStep = z.infer<typeof stepSchema>;

const shipmentFields = {
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(60),
  action: z.string().trim().max(300),
  note: z.string().max(4000),
  steps: z.array(stepSchema).max(40),
  custom: z.record(z.string().max(60), z.string().max(300)),
};

export const shipmentInputSchema = z.object({
  ...shipmentFields,
  action: shipmentFields.action.default(''),
  note: shipmentFields.note.default(''),
  steps: shipmentFields.steps.default([]),
  custom: shipmentFields.custom.default({}),
});
export type ShipmentInput = z.infer<typeof shipmentInputSchema>;

export const shipmentPatchSchema = z
  .object(shipmentFields)
  .partial()
  // Optimistic concurrency: the updatedAt the editor started from.
  .extend({ expectedUpdatedAt: z.string().max(64).optional() });
export type ShipmentPatch = z.infer<typeof shipmentPatchSchema>;

export const archiveSchema = z.object({ archived: z.boolean() });

/** Transport of a shipment; '' = worked out from its steps. */
export const MODES = ['', 'sea', 'air', 'rail', 'road', 'courier'] as const;
export type SupplyMode = (typeof MODES)[number];

/**
 * Marks: the team's own annotations (star, groups, transport). The old site has
 * none of them, so changing a mark never counts as «edited here» for the sync.
 */
export const marksSchema = z
  .object({
    pinned: z.boolean(),
    groups: z.array(z.string().min(1).max(64)).max(20),
    mode: z.enum(MODES),
  })
  .partial()
  .refine((m) => Object.keys(m).length > 0, 'nothing to change');
export type SupplyMarks = z.infer<typeof marksSchema>;

export const settingsSchema = z.object({
  stages: z.array(z.string().trim().min(1).max(80)).max(200),
  categories: z.array(z.string().trim().min(1).max(60)).min(1).max(30),
  fields: z
    .array(z.object({ id: z.string().min(1).max(60), name: z.string().trim().min(1).max(80), type: z.enum(['text', 'number']).default('text') }))
    .max(30),
  templates: z
    .array(z.object({ id: z.string().min(1).max(64), name: z.string().trim().min(1).max(80), stages: z.array(z.string().trim().min(1).max(80)).min(1).max(30) }))
    .max(50),
  groups: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().trim().min(1).max(60) })).max(50).default([]),
  categoryIcons: z.record(z.string().max(60), z.string().max(30)).default({}),
});
export type SupplySettings = z.infer<typeof settingsSchema>;

export interface SupplyShipment {
  id: string;
  name: string;
  category: string;
  action: string;
  note: string;
  archived: boolean;
  steps: SupplyStep[];
  custom: Record<string, string>;
  pinned: boolean;
  groups: string[];
  mode: SupplyMode;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplyHistoryEntry {
  id: number;
  at: string;
  actor: string;
  kind: 'shipment' | 'mark' | 'settings' | 'legacy';
  text: string;
  shipmentId: string | null;
  undoable: boolean;
}
