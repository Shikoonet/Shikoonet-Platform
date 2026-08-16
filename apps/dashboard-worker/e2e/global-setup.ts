/**
 * Make sure the operator this suite signs in as actually has a role.
 *
 * `TEST_ACCESS_USER` skips the Cloudflare Access JWT; it does not grant
 * anything. The role still comes from `access_users`, and that table is
 * truncated by the unit suites — so whether `pnpm e2e` passes depended on
 * whether somebody had run `seed:sim` since the last `pnpm test`. The failure
 * is a flat 403 on every page, which reads as a broken panel rather than as a
 * missing fixture, and it cost the first two runs of this file.
 *
 * The row is a fixture, not the thing under test: these specs assert on
 * `bot_texts`. Setting it here rather than requiring a command in the right
 * order is what makes the suite self-sufficient.
 */

import { createPostgresD1 } from '@shikoo/db';

export default async function globalSetup(): Promise<void> {
  const email = process.env.TEST_ACCESS_USER;
  const url = process.env.DATABASE_URL;
  if (!email || !url) {
    throw new Error(
      'TEST_ACCESS_USER and DATABASE_URL must be set — run `pnpm e2e` with sim/.env.local loaded',
    );
  }

  const { db, pool } = createPostgresD1({ connectionString: url });
  try {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
         VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)
         ON CONFLICT (email) DO UPDATE SET role = 'ADMIN', active = 1, updated_at = ?3`,
      )
      .bind(`e2e-${email}`, email, now)
      .run();
  } finally {
    await pool.end();
  }
}
