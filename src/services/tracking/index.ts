import { config } from '../../config.js';
import { AisHubTrackingProvider } from './aishub.js';
import { DemoTrackingProvider } from './demo.js';
import type { TrackingProvider } from './provider.js';

/**
 * Tracking provider wiring (Phase D), mirroring getEmbeddingProvider(). A
 * deployment runs exactly one provider, chosen by AIS_PROVIDER. 'aishub' requires
 * AIS_API_KEY — without it we fall back to the DEMO provider so the map still
 * works out of the box (and no live AIS calls are ever made at build/test time).
 */

let provider: TrackingProvider | null = null;

export function getTrackingProvider(): TrackingProvider {
  if (!provider) {
    if (config.AIS_PROVIDER === 'aishub' && config.AIS_API_KEY) {
      provider = new AisHubTrackingProvider(config.AIS_API_KEY);
    } else {
      provider = new DemoTrackingProvider();
    }
  }
  return provider;
}

export type { TrackingProvider, VesselPosition, ShipmentInput } from './provider.js';
