"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { BrandMark, CodeGate } from "@/components/auth/CodeGate";
import { LegalLinks } from "@/components/legal/LegalLinks";

type Side = "supply" | "shturman";

/**
 * The site entry (spec 008). Поставки by default: one big «Увійти». The corner
 * mark opens the Штурман PIN gate with a shared-element morph: the small square
 * fills the screen, flips its letter (Ш ↔ П) and settles into the other mark.
 */
export function EntryScreen() {
  const router = useRouter();
  const { user, loading, loginWithCode } = useAuth();
  // `/?to=shturman` (the lock screen, an expired session) opens on the Штурман gate.
  const params = useSearchParams();
  const [side, setSide] = useState<Side>(() => (params.get("to") === "shturman" ? "shturman" : "supply"));
  const [first, setFirst] = useState(true);
  const [play, setPlay] = useState(0);
  const [codeLength, setCodeLength] = useState<number | null>(null);
  const moving = useRef(false);
  const supRef = useRef<HTMLDivElement>(null);
  const shRef = useRef<HTMLDivElement>(null);
  const icRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    api<{ codeLogin: boolean; codeLength: number | null }>("/api/auth/methods")
      .then((m) => setCodeLength(m.codeLogin ? m.codeLength : null))
      .catch(() => setCodeLength(null));
  }, []);

  const toggle = useCallback(async () => {
    if (moving.current) return;
    const next: Side = side === "supply" ? "shturman" : "supply";
    const ic = icRef.current;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!ic || reduce || !Element.prototype.animate) {
      setFirst(false);
      setSide(next);
      setPlay((n) => n + 1);
      return;
    }
    moving.current = true;
    const box = (r: { left: number; top: number; width: number; height: number }, radius: string, fs: string) => ({
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: radius, fontSize: fs,
    });
    const cs = getComputedStyle(ic);
    const from = box(ic.getBoundingClientRect(), cs.borderRadius, cs.fontSize);
    const full = box({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, "0px", `${Math.min(window.innerWidth, window.innerHeight) * 0.34}px`);
    const fx = document.createElement("div");
    fx.className = "ent-morph";
    const letter = document.createElement("span");
    letter.textContent = ic.textContent;
    fx.appendChild(letter);
    Object.assign(fx.style, from);
    document.body.appendChild(fx);
    ic.style.visibility = "hidden";

    try {
      // 1 · the corner mark grows over the whole screen
      await fx.animate([from, full], { duration: 560, easing: "cubic-bezier(0.76, 0, 0.24, 1)", fill: "forwards" }).finished;
      // 2 · under full cover: swap the apps and flip the letter
      setFirst(false);
      setSide(next);
      setPlay((n) => n + 1);
      ic.style.visibility = "";
      await letter.animate([{ transform: "rotateY(0deg)", opacity: 1 }, { transform: "rotateY(90deg)", opacity: 0.4 }], { duration: 160, easing: "ease-in", fill: "forwards" }).finished;
      letter.textContent = next === "shturman" ? "Ш" : "П";
      await letter.animate([{ transform: "rotateY(-90deg)", opacity: 0.4 }, { transform: "rotateY(0deg)", opacity: 1 }], { duration: 200, easing: "ease-out", fill: "forwards" }).finished;
      // 3 · settle into the other app's mark while its content rises in
      const layer = next === "shturman" ? shRef.current : supRef.current;
      const target = layer?.querySelector<HTMLElement>(next === "shturman" ? "[data-brand-mark]" : ".ent-mark");
      if (target) {
        target.classList.add("ent-ghost");
        const tcs = getComputedStyle(target);
        await fx.animate([full, box(target.getBoundingClientRect(), tcs.borderRadius, tcs.fontSize)], { duration: 640, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }).finished;
        target.classList.remove("ent-ghost");
      } else {
        await fx.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).finished;
      }
    } finally {
      fx.remove();
      ic.style.visibility = "";
      moving.current = false;
    }
  }, [side]);

  // Keep the address in step with the side, so a reload stays where you are.
  useEffect(() => {
    window.history.replaceState(null, "", side === "shturman" ? "/?to=shturman" : "/");
  }, [side]);

  useEffect(() => {
    if (side !== "shturman") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [side, toggle]);

  const isSh = side === "shturman";

  return (
    <div className="ent">
      <div ref={supRef} className={`ent-layer ent-sup${first ? " ent-first" : ""} ent-in`} hidden={isSh} key={`sup-${play}`} aria-hidden={isSh}>
        <div className="ent-atmo" />
        <div className="ent-dots" />
        <div className="ent-col">
          <span className="ent-mark" aria-hidden="true">П</span>
          <h1 className="ent-name ent-rv" style={{ ["--d" as string]: 120 }}>Поставки</h1>
          <Link className="ent-enter ent-rv" style={{ ["--d" as string]: 240 }} href="/supply">
            Увійти
            <span className="arr">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </Link>
        </div>
      </div>

      <div ref={shRef} className="ent-layer ent-sh ent-in" hidden={!isSh} key={`sh-${play}`} aria-hidden={!isSh}>
        <div className="ent-atmo" />
        <div className="ent-dots" />
        {isSh &&
          (!loading && user ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
              <BrandMark />
              <div className="ent-rv" style={{ ["--d" as string]: 60, marginTop: 18, fontSize: 22, fontWeight: 700, letterSpacing: 1.5 }}>ШТУРМАН</div>
              <div className="ent-rv" style={{ ["--d" as string]: 120, marginTop: 6, fontSize: 14, color: "var(--muted)" }}>Ви вже увійшли</div>
              <button className="btn btn-primary ent-btn ent-rv" style={{ ["--d" as string]: 180 }} onClick={() => router.push("/workspaces")}>Продовжити</button>
            </div>
          ) : codeLength ? (
            <CodeGate codeLength={codeLength} loginWithCode={loginWithCode} router={router} onWantEmail={() => router.push("/login")} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
              <BrandMark />
              <div style={{ marginTop: 18, fontSize: 22, fontWeight: 700, letterSpacing: 1.5 }}>ШТУРМАН</div>
              <button className="btn btn-primary ent-btn" onClick={() => router.push("/login")}>Увійти</button>
            </div>
          ))}
      </div>

      <LegalLinks fixed />

      <button className="ent-switch" onClick={() => void toggle()} aria-label={isSh ? "Повернутись до Поставок" : "Відкрити вхід у Штурман"}>
        <span className="ic" ref={icRef}>{isSh ? "П" : "Ш"}</span>
        <span className="txt">
          {isSh ? "Поставки" : "Штурман"}
          <small>{isSh ? "повернутись" : "вхід за кодом"}</small>
        </span>
      </button>
    </div>
  );
}
