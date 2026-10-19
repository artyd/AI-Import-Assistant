# Testing: infra-free unit tests, mocked e2e, golden eval

Backend unit tests (vitest, `src/**/__tests__/*.spec.ts`) run without Postgres, Redis or Anthropic; CI feeds dummy env values only to satisfy the zod config. Frontend Playwright e2e tests run against `next dev` with mocked API responses, and the specs that need the live stack skip unless `PW_BACKEND=1`. Extraction quality is measured separately on a labelled golden set (`eval/`).

## Consequences

CI checks every push to `main`. Deployment is manual for now (`git pull && docker compose up -d --build` on the server): `deploy.yml` deploys automatically after a green CI run only once the repo variable `DEPLOY_ENABLED=true` is set, so nothing beyond these tests runs before production.
