import { query } from '../../db/pool.js';
import { matchPlace, type PlaceKind } from './places.js';

/**
 * Event-location geocoder: the offline gazetteer first (instant, covers the
 * ports/airports/crossings/UA cities logists actually see), then a cached
 * Nominatim lookup (OSM usage policy: ≤1 req/s, identifying UA, results cached
 * forever in geo_cache — including misses, so a bad string is asked once).
 */

let lastNominatim = 0;

async function nominatim(q: string): Promise<[number, number] | null> {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      {
        signal: controller.signal,
        headers: { 'user-agent': 'Shturman-Logistics-Hub/1.0 (ai-import-assistant)', 'accept-language': 'uk,en' },
      },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = arr[0];
    return hit ? [Number(hit.lat), Number(hit.lon)] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function geocode(
  text: string | null | undefined,
  prefer?: PlaceKind,
  allowNetwork = true,
): Promise<[number, number] | null> {
  const t = (text ?? '').trim();
  if (!t) return null;
  const p = matchPlace(t, prefer);
  if (p) return [p.lat, p.lng];
  if (!allowNetwork) return null;
  const key = t.toLowerCase().slice(0, 200);
  const cached = await query<{ lat: number | null; lng: number | null }>(
    'SELECT lat, lng FROM geo_cache WHERE query = $1',
    [key],
  );
  const row = cached.rows[0];
  if (row) return row.lat != null && row.lng != null ? [row.lat, row.lng] : null;
  const hit = await nominatim(t);
  await query('INSERT INTO geo_cache (query, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (query) DO NOTHING', [
    key,
    hit?.[0] ?? null,
    hit?.[1] ?? null,
  ]);
  return hit;
}
