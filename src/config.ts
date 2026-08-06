import { z } from 'zod';

/**
 * Centralised, validated configuration. Every environment variable the backend
 * or worker reads goes through here so a missing/invalid value fails fast at
 * boot rather than deep inside a request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),

  // Secrets / providers — never sent to the browser.
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  EMBEDDING_API_KEY: z.string().min(1, 'EMBEDDING_API_KEY is required'),

  // Infra
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Auth
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  // CORS: the production Vercel origin. Preview deployments are matched by a
  // scoped regex in server.ts (see corsOriginMatcher).
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),

  // File storage
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  // Model / embeddings
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),
  EMBEDDING_PROVIDER: z.enum(['voyage']).default('voyage'),
  EMBEDDING_MODEL: z.string().default('voyage-3'),

  // Chat rate limit (per user)
  CHAT_RATE_MAX: z.coerce.number().int().positive().default(30),
  CHAT_RATE_WINDOW: z.string().default('1 minute'),
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
