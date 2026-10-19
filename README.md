# AI Import Assistant (Штурман)

A workspace for Ukrainian import logistics. A single Claude agent, Штурман, checks
a shipment's documents against each other (invoice, contract, packing list),
tracks how complete the document package is, gives advisory УКТ ЗЕД codes, and
follows cargo on a logistics hub fed by the team's Google Sheet.

```
src/          backend (Fastify + BullMQ worker), one folder per domain area, infra in src/lib/
frontend/     Next.js app, components/<area>/
logist-mcp/   internal Python reference service (qdpro, NBU, PubChem)
eval/         golden-set evaluation
docs/         adr/ · specs/ · audits/ · agents/
```

- How to work in this repo: [`CLAUDE.md`](CLAUDE.md)
- Domain terms: [`GLOSSARY.md`](GLOSSARY.md)
- Decisions: [`docs/adr/`](docs/adr/)
- API: [`API_CONTRACT.md`](API_CONTRACT.md) · Deploy: [`DEPLOYMENT.md`](DEPLOYMENT.md)

Quick start: `npm install && npm run dev` (API), `npm run dev:worker`, and
`cd frontend && npm install && npm run dev`. Env vars are listed in `.env.example`.
