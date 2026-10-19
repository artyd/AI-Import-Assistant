# Admin-seeded users, JWT, one-time SSE tickets

There is no public sign-up: users are created with `npm run seed` and log in with email + password (bcrypt), receiving a JWT. EventSource cannot send headers, so SSE streams authenticate with a one-time `?ticket=`; the JWT is never accepted in a query string or cookie.

## Consequences

The quick PIN login stays off until `ACCESS_CODE` (6–8 digits) is set. When on, it opens `ACCESS_CODE_EMAIL`'s account (or the first account), is limited per IP, and is locked globally for 24 h after `ACCESS_CODE_MAX_FAILURES` wrong PINs; password login keeps working. Whether production has it on is an `.env` matter, not part of this decision.
