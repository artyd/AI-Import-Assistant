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

  // Infra
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Auth
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  // Proxies whose X-Forwarded-For is trusted, so req.ip is the real client
  // (login throttling is keyed on it). The API port is published only on the
  // host's 127.0.0.1 and reached through the system Caddy + Docker's bridge, so
  // loopback + private ranges are the only possible hops. proxy-addr syntax.
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),

  // Quick PIN login (the UI keypad). OFF unless explicitly configured. The PIN
  // must be 6–8 digits; it opens ACCESS_CODE_EMAIL's account if set, otherwise
  // the main (first-created) account.
  // Brute force is blocked by a per-IP limit plus a GLOBAL lockout: after
  // ACCESS_CODE_MAX_FAILURES wrong PINs within 24 h (from any IPs) PIN login is
  // disabled for 24 h — password login keeps working.
  ACCESS_CODE: z.string().default(''),
  ACCESS_CODE_EMAIL: z.string().default(''),
  ACCESS_CODE_MAX_FAILURES: z.coerce.number().int().positive().default(20),

  // CORS: comma-separated exact origins to allow. The app is same-origin behind
  // Caddy, so this is usually empty; set it only if the API is served cross-origin.
  CORS_ORIGIN: z.string().default(''),

  // File storage
  STORAGE_DIR: z.string().default('./storage'),
  // Per-document cap. 100 MB: signed contracts scanned at high DPI reach ~50 MB
  // (live test «Сборник 18»). Vision reads PDFs in byte-bounded page windows, so
  // a large scan never becomes one oversized API request.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
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
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  // Chat agent budgets. The current Claude models have a 1M-token context window;
  // these let a big consolidated shipment (hundreds of files) use it instead of
  // the old ~100k-token history window.
  // - AGENT_CONTEXT_TOKENS: the model's context window (shown in the UI widget;
  //   one step's new tool results are kept under 95% of it).
  // - AGENT_MAX_TOKENS: output cap per model call (adaptive thinking counts too —
  //   the old 12k let a long reasoning pass eat the whole budget → empty answer).
  // - AGENT_HISTORY_CHAR_BUDGET: replayed prior turns (incl. documents read), in
  //   chars (~3 chars/token for Cyrillic/Latin → ~400k tokens by default; CJK is
  //   denser, so this keeps headroom under the 1M window).
  // - READ_FILE_MAX_CHARS: one read_file result before it asks to page further.
  AGENT_CONTEXT_TOKENS: z.coerce.number().int().positive().default(1_000_000),
  // Server-side clearing of old tool results (documents read earlier) once a
  // request passes this many input tokens; the newest AGENT_CLEAR_KEEP_TOOL_USES
  // results stay word for word. Reading never stops because the context is full.
  AGENT_CLEAR_TRIGGER_TOKENS: z.coerce.number().int().positive().default(500_000),
  AGENT_CLEAR_KEEP_TOOL_USES: z.coerce.number().int().positive().default(8),
  // Reasoning effort for the chat agent (Sonnet 5.5 levels are recalibrated;
  // multistep document work → high).
  AGENT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(64_000),
  AGENT_HISTORY_CHAR_BUDGET: z.coerce.number().int().positive().default(1_200_000),
  READ_FILE_MAX_CHARS: z.coerce.number().int().positive().default(200_000),
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
  // Ingest-time Markdown conversion (worker). Every file is converted ONCE to
  // Markdown and stored (file_markdown); read_file, extraction and full-text
  // search all read that — Claude is the only reader, there is no embedding API.
  // PDFs/images are transcribed by Claude vision in windows of
  // MARKDOWN_PDF_BATCH_PAGES pages per call. MARKDOWN_VISION_ENABLED=false keeps
  // text-layer PDFs on the cheap pdf-parse path (vision only for sparse/scanned).
  MARKDOWN_VISION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  MARKDOWN_PDF_BATCH_PAGES: z.coerce.number().int().positive().default(5),
  // LibreOffice binary used to convert legacy binary .doc → .docx.
  LIBREOFFICE_BIN: z.string().default('soffice'),

  // Chat rate limit (per user)
  CHAT_RATE_MAX: z.coerce.number().int().positive().default(30),
  CHAT_RATE_WINDOW: z.string().default('1 minute'),

  // OCR fallback (worker): when a PDF has no text layer or the file is an image,
  // transcribe it with Claude vision so scans become searchable + extractable.
  OCR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Model for vision transcription (PDF/scan/photo → Markdown). Verbatim
  // transcription doesn't need Opus-level reasoning; Sonnet 5.5 reads as well at
  // lower cost. (Structured extraction runs on ANTHROPIC_MODEL with tool_choice
  // "auto" — forced tool_choice is a 400 on Sonnet 5.5.)
  OCR_MODEL: z.string().default('claude-sonnet-5-5'),
  // Tiny doc-type classifier used only for files without a structured extraction.
  CLASSIFY_MODEL: z.string().default('claude-haiku-4-5'),
  // Summarizer for qdpro УКТ ЗЕД pages (logist uktzed_lookup_code digest).
  LOGIST_DIGEST_MODEL: z.string().default('claude-sonnet-5-5'),
  // 3–5 sentence management summary on the one-page report (facts JSON in, no
  // documents) — and the optional "refine with AI" in the instruction builder.
  REPORT_SUMMARY_MODEL: z.string().default('claude-sonnet-5-5'),
  // System Chromium used to print HTML → PDF (report, supplier instruction).
  CHROMIUM_PATH: z.string().default('/usr/bin/chromium'),
  // Max output tokens for one OCR pass. Raised from the old hardcoded 8000 so a
  // long multi-page scan (e.g. a 10+ page contract) isn't transcribed only
  // partway. 16000 is the safe non-streaming ceiling (above that the SDK can hit
  // HTTP timeouts); very long docs beyond this still truncate — see OCR notes.
  OCR_MAX_TOKENS: z.coerce.number().int().positive().default(32000),

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

  // Logistics hub (tracking by number + live map). The worker cron re-checks
  // every non-delivered tracked item on TRACKING_CRON. Carrier sources are a
  // hybrid: official APIs first (Нова Пошта works keyless; the others activate
  // when their key is set), then the public tracking page (fetched via logist-mcp,
  // rendered by headless Chromium if it is an SPA) read by TRACKING_PARSE_MODEL.
  TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TRACKING_CRON: z.string().default('*/30 * * * *'),
  TRACKING_SCRAPE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TRACKING_PARSE_MODEL: z.string().default('claude-haiku-4-5'),
  NOVAPOSHTA_API_KEY: z.string().default(''),
  UKRPOSHTA_TRACKING_TOKEN: z.string().default(''),
  DHL_API_KEY: z.string().default(''),
  MAERSK_API_KEY: z.string().default(''),
  // 17TRACK (api.17track.net) — parcels / express (DHL, FedEx, UPS, TNT,
  // international post, Meest…). One quota unit per registered number.
  // Also read from SEVENTEEN_TRACK_KEY (and NOVAPOSHTA_API_KEY from
  // NOVA_POSHTA_API_KEY) — see ENV_ALIASES.
  TRACK17_API_KEY: z.string().default(''),
  // Sea containers / B/L: 'manual' = logists enter status, ETA, vessel and
  // events by hand (no carrier-page scraping; an official API still runs when
  // its key is set); 'auto' = the full hybrid chain incl. scraping.
  TRACKING_SEA_MODE: z.enum(['manual', 'auto']).default('manual'),

  // Team Google Sheet → calendar + hub. The sheet is read through its public
  // "anyone with the link" CSV export (no write-back). Empty SHEET_ID = off.
  SHEET_ID: z.string().trim().default(''),
  SHEET_SYNC_CRON: z.string().default('5 * * * *'),
  // Tab gids: Аркуш3 (tracking), Аркуш5 (БЦ warehouse intake), Черноморск
  // (cost comparison) and Аркуш4 (quantities). Empty = tab not read.
  SHEET_GID_TRACKING: z.string().trim().default('1401749917'),
  SHEET_GID_WAREHOUSE: z.string().trim().default('409503827'),
  SHEET_GID_RATES: z.string().trim().default('389453399'),
  SHEET_GID_QUANTITIES: z.string().trim().default('873326925'),
  // Free time at the destination port (days after arrival before demurrage):
  // default, and per line ("MSC:10,MAERSK:7"); a «Free time» sheet column wins.
  SHEET_FREE_DAYS: z.coerce.number().int().min(0).max(120).default(7),
  SHEET_FREE_DAYS_BY_LINE: z.string().default(''),
  // aisstream.io (free) live AIS websocket — vessel positions for the live map.
  // Empty = positions are interpolated from carrier events + ETA.
  AISSTREAM_API_KEY: z.string().default(''),

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

/** Alternative env names (as used in the news service's .env) → canonical keys. */
const ENV_ALIASES: Record<string, string> = {
  NOVA_POSHTA_API_KEY: 'NOVAPOSHTA_API_KEY',
  SEVENTEEN_TRACK_KEY: 'TRACK17_API_KEY',
};

function loadConfig(): AppConfig {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [alias, key] of Object.entries(ENV_ALIASES)) {
    if (!env[key] && env[alias]) env[key] = env[alias];
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  // The .env.example placeholder passes min(16) — booting prod with it would let
  // anyone forge a JWT for any user. Refuse; merely-short secrets only warn (a
  // hard length check could take down an existing deployment on upgrade).
  const secret = parsed.data.JWT_SECRET;
  if (parsed.data.NODE_ENV === 'production') {
    if (/change-me/i.test(secret)) {
      // eslint-disable-next-line no-console
      console.error('JWT_SECRET is the .env.example placeholder — set a random one: openssl rand -base64 48');
      process.exit(1);
    }
    if (secret.length < 32) {
      // eslint-disable-next-line no-console
      console.warn('JWT_SECRET is shorter than 32 chars — rotate it: openssl rand -base64 48');
    }
  }
  return parsed.data;
}

export const config = loadConfig();
