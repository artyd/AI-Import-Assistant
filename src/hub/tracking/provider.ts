/**
 * Vessel-tracking provider abstraction (Phase D). GET /api/map/shipments turns
 * the current user's shipments into live map markers through one of these; the
 * concrete provider is chosen at boot by AIS_PROVIDER (see ./index.ts), mirroring
 * the EmbeddingProvider wiring. The DEMO provider interpolates a deterministic
 * point along each shipment's route (no network); AISHub is a live adapter.
 */

/** A single map marker: a ship or truck at a point, optionally on a known route. */
export interface VesselPosition {
  id: string;
  kind: 'ship' | 'truck';
  label: string;
  lat: number;
  lng: number;
  status: string;
  routeId?: string | null;
}

/** Minimal shipment shape a provider needs to place a marker. */
export interface ShipmentInput {
  no: string;
  supplier: string;
  status: string;
  /** Route to place the shipment on; unset ⇒ the provider omits/parks it. */
  routeId?: string;
}

export interface TrackingProvider {
  readonly id: string;
  getShipmentPositions(shipments: ShipmentInput[]): Promise<VesselPosition[]>;
}
