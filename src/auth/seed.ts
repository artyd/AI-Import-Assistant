import { pool, query } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from './passwords.js';

/**
 * Admin-seeded user creation (no public signup).
 *   npm run seed -- <email> <password> [name]
 * Idempotent: updates the password if the user already exists.
 */
async function main(): Promise<void> {
  const [, , email, password, name] = process.argv;
  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run seed -- <email> <password> [name]');
    process.exit(1);
  }

  await runMigrations();
  const passwordHash = await hashPassword(password);

  await query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name)`,
    [email.toLowerCase(), passwordHash, name ?? ''],
  );

  // eslint-disable-next-line no-console
  console.log(`Seeded user ${email}`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed', err);
  process.exit(1);
});
