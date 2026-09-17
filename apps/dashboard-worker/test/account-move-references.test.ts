/**
 * Moving one account's history and numbers into another.
 *
 * «انتقال شناسه‌ها» moved the `financial_account_identifiers` rows and left
 * the source's own columns — `account_hint`, `card_last_four`,
 * `account_last_four`, `iban` — saying the number was still its. The resolver
 * probes both, so the next SMS for that number matched the target by
 * identifier and the source by column: `account.identifier_ambiguous`,
 * NEEDS_REVIEW, nobody's money.
 *
 * Production, 2026-09-17 10:51 UTC: «ملی-آینده» was moved into «رسالت-هنرمند»
 * with the source kept, then switched back on. Its card stayed in the queue;
 * every deposit into it from then on would have resolved to two accounts.
 * The same shape as the PATCH bug fixed in #270, through a different door.
 *
 * The rule now: a number lives in one place. Moving it takes it off the
 * source's columns in the same batch, and the target's empty column of that
 * kind adopts it so the screen shows what ingest matches on.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveAccountByHint } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-move@example.com';
const PREFIX = 'zz-move-';

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/** Through the route, so the identifier rows are the ones production has. */
async function createAccount(name: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request(
    '/api/v1/accounts',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bank_name: 'BANK',
        account_type: 'ACCOUNT',
        display_name: `${PREFIX}${name}`,
        ...body,
      }),
    },
    envAs(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

function move(sourceId: string, targetAccountId: string, options: Record<string, boolean> = {}) {
  return app.request(
    `/api/v1/accounts/${sourceId}/move-references`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAccountId, options }),
    },
    envAs(),
  );
}

async function resolves(hint: string): Promise<string | 'none' | 'ambiguous'> {
  const r = await resolveAccountByHint(baseEnv.DB, hint);
  if (r.status === 'OK') return r.accountId;
  if (r.status === 'NOT_FOUND') return 'none';
  return 'ambiguous';
}

type Columns = {
  account_hint: string | null;
  card_last_four: string | null;
  account_last_four: string | null;
  iban: string | null;
  active: number;
};

async function columnsOf(id: string): Promise<Columns | null> {
  const row = await baseEnv.DB.prepare(
    `SELECT account_hint, card_last_four, account_last_four, iban, active
       FROM financial_accounts WHERE id = ?1`,
  )
    .bind(id)
    .first<Columns>();
  return row ? { ...row, active: Number(row.active) } : null;
}

async function identifiersOf(id: string): Promise<string[]> {
  const rows = await baseEnv.DB.prepare(
    `SELECT kind, value FROM financial_account_identifiers
      WHERE financial_account_id = ?1 ORDER BY kind, value`,
  )
    .bind(id)
    .all<{ kind: string; value: string }>();
  return rows.results.map((r) => `${r.kind}:${r.value}`);
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
  await baseEnv.DB.prepare(`DELETE FROM financial_accounts WHERE display_name LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
});

describe('moving the numbers with the history', () => {
  it('takes the number off the source, so the next SMS resolves to the target alone', async () => {
    // THE regression: «ملی-آینده» → «رسالت-هنرمند», source kept.
    const target = await createAccount('target', { account_hint: '10.14438208.1', card_last_four: '3504' });
    const source = await createAccount('source', { account_hint: '06006', card_last_four: '6308' });

    expect((await move(source, target)).status).toBe(200);

    expect(await resolves('06006')).toBe(target);
    expect(await resolves('6308')).toBe(target);
    expect(await columnsOf(source)).toMatchObject({ account_hint: null, card_last_four: null, active: 1 });
    expect(await identifiersOf(source)).toEqual([]);
    expect(await identifiersOf(target)).toEqual([
      'ACCOUNT_HINT:06006',
      'ACCOUNT_HINT:10.14438208.1',
      'CARD_LAST_FOUR:3504',
      'CARD_LAST_FOUR:6308',
    ]);
    // The target keeps its own numbers on the screen.
    expect(await columnsOf(target)).toMatchObject({ account_hint: '10.14438208.1', card_last_four: '3504' });
  });

  it('a target with no number of that kind adopts the moved one on the screen too', async () => {
    const target = await createAccount('bare', { account_hint: '4436995648' });
    const source = await createAccount('cardful', {
      card_last_four: '1845',
      account_last_four: '5648',
      iban: 'IR000000000000000000000009',
    });

    expect((await move(source, target)).status).toBe(200);

    expect(await columnsOf(target)).toMatchObject({
      account_hint: '4436995648',
      card_last_four: '1845',
      account_last_four: '5648',
      iban: 'IR000000000000000000000009',
    });
    expect(await columnsOf(source)).toMatchObject({
      account_hint: null,
      card_last_four: null,
      account_last_four: null,
      iban: null,
    });
    expect(await resolves('1845')).toBe(target);
    expect(await resolves('IR000000000000000000000009')).toBe(target);
  });

  it('with «انتقال شناسه‌ها» off, the source keeps its numbers in both places', async () => {
    const target = await createAccount('t2', { account_hint: '70008' });
    const source = await createAccount('s2', { account_hint: '300432401476', card_last_four: '7159' });

    expect((await move(source, target, { moveIdentifiers: false })).status).toBe(200);

    expect(await columnsOf(source)).toMatchObject({ account_hint: '300432401476', card_last_four: '7159' });
    expect(await identifiersOf(source)).toEqual(['ACCOUNT_HINT:300432401476', 'CARD_LAST_FOUR:7159']);
    expect(await resolves('300432401476')).toBe(source);
    expect(await identifiersOf(target)).toEqual(['ACCOUNT_HINT:70008']);
  });

  it('a hand-assigned identifier moves as an identifier and touches no column', async () => {
    const target = await createAccount('t3', { account_hint: '20101347595604' });
    const source = await createAccount('s3', { account_hint: '30101883751600' });
    await baseEnv.DB.prepare(
      `INSERT INTO financial_account_identifiers (id, financial_account_id, kind, value, label, created_at)
       VALUES (?1, ?2, 'ACCOUNT_HINT', '030101883751600', NULL, 1)`,
    )
      .bind(crypto.randomUUID(), source)
      .run();

    expect((await move(source, target)).status).toBe(200);

    expect(await columnsOf(target)).toMatchObject({ account_hint: '20101347595604' });
    expect(await identifiersOf(target)).toEqual([
      'ACCOUNT_HINT:030101883751600',
      'ACCOUNT_HINT:20101347595604',
      'ACCOUNT_HINT:30101883751600',
    ]);
    expect(await resolves('030101883751600')).toBe(target);
  });

  it('deleting the source still works, and takes its numbers with it', async () => {
    const target = await createAccount('keep', { account_hint: '110.7007.2377306.1' });
    const source = await createAccount('gone', { account_hint: '110.9992.2377306.1', card_last_four: '7613' });

    const res = await move(source, target, { deleteSource: true });

    expect(res.status).toBe(200);
    expect((await res.json()) as { deletedSource: boolean }).toMatchObject({ deletedSource: true });
    expect(await columnsOf(source)).toBeNull();
    expect(await resolves('110.9992.2377306.1')).toBe(target);
    expect(await resolves('7613')).toBe(target);
  });
});
