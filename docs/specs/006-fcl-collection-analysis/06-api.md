# 06 — API партій і FCL

Status: ready-for-agent
Blocked by: 03, 04, 05

## Маршрути (`src/shipments/lots.routes.ts`; усі через `getOwnedWorkspace`, тіла через zod)

- `GET /api/workspaces/:id/lots` — партії + світлофор (комплектність x/y, 🔴/🟡, ризики, статус,
  кількість файлів) + «Без партії: N файлів».
- `POST /api/workspaces/:id/lots` — створити партію вручну (+ папка).
- `PATCH /api/workspaces/:id/lots/:lotId` — назва, отримувач, Incoterms, категорія, тип контракту
  (людське значення знімає поле з `auto_fields`) → `shipmentChanged(id,'context')`.
- `DELETE /api/workspaces/:id/lots/:lotId` — файли → Інбокс, папка й партія видаляються →
  `shipmentChanged(id,'files')`.
- `GET /api/workspaces/:id/fcl` — зведення FCL: контекст, комплектність FCL, транспорт,
  отримувачі, звірка маніфесту, ризики, статус.
- `?lotId=` для `/checklist`, `/discrepancies`, `/risks`, `/parties`.
- `API_CONTRACT.md` оновлено (збірник як FCL, кінець «no indexing» для збірників).
