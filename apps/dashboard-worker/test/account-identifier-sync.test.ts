/**
 * Editing an account's number on the screen must move the number ingest
 * matches on.
 *
 * `POST /accounts` writes each canonical column (`account_hint`,
 * `card_last_four`, `account_last_four`, `iban`) twice: on the row, and as a
 * `financial_account_identifiers` row of the matching kind, because the
 * resolver (`resolveAccountByHint`) probes both. `PATCH /accounts/:id` only
 * ever rewrote the column. So the identifier table kept whatever the operator
 * typed FIRST, and an SMS for the corrected number resolved by the column
 * while an SMS for the old typo still resolved by the identifier.
 *
 * Production, 2026-09-16: «گردشگری1» was created with «گردشگری2»'s number,
 * corrected a minute later, and from then on every deposit into «گردشگری2»
 * matched both accounts — `account.identifier_ambiguous`, NEEDS_REVIEW, and
 * two real payments nobody could settle. Deactivating one did not help; the
 * resolver reads `status`, not `active`, on purpose.
 *
 * Every test here asks the resolver, not the table. The table is the
 * mechanism; whether an SMS lands is the fact.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveAccountByHint } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-idsync@example.com';
const PREFIX = 'zz-idsync-';

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/** Through the route, so the identifier rows are the ones production has. */
async function createAccount(body: Record<string, unknown>): Promise<string> {
  const res = await app.request(
    '/api/v1/accounts',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bank_name: 'BANK',
        account_type: 'ACCOUNT',
        ...body,
        display_name: `${PREFIX}${String(body.display_name ?? 'x')}`,
      }),
    },
    envAs(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

function patch(id: string, body: unknown) {
  return app.request(
    `/api/v1/accounts/${id}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(),
  );
}

async function resolves(hint: string): Promise<string | 'none' | 'ambiguous'> {
  const r = await resolveAccountByHint(baseEnv.DB, hint);
  if (r.status === 'OK') return r.accountId;
  if (r.status === 'NOT_FOUND') return 'none';
  return 'ambiguous';
}

async function identifiersOf(id: string): Promise<Array<{ kind: string; value: string }>> {
  const rows = await baseEnv.DB.prepare(
    `SELECT kind, value FROM financial_account_identifiers
      WHERE financial_account_id = ?1 ORDER BY kind, value`,
  )
    .bind(id)
    .all<{ kind: string; value: string }>();
  return rows.results;
}

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), ADMIN, Date.now())
    .run();
});

beforeEach(async () => {
  // Identifiers cascade from the account row.
  await baseEnv.DB.prepare(`DELETE FROM financial_accounts WHERE display_name LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
});

describe('editing the number an account answers to', () => {
  it('moves the account hint the resolver matches on', async () => {
    // THE regression, in the shape it had on production.
    const two = await createAccount({ display_name: 'two', account_hint: '110.7007.2377306.1' });
    const one = await createAccount({ display_name: 'one', account_hint: '110.7007.2377306.9' });
    // «one» was typed with a number that is nearly «two»'s; the operator fixes it.
    expect((await patch(one, { account_hint: '110.9992.2377306.1' })).status).toBe(200);

    expect(await resolves('110.9992.2377306.1')).toBe(one);
    expect(await resolves('110.7007.2377306.9')).toBe('none');
    expect(await resolves('110.7007.2377306.1')).toBe(two);
  });

  it('does the same for the card, the account tail and the IBAN', async () => {
    const id = await createAccount({
      display_name: 'all',
      account_hint: '4436995648',
      card_last_four: '1845',
      account_last_four: '5648',
      iban: 'IR000000000000000000000001',
    });

    expect(
      (
        await patch(id, {
          card_last_four: '1846',
          account_last_four: '5649',
          iban: 'IR000000000000000000000002',
        })
      ).status,
    ).toBe(200);

    expect(await resolves('1845')).toBe('none');
    expect(await resolves('1846')).toBe(id);
    expect(await resolves('5648')).toBe('none');
    expect(await resolves('5649')).toBe(id);
    expect(await resolves('IR000000000000000000000001')).toBe('none');
    expect(await resolves('IR000000000000000000000002')).toBe(id);
    // The untouched column keeps its identifier.
    expect(await resolves('4436995648')).toBe(id);
  });

  it('clearing a number removes it from matching', async () => {
    const id = await createAccount({ display_name: 'clear', account_hint: '70008', card_last_four: '1473' });

    expect((await patch(id, { card_last_four: null })).status).toBe(200);

    expect(await resolves('1473')).toBe('none');
    expect(await resolves('70008')).toBe(id);
    expect(await identifiersOf(id)).toEqual([{ kind: 'ACCOUNT_HINT', value: '70008' }]);
  });

  it('refuses a number another account already answers to, and changes nothing', async () => {
    // `idx_fai_unique_active_value` refuses the identifier; the column update
    // is in the same transaction, so the row cannot say one thing and the
    // resolver another.
    const owner = await createAccount({ display_name: 'owner', account_hint: '9001017429938' });
    const other = await createAccount({ display_name: 'other', account_hint: '7001018246497' });

    const res = await patch(other, { account_hint: '9001017429938', display_name: 'renamed' });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS',
    });
    expect(await resolves('9001017429938')).toBe(owner);
    expect(await resolves('7001018246497')).toBe(other);
    const row = await baseEnv.DB.prepare(
      `SELECT account_hint, display_name FROM financial_accounts WHERE id = ?1`,
    )
      .bind(other)
      .first<{ account_hint: string; display_name: string }>();
    expect(row).toMatchObject({ account_hint: '7001018246497', display_name: `${PREFIX}other` });
  });

  it('leaves identifiers an operator assigned by hand alone', async () => {
    // «assign identifier» adds rows that mirror no column — an SMS hint in a
    // second format, say. Editing the column must not sweep those away.
    const id = await createAccount({ display_name: 'extra', account_hint: '300432401476' });
    await baseEnv.DB.prepare(
      `INSERT INTO financial_account_identifiers (id, financial_account_id, kind, value, label, created_at)
       VALUES (?1, ?2, 'ACCOUNT_HINT', '0300432401476', NULL, 1)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();

    expect((await patch(id, { account_hint: '300432401477' })).status).toBe(200);

    expect(await resolves('300432401476')).toBe('none');
    expect(await resolves('300432401477')).toBe(id);
    expect(await resolves('0300432401476')).toBe(id);
  });

  it('a change to nothing but the name touches no identifier', async () => {
    const id = await createAccount({ display_name: 'name', account_hint: '06006', card_last_four: '6308' });
    const before = await identifiersOf(id);

    expect((await patch(id, { display_name: `${PREFIX}renamed` })).status).toBe(200);

    expect(await identifiersOf(id)).toEqual(before);
  });

  it('writing the same number again is a no-op, not a duplicate', async () => {
    const id = await createAccount({ display_name: 'same', account_hint: '20101347595604' });

    expect((await patch(id, { account_hint: '20101347595604' })).status).toBe(200);

    expect(await identifiersOf(id)).toEqual([{ kind: 'ACCOUNT_HINT', value: '20101347595604' }]);
    expect(await resolves('20101347595604')).toBe(id);
  });
});
