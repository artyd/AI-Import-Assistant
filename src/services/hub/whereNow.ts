import { haversineKm, type LatLng } from './geo.js';
import { liveItem, type LiveItem } from './live.js';
import { PLACES } from './places.js';
import { listTeamTracked, listTracked, serializeTracked, type TrackedRow } from './track.js';

/**
 * "Де зараз вантажі": for each active tracked item — where it is (nearest known
 * port / airport / crossing, or "у морі, ~N км від …"), how it is known (AIS /
 * route estimate / last carrier event), how far along, the ETA and the delay
 * against the sheet's plan. Used by the chat tool and the public MCP.
 */

const DAY = 86_400_000;
const day = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : null);
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** "біля Гданськ" (≤ 60 km) or "~340 км від Порт-Саїд". */
export function describePosition(pos: LatLng): string {
  let best: { name: string; km: number } | null = null;
  for (const p of PLACES) {
    if (p.kind === 'inland') continue;
    const km = haversineKm(pos, [p.lat, p.lng]);
    if (!best || km < best.km) best = { name: p.name, km };
  }
  if (!best) return `${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}`;
  return best.km <= 60 ? `біля ${best.name}` : `~${Math.round(best.km / 10) * 10} км від ${best.name}`;
}

const SOURCE: Record<string, string> = {
  ais: 'AIS (реальна позиція судна)',
  estimate: 'орієнтовно — за датами виходу/прибуття і маршрутом',
  event: 'остання подія перевізника',
  origin: 'ще в пункті відправлення',
  destination: 'у пункті призначення',
};

export interface WhereNow {
  label: string;
  number: string;
  forwarder: string;
  status: string;
  where: string;
  source: string;
  progress: number | null;
  eta: string | null;
  etaEstimated: boolean;
  plan: string | null;
  delayDays: number | null;
  trackUrl: string | null;
}

export function whereOf(r: TrackedRow, live: LiveItem): WhereNow {
  const t = serializeTracked(r);
  const eta = day(live.eta ?? r.eta);
  const plan = r.sheet_plan ?? null;
  const delay = eta && plan ? Math.round((Date.parse(eta) - Date.parse(plan)) / DAY) : null;
  const where = live.pos
    ? describePosition(live.pos)
    : t.status === 'delivered'
      ? t.destination || '—'
      : t.origin
        ? `${t.origin} (координат немає)`
        : 'позиція невідома';
  return {
    label: t.label || t.number,
    number: t.number,
    forwarder: t.forwarder,
    status: t.statusLabel,
    where,
    source: live.positionSource ? SOURCE[live.positionSource]! : 'немає даних про позицію',
    progress: live.path.length > 1 && live.pos ? Math.round(live.progress * 100) : null,
    eta,
    etaEstimated: live.etaEstimated,
    plan,
    delayDays: delay,
    trackUrl: t.trackUrl,
  };
}

export async function whereNow(opts: { userId?: string; query?: string; onlyDelayed?: boolean }): Promise<WhereNow[]> {
  const rows = (opts.userId ? await listTracked(opts.userId) : await listTeamTracked()).filter(
    (r) => !r.archived && r.status !== 'delivered',
  );
  const q = (opts.query ?? '').trim().toLowerCase();
  const picked = q
    ? rows.filter((r) => [r.label, r.number, r.origin, r.destination, r.sheet_forwarder ?? ''].some((x) => x.toLowerCase().includes(q)))
    : rows;
  const out: WhereNow[] = [];
  for (const r of picked) out.push(whereOf(r, await liveItem(r)));
  const list = opts.onlyDelayed ? out.filter((w) => (w.delayDays ?? 0) >= 1) : out;
  return list.sort((a, b) => (b.delayDays ?? -99) - (a.delayDays ?? -99) || (a.eta ?? '9').localeCompare(b.eta ?? '9'));
}

export function whereNowText(list: WhereNow[]): string {
  if (!list.length) return 'Активних вантажів у хабі немає (або нічого не знайдено за запитом).';
  return list
    .map((w) => {
      const parts = [
        `**${w.label}**${w.label !== w.number ? ` (${w.number})` : ''}${w.forwarder ? ` · везе ${w.forwarder}` : ''}`,
        `статус: ${w.status}`,
        `де: ${w.where} — ${w.source}`,
        w.progress != null ? `пройдено ~${w.progress}%` : '',
        w.eta ? `ETA ${dmy(w.eta)}${w.etaEstimated ? ' (розрахунок)' : ''}` : '',
        w.plan ? `план у таблиці ${dmy(w.plan)}` : '',
        w.delayDays != null && w.delayDays >= 1 ? `⚠ запізнюється на ${w.delayDays} дн` : '',
        w.trackUrl ? `трекінг: ${w.trackUrl}` : '',
      ];
      return `- ${parts.filter(Boolean).join(' · ')}`;
    })
    .join('\n');
}
