// Lucide-style stroke icons, inlined to match the ШТУРМАН.dc.html mock exactly
// (the FA fill glyphs in icons.tsx are a different, heavier look). Stroke inherits
// currentColor; callers set colour + size.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function S({ size = 18, children, strokeWidth = 1.9, ...p }: P & { children: React.ReactNode }) {
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

export const LnPanelLeft = (p: P) => (
  <S {...p} strokeWidth={2}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </S>
);
export const LnPanelRight = (p: P) => (
  <S {...p} strokeWidth={2}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </S>
);
export const LnPencil = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
);
export const LnFolder = (p: P) => (
  <S {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </S>
);
export const LnFolderPlus = (p: P) => (
  <S {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </S>
);
export const LnSearch = (p: P) => (
  <S {...p} strokeWidth={2}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </S>
);
export const LnChat = (p: P) => (
  <S {...p} strokeWidth={1.8}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </S>
);
export const LnTrash = (p: P) => (
  <S {...p}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </S>
);
export const LnChevronDown = (p: P) => (
  <S {...p} strokeWidth={2.2}>
    <path d="m6 9 6 6 6-6" />
  </S>
);
export const LnChevronRight = (p: P) => (
  <S {...p} strokeWidth={2.2}>
    <path d="m9 18 6-6-6-6" />
  </S>
);
export const LnCheck = (p: P) => (
  <S {...p} strokeWidth={3}>
    <path d="M20 6 9 17l-5-5" />
  </S>
);
export const LnX = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="M18 6 6 18M6 6l12 12" />
  </S>
);
export const LnSun = (p: P) => (
  <S {...p} strokeWidth={2}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </S>
);
export const LnMoon = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </S>
);
export const LnSoundOn = (p: P) => (
  <S {...p}>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
  </S>
);
export const LnSoundOff = (p: P) => (
  <S {...p}>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </S>
);
export const LnLock = (p: P) => (
  <S {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </S>
);
export const LnPlus = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </S>
);
export const LnPlusSmall = (p: P) => (
  <S {...p} strokeWidth={2.2}>
    <path d="M12 5v14M5 12h14" />
  </S>
);
export const LnUpload = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="M12 3v12" />
    <path d="m7 8 5-5 5 5" />
    <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </S>
);
export const LnSend = (p: P) => (
  <S {...p} strokeWidth={2.2}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </S>
);
export const LnAttach = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </S>
);
export const LnList = (p: P) => (
  <S {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </S>
);
export const LnGrid = (p: P) => (
  <S {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </S>
);
export const LnExport = (p: P) => (
  <S {...p} strokeWidth={2}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </S>
);
export const LnFilePdf = (p: P) => (
  <S {...p} strokeWidth={1.8}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </S>
);
export const LnFileSheet = (p: P) => (
  <S {...p} strokeWidth={1.8}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8M8 17h8M13 13v4" />
  </S>
);
export const LnFileDoc = (p: P) => (
  <S {...p} strokeWidth={1.8}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M16 13H8M16 17H8M10 9H8" />
  </S>
);
export const LnFileImg = (p: P) => (
  <S {...p} strokeWidth={1.8}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </S>
);
export const LnFile = (p: P) => (
  <S {...p} strokeWidth={1.8}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </S>
);
export const LnHistory = (p: P) => (
  <S {...p}>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l4 2" />
  </S>
);
export const LnRefresh = (p: P) => (
  <S {...p}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </S>
);
