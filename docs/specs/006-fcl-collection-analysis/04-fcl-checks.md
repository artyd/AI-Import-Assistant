# 04 — Зведені перевірки FCL

Status: ready-for-agent
Blocked by: 03

## Що зробити

Чистий модуль `src/reconciliation/fcl.ts` (без БД). Вхід — знімок FCL (файли FCL-рівня з
витягами + вердикти партій). Вихід — `{ checklist, discrepancies, risks, consignees, derivedStatus }`:

1. Комплектність FCL: `master_transport` (MBL / MAWB / CMR за `transport_mode`),
   `hbl` для кожної партії (море), `transit` + `cmr` коли `eu_transit` (явно або виведено:
   порт вивантаження MBL у ЄС), `manifest` (xlsx/csv у 01_Маніфест або витяг
   `transport_doc_kind='manifest'`), `customs_declaration` на кожного отримувача.
2. Транспорт цілком: контейнер(и) MBL vs HBL/T1/CMR; Σ брутто/місць HBL vs MBL (1%);
   T1 vs MBL; PL партії vs її HBL. 🔴 лише з двома цитатами.
3. Отримувачі: FCL-отримувач + перевизначення партій; МД покриває кожного (buyer/consignee МД).
4. Зведені ризики: ризики партій із префіксом партії + власні ризики FCL.

Статус FCL-рівня: як `deriveWorkspaceStatus`, але МД потрібні лише для `customs_ready`.

## Приймання

Юніт-тести на кожне правило (збіг / розбіжність / низька впевненість → 🟡).
