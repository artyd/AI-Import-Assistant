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

  // Access-code login (the PIN keypad in the UI). Entering ACCESS_CODE issues a
  // JWT for ACCESS_CODE_EMAIL (or the oldest user if unset) — a shared team
  // code, alongside the per-user email/password login. Set ACCESS_CODE='' to
  // disable code login entirely.
  ACCESS_CODE: z.string().default('1995'),
  ACCESS_CODE_EMAIL: z.string().optional(),

  // CORS: comma-separated exact origins to allow. The app is same-origin behind
  // Caddy, so this is usually empty; set it only if the API is served cross-origin.
  CORS_ORIGIN: z.string().default(''),

  // File storage
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // Max files accepted in a SINGLE multipart upload request. The frontend sends
  // large selections in batches, so this caps ONE request, not the whole
  // shipment. Raised from the old hardcoded 20 so a big drag-and-drop batch is
  // not silently rejected mid-request (see server.ts multipart limits).
  MAX_UPLOAD_FILES: z.coerce.number().int().positive().default(100),
  // A .zip may be much larger than a single document, so it gets its own,
  // higher size ceiling. The multipart layer accepts up to max(this,
  // MAX_UPLOAD_BYTES); non-zip parts above MAX_UPLOAD_BYTES are still rejected
  // in-handler. Zip-bomb guards below bound what the archive may expand to.
  MAX_ZIP_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  MAX_ZIP_ENTRIES: z.coerce.number().int().positive().default(2000),
  // Bounds peak memory: unpackZip materialises every entry's bytes in RAM at
  // once, so this cap is effectively the max heap a single zip upload can use.
  // Kept generous for real supply packages (~tens of MB) but well below an
  // OOM-inducing gigabyte.
  MAX_ZIP_UNCOMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(300 * 1024 * 1024),

  // Model / embeddings
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),
  // Anthropic SDK resilience (shared client). The SDK auto-retries 408/409/429/
  // 5xx + connection errors with exponential backoff and honours Retry-After;
  // the default of 2 is too low for a burst of indexing jobs that each make
  // several vision/extraction calls. Timeout is in milliseconds.
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Global cap on concurrent Anthropic calls across the whole process. The
  // indexing worker fans out OCR + field-extraction + classification per file;
  // without a cap a burst of jobs can pile dozens of simultaneous vision calls
  // onto Anthropic and trip rate limits. Conservative by default (tune up once
  // real limits are known — see file-ingestion-batching plan).
  ANTHROPIC_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // Indexing worker throughput.
  INDEX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // BullMQ job rate limit: at most INDEX_RATE_MAX index jobs start per
  // INDEX_RATE_DURATION_MS. A coarse second guard on top of the Anthropic
  // concurrency cap so a 500-file dump drains steadily instead of stampeding.
  INDEX_RATE_MAX: z.coerce.number().int().positive().default(20),
  INDEX_RATE_DURATION_MS: z.coerce.number().int().positive().default(10_000),

  // Auto-retry sweep (worker cron): re-queue files stuck in 'error' up to
  // INGEST_MAX_RETRIES times over minutes, then flag them for manual key-field
  // entry (extraction_status='unreadable') so nothing is ever silently lost.
  INGEST_RETRY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  INGEST_RETRY_CRON: z.string().default('*/5 * * * *'),
  INGEST_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  EMBEDDING_PROVIDER: z.enum(['voyage', 'openai']).default('voyage'),
  EMBEDDING_MODEL: z.string().default('voyage-3'),

  // Optional FALLBACK embedding provider, used only when the primary is
  // unavailable during indexing (search fans out across both collections).
  // Leave EMBEDDING_FALLBACK_PROVIDER = 'none' (default) to disable.
  EMBEDDING_FALLBACK_PROVIDER: z.enum(['voyage', 'openai', 'none']).default('none'),
  EMBEDDING_FALLBACK_MODEL: z.string().default('text-embedding-3-large'),
  EMBEDDING_FALLBACK_API_KEY: z.string().optional(),

  // Chat rate limit (per user)
  CHAT_RATE_MAX: z.coerce.number().int().positive().default(30),
  CHAT_RATE_WINDOW: z.string().default('1 minute'),

  // OCR fallback (worker): when a PDF has no text layer or the file is an image,
  // transcribe it with Claude vision so scans become searchable + extractable.
  OCR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Model used for OCR transcription. Defaults to the chat model; a cheaper
  // vision-capable model (e.g. claude-haiku-4-5) can be set to cut cost.
  OCR_MODEL: z.string().default('claude-opus-4-8'),
  // Max output tokens for one OCR pass. Raised from the old hardcoded 8000 so a
  // long multi-page scan (e.g. a 10+ page contract) isn't transcribed only
  // partway. 16000 is the safe non-streaming ceiling (above that the SDK can hit
  // HTTP timeouts); very long docs beyond this still truncate — see OCR notes.
  OCR_MAX_TOKENS: z.coerce.number().int().positive().default(16000),

  // Structured document extraction (worker) + daily reminders (worker cron).
  EXTRACTION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  REMINDERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  REMINDERS_CRON: z.string().default('0 6 * * *'),

  // News ingest (worker cron): fetch public RSS/Atom feeds into news_items and
  // purge anything older than NEWS_RETENTION_DAYS. ON by default — the worker in
  // this deployment has outbound network to the feeds. Set NEWS_ENABLED=false to
  // disable (e.g. a locked-down worker with no egress).
  NEWS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  NEWS_CRON: z.string().default('*/30 * * * *'),
  NEWS_RETENTION_DAYS: z.coerce.number().int().positive().default(14),

  // Map / vessel tracking (Phase D). AIS_PROVIDER selects the position source for
  // GET /api/map/shipments: 'demo' interpolates a deterministic point along each
  // shipment's route (no network), 'aishub' is a live AIS adapter that needs
  // AIS_API_KEY. Falls back to demo when 'aishub' is set without a key.
  AIS_PROVIDER: z.enum(['demo', 'aishub']).default('demo'),
  AIS_API_KEY: z.string().default(''),

  // BYOK (Phase E): symmetric key that encrypts each user's provider API key at
  // rest (AES-256-GCM). Must decode to exactly 32 bytes — accepts base64 or hex.
  // Leave empty to DISABLE BYOK entirely: everything stays on the built-in
  // server-side Claude and `PUT /api/ai-config { engine:'byok' }` returns 400.
  // BYOK is scoped to the consolidated-analysis AI step only; the main Штурман
  // agent always uses the built-in Anthropic key.
  BYOK_ENC_KEY: z.string().default(''),

  // logist-mcp integration: base URL of the internal customs/logistics tool
  // service (docker-compose `logist-mcp`, plain-REST) that exposes the UKTZED /
  // dual-use / NBU rate / PubChem lookups. Reachable on the Compose network only
  // — NO host port and NO Caddy route. Empty (default) = disabled; the agent
  // tools that call it become available once this is set (e.g.
  // http://logist-mcp:8015). Compose sets it by default.
  LOGIST_MCP_URL: z.string().default(''),
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
