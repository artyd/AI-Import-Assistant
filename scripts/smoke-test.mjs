#!/usr/bin/env node
// Smoke test — exercises the full backend API against a RUNNING stack.
// No dependencies (uses Node 20 global fetch / FormData / Blob).
//
// Usage:
//   EMAIL=you@agroup95.com PASSWORD=secret node scripts/smoke-test.mjs
//
// Env:
//   BASE_URL   default http://localhost:8080  (prod: https://api.ourdomain.com)
//   EMAIL      required — a seeded user
//   PASSWORD   required
//   SKIP_CHAT  set to 1 to skip the chat step (avoids Anthropic cost)
//   INDEX_TIMEOUT_MS  default 60000 — how long to wait for indexing
//
// Exits non-zero if any check fails.

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const SKIP_CHAT = process.env.SKIP_CHAT === '1';
const INDEX_TIMEOUT_MS = Number(process.env.INDEX_TIMEOUT_MS ?? 60000);

if (!EMAIL || !PASSWORD) {
  console.error('EMAIL and PASSWORD env vars are required (a seeded user).');
  process.exit(2);
}

let passed = 0;
let failed = 0;
let token = '';

function ok(name, detail = '') {
  passed++;
  console.log(`  \x1b[32m[OK]\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  failed++;
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}
function check(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else fail(name, detail);
  return cond;
}

async function api(method, path, { body, form, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form; // fetch sets multipart Content-Type + boundary
  } else if (body !== undefined) {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
        // ": comment" lines (heartbeats) are ignored
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

async function main() {
  console.log(`\nSmoke test → ${BASE_URL}\n`);

  // 1. Health
  {
    const r = await api('GET', '/health');
    check('GET /health', r.status === 200 && r.json.status === 'ok', `status ${r.status}`);
  }

  // 2. Login
  {
    const r = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    const good = r.status === 200 && typeof r.json.token === 'string';
    check('POST /api/auth/login', good, good ? `user ${r.json.user?.email}` : `status ${r.status}`);
    if (!good) return finish();
    token = r.json.token;
  }

  // 3. Me
  {
    const r = await api('GET', '/api/auth/me');
    check('GET /api/auth/me', r.status === 200 && r.json.user?.email === EMAIL.toLowerCase(), `status ${r.status}`);
  }

  // 4. Rejected without auth (negative test)
  {
    const saved = token;
    token = '';
    const r = await api('GET', '/api/workspaces');
    check('GET /api/workspaces without token → 401', r.status === 401, `status ${r.status}`);
    token = saved;
  }

  // 5. Create workspace
  let workspaceId = '';
  {
    const r = await api('POST', '/api/workspaces', { body: { supplier: 'SmokeSupplier', status: 'draft' } });
    const good = r.status === 201 && r.json.workspace?.id;
    check('POST /api/workspaces', good, good ? `#${r.json.workspace.number}` : `status ${r.status}`);
    if (!good) return finish();
    workspaceId = r.json.workspace.id;
  }

  // 6. List + get workspace (folder skeleton seeded)
  {
    const list = await api('GET', '/api/workspaces');
    check(
      'GET /api/workspaces contains new workspace',
      list.status === 200 && list.json.workspaces?.some((w) => w.id === workspaceId),
      `status ${list.status}`,
    );
    const one = await api('GET', `/api/workspaces/${workspaceId}`);
    check(
      'GET /api/workspaces/:id has 8-folder skeleton',
      one.status === 200 && one.json.folders?.length === 8,
      `folders ${one.json.folders?.length}`,
    );
  }

  // 7. Upload a CSV (allow-listed, extractable → exercises the index pipeline)
  let fileId = '';
  {
    const csv = 'field,invoice,po,packing_list\nweight_kg,1240,1200,1180\nqty,22,20,20\ntotal_usd,48600,48600,\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'test_invoice.csv');
    const r = await api('POST', `/api/workspaces/${workspaceId}/files`, { form });
    const created = r.json.files?.[0];
    const good = r.status === 201 && created?.id;
    check('POST …/files (upload csv)', good, good ? `status ${created.status}` : `status ${r.status} ${JSON.stringify(r.json)}`);
    if (good) fileId = created.id;

    // Negative: reject a disallowed extension.
    const bad = new FormData();
    bad.append('file', new Blob(['MZ'], { type: 'application/octet-stream' }), 'evil.exe');
    const rej = await api('POST', `/api/workspaces/${workspaceId}/files`, { form: bad });
    check('POST …/files rejects .exe → 415', rej.status === 415, `status ${rej.status}`);
  }

  // 8. Wait for indexing to finish
  if (fileId) {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    let status = 'queued';
    let errorReason = null;
    while (Date.now() < deadline) {
      const r = await api('GET', `/api/workspaces/${workspaceId}/files`);
      const f = r.json.files?.find((x) => x.id === fileId);
      status = f?.status ?? status;
      errorReason = f?.errorReason ?? null;
      if (status === 'ready' || status === 'error') break;
      await sleep(1500);
    }
    check(
      'indexing reaches "ready"',
      status === 'ready',
      status === 'error' ? `error: ${errorReason}` : `last status: ${status}`,
    );
  }

  // 9. Chat (SSE)
  let conversationId = '';
  if (SKIP_CHAT) {
    console.log('  \x1b[33m[SKIP]\x1b[0m chat (SKIP_CHAT=1)');
  } else {
    const res = await api('POST', `/api/workspaces/${workspaceId}/chat`, {
      body: { message: 'Звір вагу брутто в test_invoice.csv між інвойсом, PO та пакувальним листом.' },
      raw: true,
    });
    if (res.status !== 200) {
      fail('POST …/chat (SSE)', `status ${res.status}`);
    } else {
      const events = await readSse(res);
      const kinds = events.map((e) => e.event);
      const done = events.find((e) => e.event === 'done');
      const hadToken = kinds.includes('token');
      const hadError = kinds.includes('error');
      check('chat streamed token/done events', (hadToken || !!done) && !hadError, `events: ${[...new Set(kinds)].join(',')}`);
      if (done) {
        conversationId = done.data.conversationId;
        const nTools = kinds.filter((k) => k === 'tool_call').length;
        const nCit = done.data.citations?.length ?? 0;
        ok('chat done payload', `tool_calls=${nTools}, citations=${nCit}, msgLen=${done.data.message?.length ?? 0}`);
      }
    }
  }

  // 10. Conversations
  if (conversationId) {
    const list = await api('GET', `/api/workspaces/${workspaceId}/conversations`);
    check(
      'GET …/conversations contains it',
      list.status === 200 && list.json.conversations?.some((c) => c.id === conversationId),
      `count ${list.json.conversations?.length}`,
    );
    const one = await api('GET', `/api/workspaces/${workspaceId}/conversations/${conversationId}`);
    const roles = (one.json.messages ?? []).map((m) => m.role);
    check(
      'GET …/conversations/:id has user+assistant',
      roles.includes('user') && roles.includes('assistant'),
      `roles: ${roles.join(',')}`,
    );
  }

  // 11. Delete file
  if (fileId) {
    const r = await api('DELETE', `/api/workspaces/${workspaceId}/files/${fileId}`);
    check('DELETE …/files/:fileId', r.status === 200 && r.json.ok === true, `status ${r.status}`);
  }

  finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  process.exit(1);
});
