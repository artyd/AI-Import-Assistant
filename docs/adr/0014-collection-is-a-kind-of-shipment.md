# A collection is a kind of shipment

A collection (Збірник) used to be a separate entity whose files were never read: only the manifest was analysed. The user needs the full shipment analysis on a collection too, and expects every later shipment improvement to reach collections as well. So a collection is now a workspace with `kind = 'fcl'` that holds lots (one supplier each), and the old `collections` rows migrate into `workspaces` with the same id (spec 006). Lot-level verdicts reuse `computeVerdicts` over the lot's files and the lot's context. The FCL-level checks (transport, manifest against documents, consignees) are a separate pure module.

## Consequences

A file's lot is the lot of its folder, so moving a file is the only way to change its lot and `shipmentChanged` covers it. Shipment-only lists filter on `kind = 'shipment'`. The `/api/collections` routes stay as the FCL entry point with their old wire shape. Their chats and analyses keep the `collection_id` column, which now holds the workspace id.
