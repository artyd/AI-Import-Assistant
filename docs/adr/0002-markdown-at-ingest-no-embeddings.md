# Files become Markdown at ingest; no embedding vendor

Every file is converted once at ingest into File Markdown: Claude vision reads PDFs, scans and photos in 5-page windows, local converters handle office files, and LibreOffice handles legacy `.doc`. Search runs on Postgres full-text over document sections. Voyage + Qdrant were removed on 2026-09-30, because the free-tier rate limits left the index blind and Claude was already the real reader.

## Consequences

The agent keeps **both** `search_documents` (FTS, to locate text) and `read_file` (the whole Markdown) and chooses between them at runtime. Do not hard-code a single retrieval pipeline, and do not bring embeddings back without a new ADR.
