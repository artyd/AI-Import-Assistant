import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './lib/config.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { seedPlaces } from './hub/ports.js';
import { authRoutes } from './auth/auth.routes.js';
import { workspaceRoutes } from './shipments/workspaces.routes.js';
import { collectionRoutes } from './shipments/collections.routes.js';
import { collectionFileRoutes } from './documents/collectionFiles.routes.js';
import { analysisRoutes } from './analysis/analysis.routes.js';
import { fileRoutes } from './documents/files.routes.js';
import { chatRoutes } from './chat/chat.routes.js';
import { chatNormalRoutes } from './chat/chatNormal.routes.js';
import { chatConsolidatedRoutes } from './chat/chatConsolidated.routes.js';
import { conversationRoutes } from './chat/conversations.routes.js';
import { eventRoutes } from './documents/events.routes.js';
import { checklistRoutes } from './reconciliation/checklist.routes.js';
import { discrepancyRoutes } from './reconciliation/discrepancies.routes.js';
import { verificationRoutes } from './reconciliation/verification.routes.js';
import { riskRoutes } from './reconciliation/risks.routes.js';
import { supplierInstructionRoutes } from './instruction/supplierInstruction.routes.js';
import { directoryRoutes } from './instruction/directory.routes.js';
import { userRoutes } from './auth/users.routes.js';
import { notificationRoutes } from './notifications/notifications.routes.js';
import { aiConfigRoutes } from './analysis/byok/aiConfig.routes.js';
import { newsRoutes } from './news/news.routes.js';
import { partiesRoutes } from './reconciliation/parties.routes.js';
import { reportRoutes } from './report/report.routes.js';
import { exportRoutes } from './documents/export.routes.js';
import { mapRoutes } from './hub/map.routes.js';
import { hubRoutes } from './hub/hub.routes.js';
import { sheetRoutes } from './sheet/sheet.routes.js';
import { mcpRoutes } from './mcp/mcp.routes.js';

async function buildServer() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'development' ? 'info' : 'warn' },
    // JSON bodies only (multipart uploads stream through @fastify/multipart with
    // their own `limits` below) — was ~26 MB for every route.
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
  });

  // The frontend and API share one origin (system Caddy), so CORS is a
  // formality: allow no-Origin requests (same-origin / server-to-server) plus any
  // exact origins listed in CORS_ORIGIN (only needed if the API is ever served
  // cross-origin). No preview/wildcard matching.
  const allowedOrigins = new Set(
    config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  );
  // The public MCP endpoint is called by third-party clients (claude.ai, IDEs —
  // some send an Origin header). It authenticates by its own token, never by
  // cookie, so any origin may call it (no credentials).
  const isMcpEndpoint = (url: string): boolean => /^\/api\/mcp(?:[/?]|$)/.test(url);
  await app.register(cors, {
    delegator: (req, cb) => {
      if (isMcpEndpoint(req.url ?? '')) {
        return cb(null, {
          origin: '*',
          credentials: false,
          methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
          exposedHeaders: ['Mcp-Session-Id'],
        });
      }
      cb(null, {
        origin: (origin, done) => {
          if (!origin || allowedOrigins.has(origin)) return done(null, true);
          done(new Error('Not allowed by CORS'), false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      });
    },
  });

  // Rate limiting is opt-in per route (chat + login).
  await app.register(rateLimit, { global: false });

  await app.register(multipart, {
    // fileSize accepts the larger of a normal file and a .zip; non-zip parts
    // over MAX_UPLOAD_BYTES are rejected in the handler (see files route).
    limits: {
      fileSize: Math.max(config.MAX_UPLOAD_BYTES, config.MAX_ZIP_BYTES),
      files: config.MAX_UPLOAD_FILES,
    },
  });

  // Baseline security headers on every API response (the frontend sets its own
  // CSP in next.config). Route-specific headers (file sandbox CSP) win.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!reply.hasHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'SAMEORIGIN');
    return payload;
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Route plugins live in their area folders (`<area>/*.routes.ts`). Keep this
  // registration order (and the import order above) as is: Fastify applies
  // plugins and their hooks in registration order, and it matches the order the
  // app has always booted in.
  await app.register(authRoutes);
  await app.register(workspaceRoutes);
  await app.register(collectionRoutes);
  await app.register(collectionFileRoutes);
  await app.register(analysisRoutes);
  await app.register(fileRoutes);
  await app.register(chatRoutes);
  await app.register(chatNormalRoutes);
  await app.register(chatConsolidatedRoutes);
  await app.register(conversationRoutes);
  await app.register(eventRoutes);
  await app.register(checklistRoutes);
  await app.register(discrepancyRoutes);
  await app.register(verificationRoutes);
  await app.register(riskRoutes);
  await app.register(supplierInstructionRoutes);
  await app.register(directoryRoutes);
  await app.register(userRoutes);
  await app.register(notificationRoutes);
  await app.register(aiConfigRoutes);
  await app.register(newsRoutes);
  await app.register(partiesRoutes);
  await app.register(reportRoutes);
  await app.register(exportRoutes);
  await app.register(mapRoutes);
  await app.register(hubRoutes);
  await app.register(sheetRoutes);
  await app.register(mcpRoutes);

  return app;
}

async function main(): Promise<void> {
  await runMigrations();
  const app = await buildServer();
  // Logistics-hub gazetteer → ports atlas (idempotent, only changed rows written).
  await seedPlaces().catch((err: Error) => app.log.warn({ err }, 'seedPlaces failed'));
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Backend listening on http://${config.HOST}:${config.PORT}`);

  // Graceful shutdown (docker stop / redeploy): stop accepting connections and
  // give in-flight chat turns time to finish and persist their answer, instead of
  // being cut mid-stream. Hard exit after the deadline (compose grace is 60 s).
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`${signal} received — draining connections…`);
    const deadline = setTimeout(() => process.exit(0), 50_000);
    deadline.unref();
    app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error', err);
  process.exit(1);
});
