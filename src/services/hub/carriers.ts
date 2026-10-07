/**
 * Carrier registry for the logistics hub. One entry per carrier we can recognise
 * from a tracking number: its transport mode, the public tracking page we deep-
 * link to (always shown, so the logist can check the source by hand), and the
 * prefixes that identify it (container owner codes / B/L SCAC prefixes / IATA
 * airline AWB prefixes).
 *
 * Pure data + lookups — no I/O. Prefix lists hold only codes we are sure of; an
 * unknown prefix yields "carrier unknown" rather than a guess.
 */

export type HubMode = 'sea' | 'air' | 'courier' | 'domestic';

export interface Carrier {
  id: string;
  name: string;
  mode: HubMode;
  /** Public tracking page; `{n}` is replaced with the (URL-encoded) number. */
  trackUrl: string;
  /** ISO 6346 owner codes (4 letters incl. the U/J/Z category). Sea only. */
  containerPrefixes?: string[];
  /** B/L number prefixes (carrier SCAC-like). Sea only. */
  blPrefixes?: string[];
  /** IATA 3-digit AWB prefixes. Air only. */
  awbPrefixes?: string[];
}

export const CARRIERS: Carrier[] = [
  // ── Ocean carriers ─────────────────────────────────────────────────────────
  {
    id: 'maersk',
    name: 'Maersk',
    mode: 'sea',
    trackUrl: 'https://www.maersk.com/tracking/{n}',
    containerPrefixes: ['MSKU', 'MAEU', 'MRKU', 'MRSU', 'SUDU', 'SEAU', 'MCAU'],
    blPrefixes: ['MAEU', 'SUDU'],
  },
  {
    id: 'msc',
    name: 'MSC',
    mode: 'sea',
    trackUrl: 'https://www.msc.com/en/track-a-shipment?agencyPath=msc&trackingNumber={n}',
    containerPrefixes: ['MSCU', 'MEDU', 'MSDU', 'MSMU', 'MSNU'],
    blPrefixes: ['MEDU', 'MSCU'],
  },
  {
    id: 'cma',
    name: 'CMA CGM',
    mode: 'sea',
    trackUrl: 'https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference={n}',
    containerPrefixes: ['CMAU', 'CGMU', 'APZU', 'APHU', 'ECMU'],
    blPrefixes: ['CMDU', 'CMAU'],
  },
  {
    id: 'cosco',
    name: 'COSCO',
    mode: 'sea',
    trackUrl: 'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number={n}',
    containerPrefixes: ['COSU', 'CBHU', 'CSNU', 'CCLU'],
    blPrefixes: ['COSU', 'COAU'],
  },
  {
    id: 'oocl',
    name: 'OOCL',
    mode: 'sea',
    trackUrl: 'https://www.oocl.com/eng/ourservices/eservices/cargotracking/Pages/cargotracking.aspx',
    containerPrefixes: ['OOLU', 'OOCU'],
    blPrefixes: ['OOLU'],
  },
  {
    id: 'hapag',
    name: 'Hapag-Lloyd',
    mode: 'sea',
    trackUrl: 'https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container={n}',
    containerPrefixes: ['HLCU', 'HLXU', 'HLBU', 'UACU'],
    blPrefixes: ['HLCU'],
  },
  {
    id: 'one',
    name: 'ONE (Ocean Network Express)',
    mode: 'sea',
    trackUrl: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam={n}',
    containerPrefixes: ['ONEU', 'NYKU', 'MOLU', 'KKFU'],
    blPrefixes: ['ONEY'],
  },
  {
    id: 'evergreen',
    name: 'Evergreen',
    mode: 'sea',
    trackUrl: 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do',
    containerPrefixes: ['EGHU', 'EISU', 'EMCU', 'EGSU'],
    blPrefixes: ['EGLV'],
  },
  {
    id: 'hmm',
    name: 'HMM',
    mode: 'sea',
    trackUrl: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do',
    containerPrefixes: ['HDMU', 'HMMU'],
    blPrefixes: ['HDMU'],
  },
  {
    id: 'yangming',
    name: 'Yang Ming',
    mode: 'sea',
    trackUrl: 'https://www.yangming.com/e-service/Track_Trace/track_trace_cargo_tracking.aspx',
    containerPrefixes: ['YMLU', 'YMMU'],
    blPrefixes: ['YMLU', 'YMJA'],
  },
  {
    id: 'zim',
    name: 'ZIM',
    mode: 'sea',
    trackUrl: 'https://www.zim.com/tools/track-a-shipment?consnumber={n}',
    containerPrefixes: ['ZIMU', 'ZCSU'],
    blPrefixes: ['ZIMU'],
  },
  {
    id: 'wanhai',
    name: 'Wan Hai',
    mode: 'sea',
    trackUrl: 'https://www.wanhai.com/views/cargoTrack/CargoTrack.xhtml',
    containerPrefixes: ['WHLU', 'WHSU'],
    blPrefixes: ['WHLC'],
  },
  {
    id: 'pil',
    name: 'PIL',
    mode: 'sea',
    trackUrl: 'https://www.pilship.com/en--/120.html',
    containerPrefixes: ['PCIU'],
    blPrefixes: ['PCIU'],
  },
  {
    id: 'turkon',
    name: 'Turkon Line',
    mode: 'sea',
    trackUrl: 'https://www.turkon.com/en/container-tracking',
    containerPrefixes: ['TRKU'],
  },
  {
    id: 'arkas',
    name: 'Arkas Line',
    mode: 'sea',
    trackUrl: 'https://www.arkasline.com.tr/',
    containerPrefixes: ['ARKU'],
  },
  {
    // Container whose owner code is a lessor / unknown — the number is valid,
    // but the operating line must come from the B/L or be chosen by hand.
    id: 'sea-generic',
    name: 'Морська лінія (не визначено)',
    mode: 'sea',
    trackUrl: 'https://www.track-trace.com/container',
  },

  // ── Air cargo (AWB prefix = IATA airline accounting code) ──────────────────
  { id: 'aa', name: 'American Airlines Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['001'] },
  { id: 'dl', name: 'Delta Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['006'] },
  { id: 'ua', name: 'United Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['016'] },
  { id: 'lh', name: 'Lufthansa Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['020'] },
  { id: 'fx-air', name: 'FedEx Express (air)', mode: 'air', trackUrl: '', awbPrefixes: ['023'] },
  { id: 'af', name: 'Air France Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['057'] },
  { id: 'kl', name: 'KLM Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['074'] },
  { id: 'ay', name: 'Finnair Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['105'] },
  { id: 'ba', name: 'IAG Cargo (British Airways)', mode: 'air', trackUrl: '', awbPrefixes: ['125'] },
  { id: 'jl', name: 'JAL Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['131'] },
  { id: 'qr', name: 'Qatar Airways Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['157'] },
  { id: 'cx', name: 'Cathay Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['160'] },
  { id: 'cv', name: 'Cargolux', mode: 'air', trackUrl: '', awbPrefixes: ['172'] },
  { id: 'ek', name: 'Emirates SkyCargo', mode: 'air', trackUrl: '', awbPrefixes: ['176'] },
  { id: 'ke', name: 'Korean Air Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['180'] },
  { id: 'nh', name: 'ANA Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['205'] },
  { id: 'tk', name: 'Turkish Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['235'] },
  { id: 'ci', name: 'China Airlines Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['297'] },
  { id: 'ps', name: 'МАУ (Ukraine International)', mode: 'air', trackUrl: '', awbPrefixes: ['566'] },
  { id: 'ey', name: 'Etihad Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['607'] },
  { id: 'sq', name: 'Singapore Airlines Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['618'] },
  { id: 'br', name: 'EVA Air Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['695'] },
  { id: 'lx', name: 'Swiss WorldCargo', mode: 'air', trackUrl: '', awbPrefixes: ['724'] },
  { id: 'mu', name: 'China Eastern Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['781'] },
  { id: 'cz', name: 'China Southern Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['784'] },
  { id: 'ca', name: 'Air China Cargo', mode: 'air', trackUrl: '', awbPrefixes: ['999'] },
  { id: 'air-generic', name: 'Авіаперевізник (не визначено)', mode: 'air', trackUrl: '' },

  // ── Courier / express ──────────────────────────────────────────────────────
  { id: 'dhl', name: 'DHL Express', mode: 'courier', trackUrl: 'https://www.dhl.com/ua-uk/home/tracking.html?tracking-id={n}' },
  { id: 'fedex', name: 'FedEx', mode: 'courier', trackUrl: 'https://www.fedex.com/fedextrack/?trknbr={n}' },
  { id: 'ups', name: 'UPS', mode: 'courier', trackUrl: 'https://www.ups.com/track?tracknum={n}' },
  {
    id: 'tnt',
    name: 'TNT',
    mode: 'courier',
    trackUrl: 'https://www.tnt.com/express/en_gb/site/shipping-tools/tracking.html?searchType=con&cons={n}',
  },
  { id: 'upu', name: 'Міжнародна пошта (UPU)', mode: 'courier', trackUrl: 'https://parcelsapp.com/en/tracking/{n}' },

  // ── Ukrainian domestic ─────────────────────────────────────────────────────
  { id: 'novaposhta', name: 'Нова Пошта', mode: 'domestic', trackUrl: 'https://novaposhta.ua/tracking/?cargo_number={n}' },
  { id: 'ukrposhta', name: 'Укрпошта', mode: 'domestic', trackUrl: 'https://track.ukrposhta.ua/tracking_UA.html?barcode={n}' },
  { id: 'meest', name: 'Meest', mode: 'domestic', trackUrl: 'https://meest.com/' },
  { id: 'delivery', name: 'Делівері', mode: 'domestic', trackUrl: 'https://www.delivery-auto.com/' },
];

const BY_ID = new Map(CARRIERS.map((c) => [c.id, c]));

export function getCarrier(id: string | null | undefined): Carrier | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Public tracking deep link for a number (air → the track-trace AWB aggregator). */
export function trackingUrl(carrierId: string | null | undefined, number: string): string | null {
  const c = getCarrier(carrierId);
  if (!c) return null;
  if (c.mode === 'air') {
    const n = number.replace(/\D/g, '');
    return `https://www.track-trace.com/aircargo?number=${encodeURIComponent(`${n.slice(0, 3)}-${n.slice(3)}`)}`;
  }
  if (!c.trackUrl) return null;
  return c.trackUrl.replace('{n}', encodeURIComponent(number));
}

export function carrierByContainerPrefix(owner: string): Carrier | undefined {
  return CARRIERS.find((c) => c.containerPrefixes?.includes(owner));
}

export function carrierByBlPrefix(prefix: string): Carrier | undefined {
  return CARRIERS.find((c) => c.blPrefixes?.includes(prefix));
}

export function carrierByAwbPrefix(prefix: string): Carrier | undefined {
  return CARRIERS.find((c) => c.awbPrefixes?.includes(prefix));
}
