import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { attentionRows, calendarRange, calendarXlsx, syncState } from '../services/sheet/calendar.js';
import { sheetEnabled, sheetRowUrl, syncSheet } from '../services/sheet/sync.js';

/**
 * Logist calendar over the team Google Sheet (synced hourly by the worker).
 * Team-wide data: every authenticated user sees the same calendar.
 */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z
  .object({ from: ymd, to: ymd })
  .refine((q) => q.from <= q.to, 'from > to')
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 400, 'range too long');

/** Manual "sync now" at most this often (the sheet export is rate-limited by Google). */
const MANUAL_SYNC_MIN_MS = 60_000;
let lastManualSync = 0;

async function syncInfo() {
  return { enabled: sheetEnabled(), sheetUrl: sheetRowUrl('tracking'), ...(await syncState()) };
}

export async function sheetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — events + their rows + sync state.
  app.get('/api/calendar', async (req, reply) => {
    const q = rangeQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: 'Вкажіть період from/to (YYYY-MM-DD, до 400 днів).' });
    return reply.send({ ...(await calendarRange(q.data.from, q.data.to)), sync: await syncInfo() });
  });

  // GET /api/calendar/attention — active / recent rows with a data problem.
  app.get('/api/calendar/attention', async (_req, reply) => reply.send({ rows: await attentionRows() }));

  // GET /api/calendar/export.xlsx?from=&to= — the period's events as an Excel plan.
  app.get('/api/calendar/export.xlsx', async (req, reply) => {
    const q = rangeQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: 'Вкажіть період from/to.' });
    const buf = calendarXlsx(await calendarRange(q.data.from, q.data.to));
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="calendar-${q.data.from}_${q.data.to}.xlsx"`)
      .send(buf);
  });

  // POST /api/sheet/sync — read the sheet now (throttled; the worker also does it hourly).
  app.post('/api/sheet/sync', async (_req, reply) => {
    if (!sheetEnabled()) return reply.status(409).send({ error: 'Таблицю не підключено (SHEET_ID).' });
    if (Date.now() - lastManualSync < MANUAL_SYNC_MIN_MS) {
      return reply.status(429).send({ error: 'Таблицю щойно оновлювали — спробуйте за хвилину.' });
    }
    lastManualSync = Date.now();
    const result = await syncSheet();
    return reply.send({ result, sync: await syncInfo() });
  });
}
