# 07 — Штурман у чаті збірника

Status: ready-for-agent
Blocked by: 06

## Що зробити

- `chatConsolidated.routes.ts`: ToolContext `{ workspaceId: fcl.id, ownerId }`; набір —
  усі інструменти поставки + `run_consolidated_analysis` + logist/hub/sheet.
- Параметр `lot` (назва або id) у `get_checklist`, `get_discrepancies`, `get_risks`;
  без нього у FCL — рівень FCL + зведення по партіях.
- Нові інструменти: `list_lots`, `assign_file_to_lot` (переносить файл у папку партії →
  `shipmentChanged`), `get_fcl_overview` (вердикти FCL з 04/05).
- `buildConsolidatedSystemPrompt`: правила заземлення поставки + модель FCL/партій; аналіз
  маніфесту — інструментом; «немає даних» замість припущень.
- `npm run eval:grounding` зелений.
