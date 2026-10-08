import { config } from '../../config.js';

/** Tabs of the team Google Sheet that Штурман reads (gids from env; empty = off). */
export type SheetTab = 'tracking' | 'warehouse' | 'rates' | 'quantities';

export function sheetTabs(): Array<{ tab: SheetTab; gid: string }> {
  const all: Array<{ tab: SheetTab; gid: string }> = [
    { tab: 'tracking', gid: config.SHEET_GID_TRACKING },
    { tab: 'warehouse', gid: config.SHEET_GID_WAREHOUSE },
    { tab: 'rates', gid: config.SHEET_GID_RATES },
    { tab: 'quantities', gid: config.SHEET_GID_QUANTITIES },
  ];
  return all.filter((t) => t.gid);
}

export function sheetEnabled(): boolean {
  return !!config.SHEET_ID;
}

/** Link that opens the sheet at a row (or just the tab). */
export function sheetRowUrl(tab: SheetTab, rowIndex?: number): string | null {
  const gid = sheetTabs().find((t) => t.tab === tab)?.gid;
  if (!config.SHEET_ID || !gid) return null;
  const base = `https://docs.google.com/spreadsheets/d/${config.SHEET_ID}/edit#gid=${gid}`;
  return rowIndex ? `${base}&range=A${rowIndex}` : base;
}
