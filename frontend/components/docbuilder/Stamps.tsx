"use client";

// Печатки й підписи: the team's stamp library (a tab of the directory) and the
// «where does which stamp go» block of every document. A placement is a stamp,
// a place the template offers (requisites, specification, every page…), a
// width in mm and a fine shift; the server presses it onto the Word file.
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/docbuilder/api";
import type { DirectoryParty, DocData, DocKind, Party, StampInfo, StampPlace, StampPlacement } from "@/lib/docbuilder/model";
import { prepareStamp } from "@/lib/docbuilder/stampImage";
import { Dropdown, type DropdownOption } from "@/components/ui/Dropdown";
import { Section, labelStyle, smallBtn } from "./fields";

// ---------------------------------------------------------------- thumbnails

export function StampThumb({ id, size = 40, title }: { id: string; size?: number; title?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .stampImageUrl(id)
      .then((u) => alive && setSrc(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <span
      className="stamp-checker"
      title={title}
      style={{ width: size, height: size, flex: "none", borderRadius: Math.max(6, size / 6), border: "1px solid var(--border)", display: "grid", placeItems: "center", overflow: "hidden" }}
    >
      {src ? <img src={src} alt="" style={{ maxWidth: "92%", maxHeight: "92%", objectFit: "contain" }} /> : null}
    </span>
  );
}

const partyName = (p: Pick<Party, "nameEn" | "nameUk">) => p.nameUk || p.nameEn;
const NO_COMPANY = "Без компанії";

function stampOptions(stamps: StampInfo[], parties: DirectoryParty[]): DropdownOption[] {
  const byId = new Map(parties.map((p) => [p.id, p]));
  return [...stamps]
    .map((s) => ({ s, group: s.partyId && byId.get(s.partyId) ? partyName(byId.get(s.partyId)!) : NO_COMPANY }))
    .sort((a, b) => (a.group === NO_COMPANY ? 1 : 0) - (b.group === NO_COMPANY ? 1 : 0) || a.group.localeCompare(b.group) || a.s.name.localeCompare(b.s.name, "uk", { numeric: true }))
    .map(({ s, group }) => ({ value: s.id, label: s.name, group, icon: <StampThumb id={s.id} size={30} /> }));
}

// ---------------------------------------------------------------- document block

/** Which side a place belongs to (the stamp of that party is suggested). */
const sideOf = (place: string): "seller" | "buyer" => (place.includes("buyer") ? "buyer" : "seller");

function sameCompany(a: Pick<Party, "nameEn" | "nameUk">, b: Pick<Party, "nameEn" | "nameUk">): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[«»"'“”]/g, "").replace(/\s+/g, " ").trim();
  return (!!a.nameEn && n(a.nameEn) === n(b.nameEn)) || (!!a.nameUk && n(a.nameUk) === n(b.nameUk));
}

/** The stamp to suggest for a place: one of the company on that side, else the only one there is. */
export function suggestStamp(kind: DocKind, data: DocData, place: string, stamps: StampInfo[], parties: DirectoryParty[]): StampInfo | null {
  const side = sideOf(place);
  const docParty = kind === "invoice" ? null : ((data as { seller?: Party; buyer?: Party })[side] ?? null);
  const dirParty = docParty ? parties.find((p) => sameCompany(p, docParty)) : side === "seller" ? parties.find((p) => p.role === "seller") : undefined;
  const own = dirParty ? stamps.filter((s) => s.partyId === dirParty.id) : [];
  return own[0] ?? (stamps.length === 1 ? stamps[0]! : null);
}

const defaultSize = (s: StampInfo | undefined) => (s && s.width / Math.max(1, s.height) > 1.3 ? 52 : 38);

export function StampsSection({
  kind,
  data,
  onChange,
  stamps,
  places,
  parties,
  onOpenLibrary,
}: {
  kind: DocKind;
  data: DocData;
  onChange: (d: DocData) => void;
  stamps: StampInfo[];
  places: StampPlace[];
  parties: DirectoryParty[];
  onOpenLibrary: () => void;
}) {
  const list = data.stamps ?? [];
  const set = (next: StampPlacement[]) => onChange({ ...data, stamps: next } as DocData);
  const patch = (i: number, p: Partial<StampPlacement>) => set(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const options = useMemo(() => stampOptions(stamps, parties), [stamps, parties]);
  const byId = useMemo(() => new Map(stamps.map((s) => [s.id, s])), [stamps]);
  const placeOptions: DropdownOption[] = places.map((p) => ({ value: p.place, label: p.label }));

  const add = (place: StampPlace) => {
    const s = suggestStamp(kind, data, place.place, stamps, parties) ?? stamps[0];
    if (!s) return;
    set([...list, { stampId: s.id, place: place.place, size: defaultSize(s), dx: place.dx, dy: place.dy }]);
  };
  const used = new Set(list.map((p) => p.place));

  return (
    <Section
      title="Печатки й підписи"
      testId="docb-stamps"
      aside={<span style={{ fontSize: 12.5, color: "var(--muted)" }}>{list.length ? `на документі: ${list.length}` : "без печаток"}</span>}
    >
      {stamps.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "1px dashed var(--border)", fontSize: 13 }}>
          <span style={{ flex: 1, color: "var(--muted)" }}>У довіднику ще немає печаток. Завантажте PNG печаток і підписів — потім їх можна ставити в будь-який документ.</span>
          <button type="button" className="btn btn-primary" style={{ height: 32, fontSize: 13 }} onClick={onOpenLibrary} data-testid="stamps-open-library">
            Завантажити печатки
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--muted)", marginRight: 2 }}>Поставити:</span>
            {places.map((p) => (
              <button
                key={p.place}
                type="button"
                onClick={() => add(p)}
                data-testid={`stamp-add-${p.place}`}
                style={{ ...smallBtn, height: 28, borderStyle: used.has(p.place) ? "solid" : "dashed", color: used.has(p.place) ? "var(--muted)" : "var(--accent)" }}
              >
                ＋ {p.label}
              </button>
            ))}
          </div>
          {list.map((pl, i) => {
            const s = byId.get(pl.stampId);
            const def = places.find((p) => p.place === pl.place);
            const nudge = (dx: number, dy: number) => patch(i, { dx: Math.round((pl.dx + dx) * 10) / 10, dy: Math.round((pl.dy + dy) * 10) / 10 });
            return (
              <div
                key={i}
                data-testid="stamp-placement"
                style={{ position: "relative", display: "grid", gridTemplateColumns: "64px minmax(0,1fr)", gap: 12, padding: "10px 44px 10px 10px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg)" }}
              >
                {s ? <StampThumb id={s.id} size={64} title={s.name} /> : <span className="stamp-checker" style={{ width: 64, height: 64, borderRadius: 10, border: "1px dashed var(--err)" }} />}
                <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
                    <div style={{ minWidth: 170, flex: "1.2 1 170px" }}>
                      <span style={labelStyle}>Печатка</span>
                      <Dropdown block value={pl.stampId} options={s ? options : [{ value: pl.stampId, label: "Видалена з довідника" }, ...options]} onChange={(v) => patch(i, { stampId: v })} testId={`stamp-pick-${i}`} menuWidth={300} activeTint={false} />
                    </div>
                    <div style={{ minWidth: 170, flex: "1 1 170px" }}>
                      <span style={labelStyle}>Місце в документі</span>
                      <Dropdown
                        block
                        value={pl.place}
                        options={def ? placeOptions : [{ value: pl.place, label: pl.place }, ...placeOptions]}
                        onChange={(v) => {
                          const d = places.find((p) => p.place === v);
                          patch(i, { place: v, dx: d?.dx ?? pl.dx, dy: d?.dy ?? pl.dy });
                        }}
                        testId={`stamp-place-${i}`}
                        activeTint={false}
                      />
                    </div>
                    <button type="button" title="Прибрати печатку" aria-label="Прибрати печатку" style={{ ...smallBtn, position: "absolute", top: 10, right: 10, width: 28, padding: 0, color: "var(--err)" }} onClick={() => set(list.filter((_, j) => j !== i))} data-testid={`stamp-remove-${i}`}>
                      ✕
                    </button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, flex: "1 1 200px", minWidth: 0 }}>
                      <span style={{ color: "var(--muted)", width: 52 }}>Розмір</span>
                      <input type="range" min={15} max={80} step={1} value={pl.size} onChange={(e) => patch(i, { size: Number(e.target.value) })} style={{ flex: 1, minWidth: 60, accentColor: "var(--accent)" }} data-testid={`stamp-size-${i}`} aria-label="Розмір печатки, мм" />
                      <b style={{ width: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pl.size} мм</b>
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12.5, flexWrap: "wrap" }}>
                      <span style={{ color: "var(--muted)", marginRight: 4 }}>Зсув</span>
                      {(
                        [
                          ["←", -2, 0, "Ліворуч на 2 мм"],
                          ["↑", 0, -2, "Вгору на 2 мм"],
                          ["↓", 0, 2, "Вниз на 2 мм"],
                          ["→", 2, 0, "Праворуч на 2 мм"],
                        ] as const
                      ).map(([t, dx, dy, label]) => (
                        <button key={t} type="button" title={label} aria-label={label} onClick={() => nudge(dx, dy)} style={{ ...smallBtn, width: 28, padding: 0, height: 28 }} data-testid={`stamp-nudge-${i}-${t}`}>
                          {t}
                        </button>
                      ))}
                      <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", minWidth: 86, textAlign: "center" }}>
                        x {pl.dx} · y {pl.dy} мм
                      </span>
                      {def && (pl.dx !== def.dx || pl.dy !== def.dy) ? (
                        <button type="button" style={{ ...smallBtn, height: 28 }} onClick={() => patch(i, { dx: def.dx, dy: def.dy })}>
                          Скинути
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.45 }}>
            Печатка лягає поверх тексту, як справжня. Приблизне місце видно в перегляді праворуч; точне — у «PDF» перегляду або після завантаження Word.
            {kind === "invoice" && list.some((p) => p.place === "invoice" || p.place === "packing") ? " Вбудована печатка бланка вимикається, коли додано свою." : ""}
          </div>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- library (directory tab)

export function StampsPanel({ stamps, parties, onChange }: { stamps: StampInfo[]; parties: DirectoryParty[]; onChange: (list: StampInfo[]) => void }) {
  const [company, setCompany] = useState<string>("");
  const [removeWhite, setRemoveWhite] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const byId = new Map(parties.map((p) => [p.id, p]));

  const companyOptions: DropdownOption[] = [
    { value: "", label: NO_COMPANY },
    ...parties.map((p) => ({ value: p.id, label: partyName(p), hint: p.nameUk && p.nameEn ? p.nameEn : undefined })),
  ];

  const upload = async (files: File[]) => {
    const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
    if (!images.length) {
      setError("Потрібні зображення: PNG (краще з прозорим тлом) або JPG.");
      return;
    }
    setError(null);
    setProgress({ done: 0, total: images.length });
    const added: StampInfo[] = [];
    const party = company ? byId.get(company) : undefined;
    try {
      for (const f of images) {
        const blob = await prepareStamp(f, { removeWhite });
        const base = f.name.replace(/\.[^.]+$/, "");
        const name = party && !base.toLowerCase().includes(partyName(party).toLowerCase()) ? `${partyName(party)} · ${base}` : base;
        added.push(await api.uploadStamp(blob, name.slice(0, 200), company || null));
        setProgress({ done: added.length, total: images.length });
      }
    } catch (e) {
      setError((e as Error).message || "Не вдалося завантажити печатку");
    } finally {
      onChange([...stamps, ...added]);
      setProgress(null);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, StampInfo[]>();
    for (const s of stamps) {
      const key = s.partyId && byId.get(s.partyId) ? partyName(byId.get(s.partyId)!) : NO_COMPANY;
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === NO_COMPANY ? 1 : 0) - (b[0] === NO_COMPANY ? 1 : 0) || a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamps, parties]);

  const save = async (id: string, p: { name?: string; partyId?: string | null }) => {
    const s = await api.updateStamp(id, p);
    onChange(stamps.map((x) => (x.id === id ? s : x)));
  };

  return (
    <div data-testid="dir-stamps" style={{ display: "grid", gap: 14 }}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload([...e.dataTransfer.files]);
        }}
        style={{
          border: `1.5px dashed ${drag ? "var(--accent)" : "var(--border)"}`,
          background: drag ? "color-mix(in srgb, var(--accent) 7%, var(--surface))" : "var(--surface)",
          borderRadius: 14,
          padding: 16,
          display: "grid",
          gap: 12,
          transition: "background .12s, border-color .12s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span aria-hidden style={{ width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", fontSize: 22, background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}>
            ⬆
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Перетягніть сюди печатки й підписи</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>PNG або JPG, можна кілька файлів одразу. Біле тло стане прозорим, порожні поля обріжуться.</div>
          </div>
          <button type="button" className="btn btn-primary" style={{ height: 34, fontSize: 13 }} onClick={() => fileRef.current?.click()} disabled={!!progress} data-testid="stamps-upload">
            {progress ? `Завантажую ${progress.done} з ${progress.total}…` : "Вибрати файли"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            data-testid="stamps-file"
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", fontSize: 13 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--muted)" }}>Чиї печатки:</span>
            <Dropdown value={company} options={companyOptions} onChange={setCompany} testId="stamps-company" menuWidth={320} />
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} />
            Прибрати біле тло
          </label>
        </div>
        {error ? <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div> : null}
      </div>

      {stamps.length === 0 ? <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>Бібліотека порожня.</p> : null}
      {groups.map(([group, list]) => (
        <div key={group}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 2px 8px" }}>
            {group} · {list.length}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {list.map((s) => (
              <div key={s.id} data-testid="stamp-card" style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", padding: 10, display: "grid", gap: 8 }}>
                <div className="stamp-checker" style={{ height: 120, borderRadius: 8, display: "grid", placeItems: "center", overflow: "hidden" }}>
                  <StampImg id={s.id} />
                </div>
                <input
                  className="input"
                  defaultValue={s.name}
                  aria-label="Назва печатки"
                  style={{ height: 30, fontSize: 13, padding: "0 8px" }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== s.name) void save(s.id, { name: v });
                  }}
                />
                <Dropdown block size="sm" value={s.partyId ?? ""} options={companyOptions} onChange={(v) => void save(s.id, { partyId: v || null })} menuWidth={300} activeTint={false} />
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--faint)" }}>
                  <span style={{ flex: 1 }}>
                    {s.width}×{s.height} px
                  </span>
                  {confirmDel === s.id ? (
                    <>
                      <button
                        type="button"
                        style={{ ...smallBtn, height: 24, color: "#fff", background: "var(--err)", borderColor: "var(--err)" }}
                        onClick={() =>
                          void api.deleteStamp(s.id).then(() => {
                            setConfirmDel(null);
                            onChange(stamps.filter((x) => x.id !== s.id));
                          })
                        }
                      >
                        Видалити
                      </button>
                      <button type="button" style={{ ...smallBtn, height: 24 }} onClick={() => setConfirmDel(null)}>
                        Ні
                      </button>
                    </>
                  ) : (
                    <button type="button" style={{ ...smallBtn, height: 24, color: "var(--err)" }} onClick={() => setConfirmDel(s.id)}>
                      Видалити
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StampImg({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .stampImageUrl(id)
      .then((u) => alive && setSrc(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return src ? <img src={src} alt="" style={{ maxWidth: "90%", maxHeight: 110, objectFit: "contain" }} /> : null;
}
