// Icon set — flat, minimalist 2D line icons (Lucide-style stroke) matching the
// ШТУРМАН look. This replaces the former Font Awesome *solid* glyphs with the
// stacked drop-shadow "3D" treatment (`.ico3d`). Most names alias the LineIcons
// equivalents; the few without a direct match are defined inline in the same
// stroke style. Import sites are unchanged (same export names + `{size}` API).
import type { SVGProps } from "react";
import {
  LnFolder,
  LnFolderPlus,
  LnFile,
  LnSend,
  LnAttach,
  LnUpload,
  LnRefresh,
  LnHistory,
  LnCheck,
  LnChevronDown,
  LnChevronRight,
  LnSearch,
  LnTrash,
  LnPencil,
  LnMoon,
  LnSun,
  LnPlus,
  LnExport,
} from "./LineIcons";

type P = SVGProps<SVGSVGElement> & { size?: number };

// Shared stroke wrapper (mirrors LineIcons' `S`) for the inline-defined icons.
function L({
  size = 18,
  strokeWidth = 1.9,
  children,
  ...p
}: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...p}
    >
      {children}
    </svg>
  );
}

// ── Aliases to the flat line set (names kept for existing import sites) ──
export const IconFolder = LnFolder;
export const IconFolderPlus = LnFolderPlus;
export const IconFile = LnFile;
export const IconSend = LnSend;
export const IconAttach = LnAttach;
export const IconUpload = LnUpload;
export const IconRefresh = LnRefresh;
export const IconHistory = LnHistory;
export const IconCheck = LnCheck;
export const IconChevronDown = LnChevronDown;
export const IconChevronRight = LnChevronRight;
export const IconSearch = LnSearch;
export const IconTrash = LnTrash;
export const IconEdit = LnPencil;
export const IconMoon = LnMoon;
export const IconSun = LnSun;
export const IconPlus = LnPlus;
export const IconDownload = LnExport;

// ── Bespoke / not in LineIcons — inline, same minimalist stroke style ──

// Штурман brand mark (kept — now flat, no 3D shadow).
export const IconLogo = ({ size = 18, ...p }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...p}
  >
    <circle cx="6" cy="12" r="3.2" />
    <circle cx="21" cy="12" r="2" fill="currentColor" />
    <path d="M9.2 12h9" />
  </svg>
);

export const IconBell = (p: P) => (
  <L {...p}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </L>
);

export const IconClock = (p: P) => (
  <L {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </L>
);

export const IconLogout = (p: P) => (
  <L {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </L>
);

export const IconAgent = (p: P) => (
  <L {...p}>
    <rect x="4" y="8" width="16" height="11" rx="2.5" />
    <path d="M12 8V4.5" />
    <circle cx="12" cy="3.2" r="1.1" />
    <path d="M9 13h.01M15 13h.01" />
  </L>
);

export const IconSpinner = ({ className, ...p }: P) => (
  <L {...p} className={`spin ${className ?? ""}`.trim()}>
    <path d="M21 12a9 9 0 1 1-6.2-8.6" opacity="0.9" />
  </L>
);
