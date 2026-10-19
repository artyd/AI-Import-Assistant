# Testing: infra-free unit tests, mocked e2e, golden eval

Backend unit tests (vitest, `src/**/__tests__/*.spec.ts`) run without Postgres, Redis or Anthropic. CI feeds dummy env values only to satisfy the zod config. Frontend Playwright e2e tests run against `next dev` with mocked API responses, and the specs that need the live stack self-skip unless `PW_BACKEND=1`. Extraction quality is measured separately on a labelled golden set (`eval/`). Pushing to `main` deploys once CI is green (`deploy.yml`), so CI is the only gate.
