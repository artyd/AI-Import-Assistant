import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { collectionRoutes } from './routes/collections.js';
import { collectionFileRoutes } from './routes/collectionFiles.js';
import { analysisRoutes } from './routes/analysis.js';
import { fileRoutes } from './routes/files.js';
import { chatRoutes } from './routes/chat.js';
import { chatNormalRoutes } from './routes/chatNormal.js';
import { chatConsolidatedRoutes } from './routes/chatConsolidated.js';
import { conversationRoutes } from './routes/conversations.js';
import { eventRoutes } from './routes/events.js';
import { checklistRoutes } from './routes/checklist.js';
import { discrepancyRoutes } from './routes/discrepancies.js';
import { verificationRoutes } from './routes/verification.js';
import { riskRoutes } from './routes/risks.js';
import { supplierInstructionRoutes } from './routes/supplierInstruction.js';
import { directoryRoutes } from './routes/directory.js';
import { userRoutes } from './routes/users.js';
import { notificationRoutes } from './routes/notifications.js';
import { aiConfigRoutes } from './routes/aiConfig.js';
import { newsRoutes } from './routes/news.js';
import { partiesRoutes } from './routes/parties.js';
import { reportRoutes } from './routes/report.js';
import { exportRoutes } from './routes/export.js';
import { mapRoutes } from './routes/map.js';
import { mcpRoutes } from './routes/mcp.js';

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
  await app.register(mcpRoutes);

  return app;
}

async function main(): Promise<void> {
  await runMigrations();
  const app = await buildServer();
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
