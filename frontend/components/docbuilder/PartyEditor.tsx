"use client";

// One party of a document (seller / buyer / consignee / consignor): pick it from
// the team directory in one click, then adjust the snapshot in place if this
// particular document needs it. «＋ У довідник» saves a new company for reuse.
import { useState } from "react";
import type { DirectoryParty, Party, PartyRole } from "@/lib/docbuilder/model";
import { emptyParty, snapshot } from "@/lib/docbuilder/model";
import { Area, Field, Pair, smallBtn } from "./fields";

interface Props {
  title: string;
  party: Party;
  onChange: (p: Party) => void;
  directory: DirectoryParty[];
  /** Directory roles offered first in the picker. */
  roles: PartyRole[];
  onSaveToDirectory?: (p: Party) => Promise<void>;
  /** Fields this role prints; the rest stay hidden. */
  show?: { signatory?: boolean; requisites?: boolean; code?: boolean };
  testId?: string;
}

export function PartyEditor({ title, party, onChange, directory, roles, onSaveToDirectory, show = { signatory: true, requisites: true }, testId }: Props) {
  const [open, setOpen] = useState(!party.nameEn);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const set = (k: keyof Party) => (v: string) => onChange({ ...party, [k]: v });

  const preferred = directory.filter((d) => roles.includes(d.role));
  const others = directory.filter((d) => !roles.includes(d.role));
  const key = (p: Party) => (p.nameEn || p.nameUk).trim().toLowerCase();
  const inDirectory = directory.some((d) => key(d) && key(d) === key(party));
  const named = Boolean(key(party));
  const saved = savedKey !== null && savedKey === key(party);

  return (
    <div data-testid={testId} style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 110 }}>{title}</span>
        <select
          className="input"
          style={{ flex: 1, height: 34, fontSize: 13.5, padding: "0 8px", minWidth: 0 }}
          value=""
          onChange={(e) => {
            if (e.target.value === "__new") {
              onChange(emptyParty());
              setOpen(true);
              return;
            }
            const hit = directory.find((d) => d.id === e.target.value);
            if (hit) {
              onChange(snapshot(hit));
              setOpen(false);
            }
          }}
          data-testid={testId ? `${testId}-pick` : undefined}
        >
          <option value="">{party.nameEn || party.nameUk ? `✓ ${party.nameEn || party.nameUk}` : "Обрати з довідника…"}</option>
          <option value="__new">＋ Нова компанія — ввести вручну</option>
          {preferred.length ? (
            <optgroup label="Найчастіше">
              {preferred.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.nameEn || d.nameUk}
                  {d.code ? ` · ${d.code}` : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          {others.length ? (
            <optgroup label="Інші">
              {others.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.nameEn || d.nameUk}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button type="button" style={smallBtn} onClick={() => setOpen((o) => !o)} data-testid={testId ? `${testId}-toggle` : undefined}>
          {open ? "Згорнути" : "Реквізити"}
        </button>
        {onSaveToDirectory && named && (!inDirectory || saved) ? (
          <button
            type="button"
            style={{ ...smallBtn, color: "var(--accent)" }}
            disabled={saving || saved}
            onClick={async () => {
              setSaving(true);
              try {
                await onSaveToDirectory(party);
                setSavedKey(key(party));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saved ? "✓ У довіднику" : "＋ У довідник"}
          </button>
        ) : null}
      </div>
      {open ? (
        <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 10, background: "var(--panel)" }}>
          {named && !inDirectory && onSaveToDirectory && !saved ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Цієї компанії ще немає в довіднику — після заповнення натисніть «＋ У довідник», щоб наступного разу обрати її одним кліком.
            </div>
          ) : null}
          <Pair>
            <Field label="Назва (EN)" value={party.nameEn} onChange={set("nameEn")} placeholder='"COMPANY" LLC' />
            <Field label="Назва (UA)" value={party.nameUk} onChange={set("nameUk")} placeholder="ТОВ «КОМПАНІЯ»" />
          </Pair>
          <Pair>
            <Field label="Країна (EN)" value={party.countryEn} onChange={set("countryEn")} placeholder="Ukraine" />
            <Field label="Країна (UA)" value={party.countryUk} onChange={set("countryUk")} placeholder="Україна" />
          </Pair>
          {show.signatory ? (
            <>
              <Pair>
                <Field label="Підписант (EN)" value={party.signatoryEn} onChange={set("signatoryEn")} placeholder="Director Ivanenko Olena" />
                <Field label="Підписант (UA, «в особі …»)" value={party.signatoryUk} onChange={set("signatoryUk")} placeholder="Директора Іваненко Олени" />
              </Pair>
              <Pair>
                <Field label="Діє на підставі (EN)" value={party.basisEn} onChange={set("basisEn")} placeholder="Statute" />
                <Field label="Діє на підставі (UA)" value={party.basisUk} onChange={set("basisUk")} placeholder="Статуту" />
              </Pair>
            </>
          ) : null}
          <Pair>
            <Area label="Адреса (EN)" rows={2} value={party.addressEn} onChange={set("addressEn")} />
            <Area label="Адреса (UA)" rows={2} value={party.addressUk} onChange={set("addressUk")} />
          </Pair>
          {show.requisites ? (
            <Pair>
              <Area label="Реквізити та банк (EN)" rows={6} value={party.requisitesEn} onChange={set("requisitesEn")} />
              <Area label="Реквізити та банк (UA)" rows={6} value={party.requisitesUk} onChange={set("requisitesUk")} />
            </Pair>
          ) : null}
          {show.code ? (
            <Field
              label="Суфікс номера контракту"
              value={party.code}
              onChange={set("code")}
              placeholder="PNS"
              hint="Номер контракту = дата + суфікс, напр. 31072026/PNS"
              width={220}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
