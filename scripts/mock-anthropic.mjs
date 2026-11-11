#!/usr/bin/env node
// Deterministic mock of the Anthropic Messages API for CI (no key, no cost).
// Zero dependencies. Point the SDK at it with ANTHROPIC_BASE_URL=http://host:PORT.
//
//   node scripts/mock-anthropic.mjs            # listens on $PORT or 8099
//
// Implements POST /v1/messages (JSON and `stream: true` SSE) and GET /health.
// It never returns tool_use: requests that carry tools get plain text, which
// the app treats as "no tool call" (extraction -> null, agent loop -> final answer).
// Also answers POST /v1/messages/count_tokens so token-count calls don't 404.

import http from 'node:http';

const PORT = Number(process.env.PORT ?? process.env.MOCK_ANTHROPIC_PORT ?? 8099);

/** Flattens every text block of the request (system + messages) into one string. */
function requestText(body) {
  const parts = [];
  const add = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  };
  add(body.system);
  for (const m of body.messages ?? []) add(m.content);
  return parts.join('\n');
}

/** Picks a deterministic reply based on what the app is asking for. */
function replyText(body) {
  const text = requestText(body);
  // classifyDocTypeCheap: "ОДНИМ словом із переліку: invoice, packing_list, ..."
  if (text.includes('ОДНИМ словом із переліку')) return 'invoice';
  // classifyOther: "відповідай лише її ключем"
  if (text.includes('відповідай лише її ключем')) return 'other';
  // Vision OCR / PDF transcription: a document or image block in the request.
  const hasMedia = (body.messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b && (b.type === 'image' || b.type === 'document')),
  );
  if (hasMedia) return '# Mock transcription\n\n| field | value |\n|---|---|\n| invoice | MOCK-001 |\n';
  // Asked for JSON explicitly -> minimal valid JSON.
  if (/\bJSON\b/i.test(text)) return '{}';
  return 'Це детермінована відповідь mock-anthropic для CI. Даних для висновків немає.';
}

function usage(body, text) {
  return { input_tokens: Math.max(1, Math.ceil(requestText(body).length / 4)), output_tokens: Math.max(1, Math.ceil(text.length / 4)) };
}

function messageObject(body, text) {
  return {
    id: 'msg_mock_' + Math.random().toString(36).slice(2, 12),
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'mock',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: usage(body, text),
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(res, body, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const msg = messageObject(body, text);
  const u = msg.usage;
  sse(res, 'message_start', {
    type: 'message_start',
    message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: u.input_tokens, output_tokens: 1 } },
  });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // A few chunks so the client sees incremental tokens.
  for (const piece of text.match(/.{1,24}/gs) ?? [text]) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: u.output_tokens },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/health' || url === '/')) return json(res, 200, { status: 'ok' });

    if (req.method === 'POST' && (url === '/v1/messages' || url === '/v1/messages/count_tokens')) {
      const raw = await readBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } });
      }
      if (url.endsWith('/count_tokens')) return json(res, 200, { input_tokens: usage(body, '').input_tokens });
      const text = replyText(body);
      if (body.stream === true) return streamMessage(res, body, text);
      return json(res, 200, messageObject(body, text));
    }

    json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `${req.method} ${url}` } });
  } catch (err) {
    json(res, 500, { type: 'error', error: { type: 'api_error', message: String(err?.message ?? err) } });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock-anthropic listening on :${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
