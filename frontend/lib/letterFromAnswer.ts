// «Скласти лист постачальнику» from a chat answer: the answer's problem table and
// its «Дія» line become the request for the constructor's «Доопрацювати з ШІ».
// Pure — unit-tested.

const strip = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/** Rows of the answer's Markdown tables (no header / separator rows), cells joined. */
function tableRows(md: string): string[] {
  const out: string[] = [];
  let header = true;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      header = true;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator
    if (header) {
      header = false; // the first row of each table is its header
      continue;
    }
    const cells = t.replace(/^\||\|$/g, "").split("|").map(strip).filter((c) => c && c !== "—" && c !== "-");
    if (cells.length) out.push(cells.join(" — "));
  }
  return out;
}

/** Numbered problem lines «N. **Що** — де → що зробити» (the short answer form). */
function listFindings(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]\s/.test(l) && /→|->/.test(l))
    .map((l) => strip(l.replace(/^\d+[.)]\s*/, "")));
}

/** Older answers: a table plus a «Дія» line; current ones: numbered «… → дія» lines. */
function findings(md: string): string[] {
  const table = /(^|\n)\s*(\*\*)?Дія/u.test(md) ? tableRows(md) : [];
  return [...table, ...listFindings(md)];
}

/** True when the answer lists problems with actions — worth a letter. */
export function hasFindings(md: string): boolean {
  return findings(md).length > 0;
}

const MAX = 3800;

/** The request text for «Доопрацювати з ШІ», or null when there is nothing to send. */
export function letterRequest(md: string): string | null {
  const rows = findings(md).filter((r) => !/^Розбіжності немає/u.test(r));
  if (!rows.length) return null;
  const action = md.split("\n").map((l) => strip(l)).find((l) => /^Дія:/u.test(l));
  const body = [
    "Додай у лист постачальнику вимоги виправити або надати те, що виявила перевірка документів.",
    "Лише те, що стосується постачальника (не брокера, не перевізника, не нас); без вигаданих фактів.",
    "Знахідки:",
    ...rows.map((r) => `- ${r}`),
    ...(action ? [action] : []),
  ].join("\n");
  return body.length > MAX ? `${body.slice(0, MAX - 1)}…` : body;
}

const KEY = (workspaceId: string) => `letter-request:${workspaceId}`;

/** Hand the request to the instruction page (survives the navigation, not the tab). */
export function stashLetterRequest(workspaceId: string, request: string): void {
  try {
    sessionStorage.setItem(KEY(workspaceId), request);
  } catch {
    /* storage blocked: the page opens without the prefill */
  }
}

/** Read the stashed request (pure — safe in a useState initializer). */
export function peekLetterRequest(workspaceId: string): string | null {
  try {
    return sessionStorage.getItem(KEY(workspaceId));
  } catch {
    return null;
  }
}

/** Clear it once used, so a reload doesn't re-run the proposal. */
export function clearLetterRequest(workspaceId: string): void {
  try {
    sessionStorage.removeItem(KEY(workspaceId));
  } catch {
    /* nothing to clear */
  }
}
