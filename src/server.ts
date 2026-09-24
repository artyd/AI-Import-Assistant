import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config.js';
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
import { userRoutes } from './routes/users.js';
import { notificationRoutes } from './routes/notifications.js';
import { aiConfigRoutes } from './routes/aiConfig.js';
import { newsRoutes } from './routes/news.js';
import { partiesRoutes } from './routes/parties.js';
import { reportRoutes } from './routes/report.js';
import { exportRoutes } from './routes/export.js';
import { mapRoutes } from './routes/map.js';
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
    // fileSize accepts the larger of a normal file and a .zip; non-zip parts
    // over MAX_UPLOAD_BYTES are rejected in the handler (see files route).
    limits: {
      fileSize: Math.max(config.MAX_UPLOAD_BYTES, config.MAX_ZIP_BYTES),
      files: config.MAX_UPLOAD_FILES,
    },
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
  await app.register(userRoutes);
  await app.register(notificationRoutes);
  await app.register(aiConfigRoutes);
  await app.register(newsRoutes);
  await app.register(partiesRoutes);
  await app.register(reportRoutes);
  await app.register(exportRoutes);
  await app.register(mapRoutes);

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
