# Admin-seeded users, JWT, one-time SSE tickets

There is no public sign-up: users are created with `npm run seed` and log in with email + password (bcrypt), receiving a JWT. EventSource cannot send headers, so SSE streams authenticate with a one-time `?ticket=`; the JWT is never accepted in a query string or cookie. The PIN login was removed after the 2026-09-30 audit and then brought back as opt-in only (6–8 digits bound to `ACCESS_CODE_EMAIL`, throttled, with a global lockout).
