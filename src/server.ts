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
import { ensureQdrantCollection } from './services/qdrant.js';

/**
 * Allow the production Vercel origin plus that project's preview deployments
 * (`https://<project>-<hash>-<scope>.vercel.app`), and nothing else. The exact
 * production origin is CORS_ORIGIN; previews are matched by a scoped regex
 * derived from it so we don't leave CORS wide open.
 */
function buildCorsMatcher(): (origin: string) => boolean {
  const allowed = new Set(config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean));
  // Derive a preview matcher from the first *.vercel.app production origin.
  let previewRe: RegExp | null = null;
  for (const o of allowed) {
    const m = /^https:\/\/([a-z0-9-]+)\.vercel\.app$/i.exec(o);
    if (m) {
      const project = m[1];
      previewRe = new RegExp(`^https://${project}-[a-z0-9-]+\\.vercel\\.app$`, 'i');
      break;
    }
  }
  return (origin: string) => allowed.has(origin) || (previewRe?.test(origin) ?? false);
}

async function buildServer() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'development' ? 'info' : 'warn' },
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024,
  });

  const corsMatches = buildCorsMatcher();
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / server-to-server requests have no Origin header.
      if (!origin) return cb(null, true);
      if (corsMatches(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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
