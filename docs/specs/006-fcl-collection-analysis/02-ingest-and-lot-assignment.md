# 02 — Читання файлів FCL + авторозкладання по партіях

Status: ready-for-agent
Blocked by: 01

## Що зробити

- Витяг: нові опційні поля `transport_doc_kind` (`mbl|hbl|awb|cmr|transit|manifest|other`),
  `container_numbers: string[]`, `vessel`. Опис у схемі інструмента витягу, нормалізація,
  резервне визначення виду транспортного документа за назвою/номером (HBL/house, MBL/master,
  T1/NCTS/MRN, CMR, manifest).
- Чистий модуль `src/shipments/lotAssign.ts`:
  `assignLot(doc, lots, ctx) → { target: lot | 'new' | 'fcl' | 'inbox', reason, confidence }`
  за правилами спеки (продавець → посередник/ланцюг → збіг товарів → виробник/експортер/
  batch → HBL shipper). Нова партія лише з якірних документів (invoice/contract/PL/HBL).
- `classifyAndFile` для `kind='fcl'`: замість `DOC_TYPE_TO_FOLDER` — `assignLot`; створює партію
  та її папку «Партія — <постачальник>» під advisory-lock на workspace; FCL-документи →
  `02_Транспорт` / `03_Митниця` / `01_Маніфест`; невпевнене → Інбокс із підказкою.
- Ручне перенесення файлу між папками вже викликає `shipmentChanged(…,'files')`; партія
  змінюється автоматично, бо береться з папки.
- `sort_inbox` для FCL проходить тим самим шляхом.

## Приймання

- Юніт-тести `lotAssign` на фікстурах у стилі «Сборник 18» (кілька постачальників, посередник,
  CoA без продавця, HBL, MBL, T1).
- Паралельне створення партії не дублює її (lock).
