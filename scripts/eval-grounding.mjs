#!/usr/bin/env node
// Grounding eval — 3 scripted conversations that exercise the Phase-4 grounding
// rules. LLM output varies, so this is a HUMAN-JUDGED checklist (not hard
// asserts): it prints the ordered tool calls + final assistant text per case,
// with the behavior you should confirm. Re-run it after prompt changes.
//
// Usage:
//   EMAIL=you@agroup95.com PASSWORD=secret node scripts/eval-grounding.mjs
//   (needs a RUNNING stack + worker + Anthropic key; this makes real chat calls)
//
// Env: BASE_URL (default http://localhost:8080), EMAIL, PASSWORD.

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('EMAIL and PASSWORD env vars are required (a seeded user).');
  process.exit(2);
}

let token = '';
const C = { g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', r: '\x1b[0m', b: '\x1b[1m' };

async function api(method, path, { body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

/** Reads an SSE POST response body and returns the collected events. */
async function readSse(res) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) {
        let data;
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          data = dataLines.join('\n');
        }
        events.push({ event, data });
      }
    }
  }
  return events;
}

async function chat(workspaceId, message) {
  const res = await api('POST', `/api/workspaces/${workspaceId}/chat`, { body: { message }, raw: true });
  if (res.status !== 200) return { toolCalls: [], text: `<HTTP ${res.status}>` };
  const events = await readSse(res);
  const toolCalls = events.filter((e) => e.event === 'tool_call').map((e) => e.data.tool);
  const done = events.find((e) => e.event === 'done');
  const text = done?.data.message ?? events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  return { toolCalls, text };
}

function report(title, userMsg, result, expect) {
  console.log(`\n${C.b}${C.c}━━ ${title} ━━${C.r}`);
  console.log(`${C.d}user:${C.r} ${userMsg}`);
  console.log(`${C.y}tool_calls:${C.r} [${result.toolCalls.join(', ') || '—'}]`);
  console.log(`${C.d}assistant:${C.r}\n${result.text.trim()}`);
  console.log(`${C.g}CONFIRM:${C.r}`);
  for (const e of expect) console.log(`  ${C.d}[ ]${C.r} ${e}`);
}

async function main() {
  console.log(`\nGrounding eval → ${BASE_URL}`);

  // Login
  {
    const r = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    if (r.status !== 200 || !r.json.token) {
      console.error(`Login failed (status ${r.status}).`);
      process.exit(1);
    }
    token = r.json.token;
  }

  // Case A — missing context: fresh workspace, ask for a supplier instruction.
  {
    const w = await api('POST', '/api/workspaces', { body: { supplier: 'EvalSupplierA' } });
    const wsId = w.json.workspace.id;
    const res = await chat(wsId, 'Склади інструкцію постачальнику для цього постачання.');
    report('A · missing-context (must ASK, not proceed)', 'Склади інструкцію постачальнику…', res, [
      'викликав get_missing_context',
      'НЕ викликав generate_supplier_instruction (не згенерував лист)',
      'у відповіді просить надати відсутні параметри та зупиняється',
    ]);
  }

  // Case B — complete context: fill intake + supplier, then ask completeness.
  {
    const w = await api('POST', '/api/workspaces', { body: { supplier: 'EvalSupplierB' } });
    const wsId = w.json.workspace.id;
    await api('PATCH', `/api/workspaces/${wsId}/intake`, {
      body: {
        contract_type: 'bilateral',
        product_category: 'textile',
        incoterm: 'FOB',
        transport_mode: 'sea',
        origin_country: 'China',
      },
    });
    await api('POST', `/api/workspaces/${wsId}/parties`, {
      body: {
        parties: [
          { role: 'our_company', company_name: 'AGroup95', is_internal: true },
          { role: 'supplier', company_name: 'Foo Textiles Ltd', country: 'China' },
        ],
      },
    });
    const res = await chat(wsId, 'Перевір комплектність документів цього постачання.');
    report('B · complete-context (must use TOOLS, not eyeball)', 'Перевір комплектність…', res, [
      'викликав get_checklist (а не оцінював «на око»)',
      'переказує саме результат інструмента (є / отримано / бракує)',
    ]);
  }

  // Case C — ambiguous product HS: must ask + give multiple candidates.
  {
    const w = await api('POST', '/api/workspaces', { body: { supplier: 'EvalSupplierC' } });
    const wsId = w.json.workspace.id;
    const res = await chat(wsId, 'Який код УКТ ЗЕД підійде для мого товару?');
    report('C · ambiguous HS (must ASK + multiple candidates, never one code)', 'Який код УКТ ЗЕД…', res, [
      'ставить уточнюючі запитання про товар (склад/обробка/пакування/призначення)',
      'НЕ подає один код як остаточний факт',
      'пропонує кілька кандидатів + застереження про підтвердження спеціалістом',
    ]);
  }

  console.log(`\n${C.d}Done. Review each CONFIRM checklist above manually.${C.r}\n`);
}

main().catch((err) => {
  console.error('\nGrounding eval crashed:', err.message);
  process.exit(1);
});
