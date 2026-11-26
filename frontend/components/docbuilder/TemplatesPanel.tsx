"use client";

// «Шаблони»: the team's own Word templates. Download the standard one, change
// the wording / letterhead in Word keeping the {tags}, upload it back — every
// document of that kind can then pick it. A broken template is rejected with
// the reason (docxtemplater's explanation) before it is stored.
import { useEffect, useRef, useState } from "react";
import * as api from "@/lib/docbuilder/api";
import type { DocKind, TemplateInfo } from "@/lib/docbuilder/model";
import { KIND_SUBTITLE } from "@/lib/docbuilder/model";
import { Field, Select, smallBtn } from "./fields";

const KINDS: DocKind[] = ["contract", "appendix", "invoice", "ua_invoice"];

export function TemplatesPanel({ templates, onChange }: { templates: TemplateInfo[]; onChange: (list: TemplateInfo[]) => void }) {
  const [kind, setKind] = useState<DocKind>("invoice");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<{ tag: string; example: string }[] | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTags(null);
  }, [kind]);

  const upload = async (f: File) => {
    setBusy(true);
    setError(null);
    try {
      const t = await api.uploadTemplate(kind, name.trim() || f.name.replace(/\.docx$/i, ""), f);
      onChange([...templates, t]);
      setName("");
    } catch (e) {
      setError((e as Error).message || "Шаблон не прийнято");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="dir-templates" style={{ display: "grid", gap: 14 }}>
      <div style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--surface)", display: "grid", gap: 10 }}>
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          1) Завантажте стандартний шаблон. 2) Змініть у Word текст, бланк чи печатку — поля в фігурних дужках (<code>{"{number}"}</code>, <code>{"{#items}…{/items}"}</code>) залиште як є. 3) Завантажте
          файл назад — Штурман перевірить, що він заповнюється, і він зʼявиться у виборі «Шаблон Word» документа. Для продавця з іншим бланком інвойсу оберіть його шаблон у картці продавця.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr auto auto auto", gap: 10, alignItems: "end" }}>
          <Select label="Тип документа" value={kind} options={KINDS.map((k) => ({ value: k, label: KIND_SUBTITLE[k] }))} onChange={setKind} testId="tpl-kind" />
          <Field label="Назва шаблону" value={name} onChange={setName} placeholder="напр. Інвойс ACME (бланк)" />
          <button type="button" style={{ ...smallBtn, height: 34 }} onClick={() => api.downloadTemplateFile(`/api/docbuilder/templates/default/${kind}`, `template_${kind}.docx`)} data-testid="tpl-download-default">
            Стандартний .docx
          </button>
          <button type="button" style={{ ...smallBtn, height: 34 }} onClick={async () => setTags(await api.templateTags(kind))} data-testid="tpl-show-tags">
            Список полів
          </button>
          <button type="button" className="btn btn-primary" style={{ height: 34, fontSize: 13 }} disabled={busy} onClick={() => file.current?.click()} data-testid="tpl-upload">
            {busy ? "Перевіряю…" : "Завантажити свій"}
          </button>
          <input
            ref={file}
            type="file"
            accept=".docx"
            style={{ display: "none" }}
            data-testid="tpl-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </div>
        {error ? <div style={{ fontSize: 13, color: "var(--err)" }}>{error}</div> : null}
        {tags ? (
          <div style={{ maxHeight: 260, overflowY: "auto", fontSize: 12.5, display: "grid", gridTemplateColumns: "minmax(0, 260px) minmax(0, 1fr)", gap: "3px 12px" }}>
            {tags.map((t) => (
              <div key={t.tag} style={{ display: "contents" }}>
                <code style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.tag}</code>
                <span style={{ color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.example}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {KINDS.map((k) => {
        const list = templates.filter((t) => t.kind === k);
        return (
          <div key={k}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 2px 6px" }}>
              {KIND_SUBTITLE[k]} · {list.length + 1}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", border: "1px dashed var(--border)", borderRadius: 10, fontSize: 13 }}>
                <span style={{ flex: 1 }}>Стандартний — з документів команди</span>
                <button type="button" style={smallBtn} onClick={() => api.downloadTemplateFile(`/api/docbuilder/templates/default/${k}`, `template_${k}.docx`)}>
                  Завантажити
                </button>
              </div>
              {list.map((t) => (
                <div key={t.id} data-testid="tpl-row" style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", fontSize: 13 }}>
                  <span style={{ flex: 1, fontWeight: 600 }}>{t.name}</span>
                  <button type="button" style={smallBtn} onClick={() => api.downloadTemplateFile(`/api/docbuilder/templates/${t.id}/file`, `${t.name}.docx`)}>
                    Завантажити
                  </button>
                  {confirmDel === t.id ? (
                    <button
                      type="button"
                      style={{ ...smallBtn, color: "#fff", background: "var(--err)", borderColor: "var(--err)" }}
                      onClick={async () => {
                        await api.deleteTemplate(t.id);
                        onChange(templates.filter((x) => x.id !== t.id));
                        setConfirmDel(null);
                      }}
                    >
                      Так, видалити
                    </button>
                  ) : (
                    <button type="button" style={{ ...smallBtn, color: "var(--err)" }} onClick={() => setConfirmDel(t.id)}>
                      Видалити
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
