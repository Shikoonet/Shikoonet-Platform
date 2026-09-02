/**
 * `PATCH /api/v1/devices/:idOrCode` — the display name, and provably nothing
 * else.
 *
 * The reason this file is long for a one-column UPDATE: renaming is the one
 * device operation an operator will reach for casually, and the cost of it
 * quietly doing anything more is the whole payment chain. `POST /api/v1/sms` is
 * this platform's only public surface, a device key is what authorises it, and
 * that key is typed into an Android handset by hand — so a rename that rotated
 * a credential, or recreated the row, would stop bank SMS arriving from a phone
 * nobody is holding, and the first symptom would be customers who paid sitting
 * unverified.
 *
 * So the assertions are mostly negative, and they are asked of the database
 * rather than of the response: same `devices.id`, same `device_credentials`
 * row, same `token_hash`, same `created_at`, same everything except
 * `display_name` and `updated_at`. `columnsThatChanged` compares whole row
 * snapshots so a column added to `devices` later is covered the day it is
 * added — a hand-written list of columns to check would go stale in silence,
 * which is the exact failure this file exists to prevent.
 *
 * What is NOT here: proof that a renamed device keeps ingesting. That needs
 * both workers and lives in `apps/ingest-worker/test/device-rename-ingest.test.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'rename-admin@example.com';
const REVIEWER = 'rename-reviewer@example.com';
const READER = 'rename-reader@example.com';

/** A C0 control and a right-to-left override, spelled so this file stays ASCII. */
const NUL = '\u0000';
const RLO = '\u202E';
/** Zero-width non-joiner — `Cf`, like the RLO, and ordinary Persian spelling. */
const ZWNJ = '\u200C';

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('TRUNCATE audit_logs CASCADE'),
    baseEnv.DB.prepare('DELETE FROM reconciliation_matches'),
    baseEnv.DB.prepare('DELETE FROM payment_claims'),
    baseEnv.DB.prepare('DELETE FROM transaction_candidates'),
    baseEnv.DB.prepare('DELETE FROM raw_sms_events'),
    baseEnv.DB.prepare('DELETE FROM financial_accounts'),
    baseEnv.DB.prepare('DELETE FROM device_credentials'),
    baseEnv.DB.prepare('DELETE FROM devices'),
    baseEnv.DB.prepare('DELETE FROM access_users'),
  ]);
}

async function seedOperator(email: string, role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY') {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
  )
    .bind(crypto.randomUUID(), email, role, now)
    .run();
}

async function seedDevice(code: string, displayName: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, description, active,
                          last_seen_at, last_success_at, last_auth_failure_at,
                          created_at, updated_at)
     VALUES (?1, ?2, ?3, 'a spare handset', 1, ?4, ?4, NULL, ?4, ?4)`,
  )
    .bind(id, code, displayName, now)
    .run();
  return id;
}

async function seedCredential(deviceId: string): Promise<string> {
  const id = crypto.randomUUID();
  const hash = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await baseEnv.DB.prepare(
    `INSERT INTO device_credentials
       (id, device_id, token_hash, token_prefix, status, created_at, activated_at, last_used_at)
     VALUES (?1, ?2, ?3, 'abcd', 'ACTIVE', ?4, ?4, ?4)`,
  )
    .bind(id, deviceId, hash, Date.now())
    .run();
  return id;
}

/** Every column of one row, so nothing has to be enumerated by hand. */
async function deviceRow(id: string): Promise<Record<string, unknown>> {
  const row = await baseEnv.DB.prepare(`SELECT * FROM devices WHERE id = ?1`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw new Error(`device ${id} is gone`);
  return row;
}

async function credentialRows(deviceId: string): Promise<Record<string, unknown>[]> {
  const r = await baseEnv.DB.prepare(
    `SELECT * FROM device_credentials WHERE device_id = ?1 ORDER BY id`,
  )
    .bind(deviceId)
    .all<Record<string, unknown>>();
  return r.results;
}

function columnsThatChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

function rename(idOrCode: string, body: unknown, actor: string): Request {
  return new Request(`https://example.com/api/v1/devices/${encodeURIComponent(idOrCode)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'cf-access-authenticated-user-email': actor,
    },
    body: JSON.stringify(body),
  });
}

const as = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });

beforeAll(applySchema);

beforeEach(async () => {
  await resetTables();
  await seedOperator(ADMIN, 'ADMIN');
  await seedOperator(REVIEWER, 'REVIEWER');
  await seedOperator(READER, 'READ_ONLY');
});

describe('PATCH /api/v1/devices/:idOrCode — authorization', () => {
  it('an ADMIN may rename', async () => {
    const id = await seedDevice('phone-a', 'Phone A');
    const r = await app.fetch(rename(id, { displayName: 'Phone A2' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; device: { displayName: string } };
    expect(body.ok).toBe(true);
    expect(body.device.displayName).toBe('Phone A2');
    expect((await deviceRow(id)).display_name).toBe('Phone A2');
  });

  it('refuses READ_ONLY with 403 and writes nothing', async () => {
    const id = await seedDevice('phone-b', 'Phone B');
    const r = await app.fetch(rename(id, { displayName: 'Nope' }, READER), as(READER));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'forbidden' });
    expect((await deviceRow(id)).display_name).toBe('Phone B');
  });

  it('refuses a caller with no session with 401', async () => {
    const id = await seedDevice('phone-c', 'Phone C');
    const r = await app.fetch(rename(id, { displayName: 'Nope' }, ''), {
      ...baseEnv,
      TEST_ACCESS_USER: '',
    });
    expect(r.status).toBe(401);
    expect((await deviceRow(id)).display_name).toBe('Phone C');
  });

  it('refuses an address with no operator row with 401', async () => {
    const id = await seedDevice('phone-d', 'Phone D');
    const r = await app.fetch(rename(id, { displayName: 'Nope' }, 'ghost@example.com'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'ghost@example.com',
    });
    expect(r.status).toBe(401);
    expect((await deviceRow(id)).display_name).toBe('Phone D');
  });

  it('lets a REVIEWER rename — the role that may already rotate this key', async () => {
    const id = await seedDevice('phone-e', 'Phone E');
    const r = await app.fetch(rename(id, { displayName: 'Phone E2' }, REVIEWER), as(REVIEWER));
    expect(r.status).toBe(200);
    expect((await deviceRow(id)).display_name).toBe('Phone E2');
  });
});

describe('PATCH /api/v1/devices/:idOrCode — validation', () => {
  const bad: [string, unknown, string][] = [
    ['an empty name', { displayName: '' }, 'required'],
    ['whitespace only', { displayName: '   \t  ' }, 'required'],
    ['a missing name', {}, 'invalid_body'],
    ['a name that is not a string', { displayName: 42 }, 'invalid_body'],
    ['a name past 200 characters', { displayName: 'x'.repeat(201) }, 'length'],
    ['a newline', { displayName: 'Phone\nA' }, 'control_characters'],
    ['a NUL', { displayName: `Phone${NUL}A` }, 'control_characters'],
    ['a right-to-left override', { displayName: `Phone${RLO}A` }, 'control_characters'],
  ];

  for (const [what, body, reason] of bad) {
    it(`refuses ${what}`, async () => {
      const id = await seedDevice('phone-v', 'Original');
      const r = await app.fetch(rename(id, body, ADMIN), as(ADMIN));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject(
        reason === 'invalid_body'
          ? { error: 'invalid_body' }
          : { error: 'invalid_display_name', reason },
      );
      expect((await deviceRow(id)).display_name).toBe('Original');
    });
  }

  it('refuses a body that carries anything but the name', async () => {
    const id = await seedDevice('phone-w', 'Original');
    for (const extra of [
      { displayName: 'New', deviceCode: 'stolen-code' },
      { displayName: 'New', active: 0 },
      { displayName: 'New', apiKey: 'x'.repeat(64) },
    ]) {
      const r = await app.fetch(rename(id, extra, ADMIN), as(ADMIN));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'invalid_body' });
    }
    const row = await deviceRow(id);
    expect(row.display_name).toBe('Original');
    expect(row.device_code).toBe('phone-w');
    expect(row.active).toBe(1);
  });

  it('trims the surrounding whitespace rather than storing it', async () => {
    const id = await seedDevice('phone-x', 'Original');
    const r = await app.fetch(rename(id, { displayName: '  Phone X  ' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect((await deviceRow(id)).display_name).toBe('Phone X');
  });

  it('keeps a Persian name exactly, ZWNJ and all', async () => {
    // U+200C sits in the `Cf` category alongside the right-to-left override
    // refused above. It is ordinary Persian orthography and must survive:
    // «گوشی‌های» spelled without it is a different, wrong word. A validator
    // that refused the whole category would fail this test, which is why it
    // names the bidi controls one by one instead.
    const name = `گوشی${ZWNJ}های پویان ۲`;
    const id = await seedDevice('phone-y', 'Original');
    const r = await app.fetch(rename(id, { displayName: name }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect((await deviceRow(id)).display_name).toBe(name);

    // Read back through the list the dashboard actually renders, not only the
    // column: a name that survives Postgres and is mangled on the way out is
    // still a lost name.
    const list = await app.fetch(
      new Request('https://example.com/api/v1/devices', {
        headers: { 'cf-access-authenticated-user-email': ADMIN },
      }),
      as(ADMIN),
    );
    const items = ((await list.json()) as { items: { id: string; display_name: string }[] }).items;
    expect(items.find((d) => d.id === id)?.display_name).toBe(name);
  });

  it('accepts a name of exactly the maximum length', async () => {
    const id = await seedDevice('phone-z', 'Original');
    const name = 'ی'.repeat(200);
    const r = await app.fetch(rename(id, { displayName: name }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect((await deviceRow(id)).display_name).toBe(name);
  });

  it('has no opinion about two devices sharing a name, because the schema has none', async () => {
    // `device_code` is the UNIQUE column; `display_name` never has been, and
    // inventing a duplicate rule here would refuse a shop with two identical
    // spare handsets that create has always been happy to register.
    const a = await seedDevice('phone-dup-a', 'Spare');
    const b = await seedDevice('phone-dup-b', 'Other');
    const r = await app.fetch(rename(b, { displayName: 'Spare' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect((await deviceRow(a)).display_name).toBe('Spare');
    expect((await deviceRow(b)).display_name).toBe('Spare');
  });
});

describe('PATCH /api/v1/devices/:idOrCode — scope', () => {
  it('answers 404 for a device that does not exist', async () => {
    const r = await app.fetch(
      rename(crypto.randomUUID(), { displayName: 'Ghost' }, ADMIN),
      as(ADMIN),
    );
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'device_not_found' });
  });

  it('answers 404 for a device code nobody registered', async () => {
    const r = await app.fetch(rename('no-such-code', { displayName: 'Ghost' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'device_not_found' });
  });

  it('renames the device the code names, and no other', async () => {
    const a = await seedDevice('phone-one', 'One');
    const b = await seedDevice('phone-two', 'Two');
    const r = await app.fetch(rename('phone-one', { displayName: 'Renamed' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect((await deviceRow(a)).display_name).toBe('Renamed');
    expect((await deviceRow(b)).display_name).toBe('Two');
  });
});

describe('PATCH /api/v1/devices/:idOrCode — idempotence', () => {
  it('accepts the name it already has, writes nothing, and logs nothing', async () => {
    const id = await seedDevice('phone-i', 'Unchanged');
    const before = await deviceRow(id);
    const r = await app.fetch(rename(id, { displayName: 'Unchanged' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, unchanged: true });
    expect(columnsThatChanged(before, await deviceRow(id))).toEqual([]);
    const audit = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it('treats a name that only differs by surrounding whitespace as unchanged', async () => {
    const id = await seedDevice('phone-j', 'Unchanged');
    const before = await deviceRow(id);
    const r = await app.fetch(rename(id, { displayName: '  Unchanged ' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, unchanged: true });
    expect(columnsThatChanged(before, await deviceRow(id))).toEqual([]);
  });

  it('is safe to send twice — the second call writes nothing and logs once', async () => {
    const id = await seedDevice('phone-k', 'First');
    const r1 = await app.fetch(rename(id, { displayName: 'Second' }, ADMIN), as(ADMIN));
    expect(r1.status).toBe(200);
    const afterFirst = await deviceRow(id);
    const r2 = await app.fetch(rename(id, { displayName: 'Second' }, ADMIN), as(ADMIN));
    expect(r2.status).toBe(200);
    expect(columnsThatChanged(afterFirst, await deviceRow(id))).toEqual([]);
    const audit = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE entity_id = ?1 AND action = 'device.name.updated'`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });
});

describe('PATCH /api/v1/devices/:idOrCode — the audit row', () => {
  it('records who, when, and both names — and no secret', async () => {
    const id = await seedDevice('phone-audit', 'Before Name');
    const credentialId = await seedCredential(id);
    const hash = (await credentialRows(id))[0]?.token_hash as string;
    const t0 = Date.now();

    const r = await app.fetch(rename(id, { displayName: 'After Name' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);

    const row = await baseEnv.DB.prepare(
      `SELECT * FROM audit_logs WHERE entity_id = ?1 ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    expect(row?.action).toBe('device.name.updated');
    expect(row?.entity_type).toBe('DEVICE');
    expect(row?.entity_id).toBe(id);
    expect(row?.actor_email).toBe(ADMIN);
    expect(row?.actor_role).toBe('ADMIN');
    expect(Number(row?.created_at)).toBeGreaterThanOrEqual(t0);

    expect(JSON.parse(String(row?.before_json))).toMatchObject({
      deviceId: id,
      deviceCode: 'phone-audit',
      displayName: 'Before Name',
    });
    expect(JSON.parse(String(row?.after_json))).toMatchObject({
      deviceId: id,
      deviceCode: 'phone-audit',
      displayName: 'After Name',
    });

    // Nothing secret rides along. The credential id is not itself a secret, but
    // the hash is the stored form of the key and has no business in a log that
    // an operator can read on screen.
    const whole = JSON.stringify(row);
    expect(whole).not.toContain(hash);
    expect(whole.toLowerCase()).not.toContain('apikey');
    expect(whole.toLowerCase()).not.toContain('token');
    expect(whole).not.toContain(credentialId);
  });

  it('names the REVIEWER who did it, not the role that could have', async () => {
    const id = await seedDevice('phone-audit-2', 'Before');
    await app.fetch(rename(id, { displayName: 'After' }, REVIEWER), as(REVIEWER));
    const row = await baseEnv.DB.prepare(
      `SELECT actor_email, actor_role FROM audit_logs WHERE entity_id = ?1 LIMIT 1`,
    )
      .bind(id)
      .first<{ actor_email: string; actor_role: string }>();
    expect(row).toMatchObject({ actor_email: REVIEWER, actor_role: 'REVIEWER' });
  });
});

describe('PATCH /api/v1/devices/:idOrCode — what must not move', () => {
  it('changes display_name and updated_at, and no other column', async () => {
    const id = await seedDevice('phone-cols', 'Old');
    const before = await deviceRow(id);
    const r = await app.fetch(rename(id, { displayName: 'New' }, ADMIN), as(ADMIN));
    expect(r.status).toBe(200);
    expect(columnsThatChanged(before, await deviceRow(id))).toEqual(['display_name', 'updated_at']);
  });

  it('leaves the row itself — same id, same created_at, not deleted and remade', async () => {
    const id = await seedDevice('phone-same', 'Old');
    const before = await deviceRow(id);
    await app.fetch(rename(id, { displayName: 'New' }, ADMIN), as(ADMIN));
    const after = await deviceRow(id);
    expect(after.id).toBe(before.id);
    expect(after.created_at).toBe(before.created_at);
    // A delete-and-recreate would leave one row too; a recreate that reused the
    // code would leave two. Both are counted out here.
    const n = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM devices WHERE device_code = ?1`,
    )
      .bind('phone-same')
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('does not touch the credential — no rotation, no revocation, no new row', async () => {
    const id = await seedDevice('phone-cred', 'Old');
    const credentialId = await seedCredential(id);
    const before = await credentialRows(id);
    expect(before).toHaveLength(1);

    await app.fetch(rename(id, { displayName: 'New' }, ADMIN), as(ADMIN));

    const after = await credentialRows(id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(credentialId);
    expect(columnsThatChanged(before[0]!, after[0]!)).toEqual([]);
  });

  it('does not respond with anything secret', async () => {
    const id = await seedDevice('phone-resp', 'Old');
    await seedCredential(id);
    const r = await app.fetch(rename(id, { displayName: 'New' }, ADMIN), as(ADMIN));
    const text = await r.text();
    expect(text.toLowerCase()).not.toContain('apikey');
    expect(text.toLowerCase()).not.toContain('token');
    expect(text.toLowerCase()).not.toContain('credential');
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      device: {
        id,
        deviceCode: 'phone-resp',
        displayName: 'New',
        description: 'a spare handset',
        active: true,
      },
    });
  });

  it('leaves the SMS, accounts and transactions that already point at this device', async () => {
    const id = await seedDevice('phone-hist', 'Old');
    await seedCredential(id);

    const smsId = crypto.randomUUID();
    await baseEnv.DB.prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum,
          sms_timestamp, received_at, classification, parser_status, parser_id,
          parser_version, created_at)
       VALUES (?1, ?2, 'BANK', 'test body', ?3, 'c', ?4, ?4,
               'BANK_CREDIT', 'OK', 'test', 'v1', ?4)`,
    )
      .bind(smsId, id, crypto.randomUUID().replace(/-/g, ''), Date.now())
      .run();

    const accountId = crypto.randomUUID();
    await baseEnv.DB.prepare(
      `INSERT INTO financial_accounts
         (id, display_name, bank_name, account_type, owner_label, active,
          parser_configuration, device_id, created_at, updated_at)
       VALUES (?1, 'Shop card', 'PARSIAN', 'CARD', NULL, 1, '{}', ?2, ?3, ?3)`,
    )
      .bind(accountId, id, Date.now())
      .run();

    const txId = crypto.randomUUID();
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
          status, bank_timestamp, confidence, parser_id, parser_version,
          parser_evidence_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'CREDIT', 100000, 'NEEDS_REVIEW', ?4, 1.0,
               'test', 'v1', '{}', ?4, ?4)`,
    )
      .bind(txId, smsId, accountId, Date.now())
      .run();

    const read = async (table: string, rowId: string) =>
      (await baseEnv.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`)
        .bind(rowId)
        .first<Record<string, unknown>>())!;

    const beforeSms = await read('raw_sms_events', smsId);
    const beforeTx = await read('transaction_candidates', txId);
    const beforeAccount = await read('financial_accounts', accountId);

    await app.fetch(rename(id, { displayName: 'New' }, ADMIN), as(ADMIN));

    const afterSms = await read('raw_sms_events', smsId);
    const afterTx = await read('transaction_candidates', txId);
    const afterAccount = await read('financial_accounts', accountId);

    expect(afterSms.device_id).toBe(id);
    expect(afterAccount.device_id).toBe(id);
    expect(columnsThatChanged(beforeSms, afterSms)).toEqual([]);
    expect(columnsThatChanged(beforeTx, afterTx)).toEqual([]);
    expect(columnsThatChanged(beforeAccount, afterAccount)).toEqual([]);
  });
});

describe('POST /api/v1/devices — the same name rule', () => {
  it('refuses at create what the rename refuses, with the same reason', async () => {
    for (const [displayName, reason] of [
      ['   ', 'required'],
      ['x'.repeat(201), 'length'],
      ['Phone\nA', 'control_characters'],
    ] as const) {
      const r = await app.fetch(
        new Request('https://example.com/api/v1/devices', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-access-authenticated-user-email': ADMIN,
          },
          body: JSON.stringify({ deviceCode: 'phone-create', displayName }),
        }),
        as(ADMIN),
      );
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'invalid_display_name', reason });
    }
  });
});
