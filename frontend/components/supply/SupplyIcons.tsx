// Line icons for Поставки (24×24, stroke = currentColor).

type P = { size?: number };
const svg = (size: number, children: React.ReactNode, sw = 2.1) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IList = ({ size = 21 }: P) => svg(size, <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />, 2.3);
export const ICal = ({ size = 21 }: P) => svg(size, <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
export const IArch = ({ size = 21 }: P) => svg(size, <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" /></>);
export const IHist = ({ size = 21 }: P) => svg(size, <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3" />);
export const ISet = ({ size = 21 }: P) => svg(size, <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" /></>);
export const ILock = ({ size = 20 }: P) => svg(size, <><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 2.2);
export const IUnlock = ({ size = 20 }: P) => svg(size, <><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>, 2.2);
export const ISearch = ({ size = 15 }: P) => svg(size, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, 2.2);
export const IFlag = ({ size = 13 }: P) => svg(size, <path d="M5 21V4M5 4h11l-2 4 2 4H5" />, 2.2);
export const ICheck = ({ size = 13 }: P) => svg(size, <path d="m5 12.5 4.5 4.5L19 7.5" />, 2.6);
export const IChev = ({ size = 18 }: P) => svg(size, <path d="m9 6 6 6-6 6" />, 2.3);
export const IPlus = ({ size = 14 }: P) => svg(size, <path d="M12 5v14M5 12h14" />, 2.6);
export const IX = ({ size = 15 }: P) => svg(size, <path d="M6 6l12 12M18 6 6 18" />, 2.3);
export const IDl = ({ size = 15 }: P) => svg(size, <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />, 2.2);
export const ITrash = ({ size = 14 }: P) => svg(size, <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />, 2);
export const IUp = ({ size = 14 }: P) => svg(size, <path d="m6 15 6-6 6 6" />, 2.3);
export const IDown = ({ size = 14 }: P) => svg(size, <path d="m6 9 6 6 6-6" />, 2.3);
export const IExit = ({ size = 21 }: P) => svg(size, <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M9 8l-4 4 4 4M5 12h11" /></>);
export const ICompass = ({ size = 22 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2} />
    <path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor" />
  </svg>
);
