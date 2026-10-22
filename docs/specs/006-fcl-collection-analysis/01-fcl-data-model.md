# 01 — Модель FCL + міграція збірників

Status: resolved

## Що зробити

Schema (`src/db/schema.sql`, ідемпотентно):

- `workspaces.kind TEXT NOT NULL DEFAULT 'shipment' CHECK (kind IN ('shipment','fcl'))`.
- `workspaces.eu_transit BOOLEAN` (NULL = невідомо; виводиться з документів, людина може задати).
- Таблиця `lots`: `id, workspace_id → workspaces CASCADE, name, supplier_name, supplier_key,
  consignee, incoterm_in, incoterm_out, product_category, contract_type, contract_type_source,
  status (draft|docs_in_progress|docs_complete|customs_ready), source (auto|manual),
  auto_fields TEXT[], position, created_at`.
- `folders.lot_id → lots ON DELETE CASCADE` (NULL = папка рівня FCL або звичайна поставка).
- `parties.lot_id`, `workspace_checklist_items.lot_id`, `supplier_instructions.lot_id` → lots CASCADE, nullable.
- `analyses.workspace_id`, `archive_records.workspace_id`; `analyses.collection_id` стає nullable.
- Міграція `collections` → `workspaces(kind='fcl')` **з тим самим id**: folders/files/conversations
  переносяться (`workspace_id = collection_id`, `collection_id = NULL`), analyses/archive отримують
  `workspace_id`. Файли мігрованих збірників: `status='queued'`, `status_changed_at = NULL` —
  retry-sweep сам поставить їх у чергу. Старі папки збірника лишаються.
- Скелет FCL: `FCL_FOLDER_SKELETON = ['01_Маніфест','02_Транспорт','03_Митниця']`.

Код:

- `WorkspaceRow.kind`, `eu_transit`; `GET /api/workspaces` повертає лише `kind='shipment'`.
- `/api/collections*` працюють поверх `workspaces kind='fcl'` (той самий wire-формат: id, number,
  supplier, status, created_at). `getOwnedCollection` = `getOwnedWorkspace` + kind.
- `documents/collectionFiles.routes.ts` видаляється: файли FCL ідуть через
  `/api/workspaces/:id/files` (черга, читання, SSE `file_status`).
- `analysis/*` пишуть `workspace_id`; `run_consolidated_analysis` бере `ctx.workspaceId` для FCL.
- GLOSSARY (Collection / Lot), ADR-0014 «Collection is a kind of shipment», API_CONTRACT.

## Приймання

- typecheck/test/build зелені; тести на фільтр `kind`.
- Наявні збірники відкриваються з тим самим id, файли перечитуються.
