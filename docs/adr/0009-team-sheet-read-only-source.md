# The team Google Sheet is a read-only source of truth

Shipment tracking for the calendar and the hub is synced hourly from the team's Google Sheet through its public CSV export (`SHEET_ID`). There is no service account and no write-back: values that come from the sheet are read-only in the app, and team notes stay in Штурман's own table. The team keeps working in the sheet, and the user accepted the trade-off.

## Consequences

Tests use synthetic rows only. Never commit real sheet data.
