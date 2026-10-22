# 06 — API партій і FCL

Status: resolved
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
- `GET /api/workspaces/:id/lots/:lotId` — вердикти партії (комплектність, розбіжності, ризики,
  сторони) замість `?lotId=` на кожному маршруті; `POST …/lots/:lotId/parties` — сторони партії.
- `PATCH /api/workspaces/:id/fcl` — `eu_transit`; решта контексту FCL — `PATCH /api/workspaces/:id`.
- Маршрути поставки (`/checklist`, `/discrepancies`, `/risks`) для FCL повертають рівень FCL +
  знахідки партій з позначкою партії.
- `API_CONTRACT.md` оновлено (збірник як FCL, кінець «no indexing» для збірників).
