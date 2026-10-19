import type { ShipmentInput, TrackingProvider, VesselPosition } from './provider.js';

/**
 * Live AIS adapter (stub). Selected only when AIS_PROVIDER='aishub' AND an
 * AIS_API_KEY is present (see ./index.ts) — it is never constructed without a
 * key, so it makes no network calls at build/test time. Until wired it returns
 * an empty position set rather than throwing, so the map degrades gracefully.
 */
export class AisHubTrackingProvider implements TrackingProvider {
  readonly id = 'aishub';

  constructor(private readonly apiKey: string) {}

  async getShipmentPositions(_shipments: ShipmentInput[]): Promise<VesselPosition[]> {
    // TODO: wire AISHub/AISStream when key provided — resolve each shipment's
    // vessel (MMSI/IMO), query live lat/lng/status, and map to VesselPosition[].
    if (!this.apiKey) return [];
    return [];
  }
}
