import Link from "next/link";
import "./legal.css";

/** Discreet «Конфіденційність · Умови» line for the public pages and the app. */
export function LegalLinks({ fixed = false, style }: { fixed?: boolean; style?: React.CSSProperties }) {
  return (
    <div className={`legal-foot${fixed ? " legal-foot-fixed" : ""}`} style={style} data-testid="legal-links">
      <Link href="/privacy">Конфіденційність</Link>
      <span aria-hidden="true">·</span>
      <Link href="/terms">Умови</Link>
    </div>
  );
}
