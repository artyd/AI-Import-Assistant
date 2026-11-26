"use client";

// «＋ Товар з каталогу» — a searchable list of the team's goods, or an empty row.
import { useMemo, useState } from "react";
import type { DirectoryProduct } from "@/lib/docbuilder/model";
import { smallBtn } from "./fields";

export function ItemPicker({ products, onPick, onBlank }: { products: DirectoryProduct[]; onPick: (p: DirectoryProduct) => void; onBlank: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? products.filter((p) => `${p.nameEn} ${p.nameUk} ${p.manufacturer} ${p.hs}`.toLowerCase().includes(s)) : products;
  }, [q, products]);

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-primary" style={{ height: 32, fontSize: 13 }} onClick={() => setOpen((o) => !o)} data-testid="add-from-catalog">
          ＋ Товар з каталогу
        </button>
        <button type="button" style={{ ...smallBtn, height: 32 }} onClick={onBlank} data-testid="add-blank-item">
          ＋ Порожній рядок
        </button>
      </div>
      {open ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", padding: 8, display: "grid", gap: 6 }}>
          <input className="input" style={{ height: 32, fontSize: 13, padding: "0 10px" }} autoFocus placeholder="Пошук: назва, виробник, код…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 2 }}>
            {hits.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)", padding: 6 }}>
                {products.length ? "Нічого не знайдено." : "Каталог порожній — додайте товар порожнім рядком і натисніть «＋ У каталог»."}
              </div>
            ) : (
              hits.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="nav-row"
                  data-testid="catalog-item"
                  onClick={() => {
                    onPick(p);
                    setOpen(false);
                    setQ("");
                  }}
                  style={{ textAlign: "left", background: "transparent", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", color: "var(--text)", font: "inherit" }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.nameEn || p.nameUk}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    {[p.nameUk && p.nameEn ? p.nameUk : "", p.manufacturer, p.hs ? `HS ${p.hs}` : ""].filter(Boolean).join(" · ")}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
