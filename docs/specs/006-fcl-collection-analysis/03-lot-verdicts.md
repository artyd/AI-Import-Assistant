# 03 — Вердикти партій + статус FCL

Status: ready-for-agent
Blocked by: 01, 02

## Що зробити

- `loadShipmentSnapshot(ws, { lot })`: файли партії (через `folders.lot_id`), посередник
  партії (`parties.lot_id`), контекст партії накладено на `ws` (`lotWorkspaceView(ws, lot)`).
- Вимоги партії: шаблон чекліста за контекстом партії **мінус** `customs_declaration`
  (вона на рівні FCL); `transport` у партії = HBL.
- Сторони партії: `analyzeParties(workspaceId, { lotId })` → `parties` з `lot_id`.
- Автоконтекст партії: Incoterms, тип контракту — з документів партії; людське значення не
  перезаписується (`lots.auto_fields`).
- `refreshWorkspaceState` для FCL: перерахунок кожної партії (чекліст з `lot_id`,
  `lots.status` лише вперед), потім рівень FCL (04); статус FCL = мінімум(партії, FCL),
  лише вперед.
- `shipmentChanged` для FCL проходить усе це; сповіщення про критичні ризики — з назвою партії.

## Приймання

- Юніт-тести: статус FCL = найгірша партія; партія без інвойсу → `docs_in_progress`.
- `state.spec.ts` зелений.
