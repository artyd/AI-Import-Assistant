import Link from "next/link";
import { OPERATOR } from "@/lib/legal/operator";
import { LegalLinks } from "./LegalLinks";
import "./legal.css";

export interface LegalSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

/** Shared shell for /privacy and /terms: title, date, contents, sections. */
export function LegalPage({ title, intro, sections }: { title: string; intro: React.ReactNode; sections: LegalSection[] }) {
  return (
    <div className="legal">
      <main className="legal-wrap">
        <div className="legal-top">
          <Link href="/">← На головну</Link>
          <LegalLinks />
        </div>
        <h1>{title}</h1>
        <p className="legal-date">Остання редакція: {OPERATOR.effectiveDate}</p>
        <div className="legal-note">{intro}</div>
        <nav className="legal-toc" aria-label="Зміст">
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>
        {sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
            <h2 id={`${s.id}-h`}>{s.title}</h2>
            {s.body}
          </section>
        ))}
      </main>
    </div>
  );
}
