# False alarms — 2026-11-13

A user reported that the «Сборник 18» test shipment showed many document
errors, although the real consolidation cleared Ukrainian customs without
problems. The audit covered every chat kind, the Збірник (FCL) checks, the
consolidated analysis, the logist-mcp flags and the right sidebar, on all 19
production workspaces with files (read-only runs of the new code).

## The pattern

One bug, many places: **checks compared documents that legitimately differ, or
treated a conditional rule as mandatory, and the agent then repeated those
findings as problems without opening the files.**

| Kind | Example |
|---|---|
| Two legs of one deal | supplier contract (Xi'an → Prime Force, 34 400 USD, FCA) vs resale invoice (Prime Force → consignee, 65 000 USD, CPT) |
| Cargo split | supplier PL 10 500 kg / 2 goods vs resale invoice 10 000 kg / 1 good |
| Versions | «INVOICE PACKING LIST» 4080 kg vs «revised …» 4040 kg; DRAFT files; drum labels and photos as packing lists |
| Several suppliers in one shipment | weights of one supplier compared with another's |
| Dates vs today | certificate «expired 103 days ago» on a shipment cleared months earlier; export declarations counted as the Ukrainian МД |
| Conditional rules as mandatory | qdpro precursor measure with the 5069 «no precursors» statement, techregulation 5123 risk profile, vet control «для ветеринарної медицини», the sampling note «субстанції … ветеринарні», «не вказано» |
| Boilerplate keywords | MSDS «keep away from animal feedingstuffs» → feed goods → veterinary certificate required |
| Wrong parties | forwarders («iCargo … Logistik», «ДСВ ЛОГІСТИКА») chosen as supplier / intermediary |
| Name variants | «NGL Fine-Chem Limited, India» vs «…, Індія»; Cyrillic legal forms («ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ») |
| Agent | auto-check findings, «увага» flags and fact-sheet «конфлікт» listed as problems without reading the files |

## Fixed (commits e1b0567, 490e3c6, a95d7f4, f77f181)

- Reconciliation: deal legs, revisions, drafts, labels, consolidation note,
  manufacturer names; FCL manifest one line per invoice, unitless ≠ kg; HBL
  re-issued to another consignee is a note.
- Risks / registry: validity on the Ukrainian МД date; contract requisites are not
  a payment to the buyer; optional invoice and CoA boxes are not key fields.
- qdpro requirements: block-aware parser with conditional measures (parser rev 2
  re-fetches the cache); logist-mcp import flags the same way.
- Consolidated analysis: precursor regexes, АФІ / phyto conditional, risk
  calibration.
- Parties: forwarders and service bills excluded, chain through our intermediary
  preferred (old auto rows are kept until the user refreshes them).
- Agent: findings are candidates — open the files before answering; no internal
  keys in answers; HBL ≠ MBL and a supplier invoice to our consignee are normal;
  a repeated «навіщо?» is not an objection.
- Sidebar: notes collapsed, «перевірити» marked, human labels, failed loads said;
  «Запитати Штурмана» buttons and «Запитати» on findings send chat messages;
  Збірник sidebar with a lot list and lot view.
- Chat: copy and edit-and-resend of the user's own question.

## Result (19 production workspaces, read-only)

| | Before | After |
|---|---|---|
| Errors (red) | 25 | 6 |
| Warnings | 85 | 38 |
| «Missing document» | 50 | 40 |

TEST-Збірник 18 FCL: 6 red errors → 0. Regression specs:
`src/reconciliation/__tests__/sbornik18.spec.ts`, `falseAlarmsAudit.spec.ts`,
`src/analysis/__tests__/falseAlarms.spec.ts`.

## Still open

- Stale auto parties in TEST-Сборник 18 and 2026-1308: refresh in the sidebar.
- Метопрен: the shipment card stores CPT as the buy-side Incoterm.
- «Индия 12»: HBL and certificates of origin missing for 7 lots — unverified.
- 4 calendar Playwright tests fail since 2026-11-13 because of the date (also on
  the code before these changes); CI is red until they are fixed.
- No way yet for the user to mark a finding «не проблема» so it stays excluded.
