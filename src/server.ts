import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { fileRoutes } from './routes/files.js';
import { chatRoutes } from './routes/chat.js';
import { conversationRoutes } from './routes/conversations.js';
import { eventRoutes } from './routes/events.js';
import { checklistRoutes } from './routes/checklist.js';
import { discrepancyRoutes } from './routes/discrepancies.js';
import { supplierInstructionRoutes } from './routes/supplierInstruction.js';
import { userRoutes } from './routes/users.js';
import { notificationRoutes } from './routes/notifications.js';
import { partiesRoutes } from './routes/parties.js';
import { reportRoutes } from './routes/report.js';
import { exportRoutes } from './routes/export.js';
import { ensureQdrantCollection } from './services/qdrant.js';

async function buildServer() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'development' ? 'info' : 'warn' },
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024,
  });

  // The frontend and API share one origin (system Caddy), so CORS is a
  // formality: allow no-Origin requests (same-origin / server-to-server) plus any
  // exact origins listed in CORS_ORIGIN (only needed if the API is ever served
  // cross-origin). No preview/wildcard matching.
  const allowedOrigins = new Set(
    config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  );
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Rate limiting is opt-in per route (only the chat endpoint uses it).
  await app.register(rateLimit, { global: false });

  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 20 },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(authRoutes);
  await app.register(workspaceRoutes);
  await app.register(fileRoutes);
  await app.register(chatRoutes);
  await app.register(conversationRoutes);
  await app.register(eventRoutes);
  await app.register(checklistRoutes);
  await app.register(discrepancyRoutes);
  await app.register(supplierInstructionRoutes);
  await app.register(userRoutes);
  await app.register(notificationRoutes);
  await app.register(partiesRoutes);
  await app.register(reportRoutes);
  await app.register(exportRoutes);

  return app;
}

async function main(): Promise<void> {
  await runMigrations();
  await ensureQdrantCollection();
  const app = await buildServer();
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Backend listening on http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error', err);
  process.exit(1);
});
