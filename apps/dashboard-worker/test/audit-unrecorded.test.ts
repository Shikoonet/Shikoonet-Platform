/**
 * What happens when the audit row is the thing that fails.
 *
 * Every one of the 53 `audit()` calls in this app is the last statement of a
 * handler whose write has already committed. Until now a failure there threw,
 * Hono answered 500, and an operator told «نشد» about a change that had been
 * made pressed the button again — which on the create routes is a duplicate.
 * The row was lost either way; the 500 added the duplicate.
 *
 * Two behaviours, decided by the handle the caller passed, and both are asserted
 * here because getting the *test* for the second one wrong is how the first
 * version of `isSession` shipped: it looked for `batch`, which
 * `D1DatabaseSession` also has, so every session would have been read as a bare
 * connection and the rollback swallowed.
 *
 * The failure is injected rather than described — a handle whose `run()`
 * rejects — so this measures the branch rather than the comment above it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { audit, type Ident } from '../src/adminAudit.js';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';

const IDENT: Ident = { email: 'admin@example.com', role: 'ADMIN', requestId: 'req-77' };

const BOOM = new Error('deadlock detected');

/** A handle whose every statement rejects, shaped like whichever one is asked for. */
function failing(kind: 'db' | 'session'): D1Database | D1DatabaseSession {
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => {
      throw BOOM;
    },
  };
  const base = {
    prepare: () => statement,
    batch: async () => [],
  };
  // The one member that tells them apart, and the reason it is this one is in
  // `packages/db/src/types.ts`: both interfaces carry `prepare` and `batch`,
  // only `D1Database` carries `withSession`.
  return kind === 'db'
    ? ({
        ...base,
        exec: async () => ({}),
        dump: async () => new ArrayBuffer(0),
        withSession: async () => undefined,
      } as unknown as D1Database)
    : (base as unknown as D1DatabaseSession);
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a failed audit row', () => {
  it('does not fail the request it belongs to, on a bare connection', async () => {
    const out = captureStdout();
    await expect(
      audit(failing('db'), IDENT, 'catalog.plan_updated', 'PRODUCT_PLAN', '42', null, null, null),
    ).resolves.toBeUndefined();
    out.restore();
  });

  it('says so, with enough to find the change that was made', async () => {
    const out = captureStdout();
    await audit(
      failing('db'),
      IDENT,
      'catalog.plan_updated',
      'PRODUCT_PLAN',
      '42',
      null,
      null,
      null,
    );
    out.restore();

    const line = out.lines.map((l) => l.trim()).find((l) => l.includes('audit.unrecorded'));
    expect(line, 'nothing was written to stdout').toBeDefined();
    const record = JSON.parse(line!) as {
      level: string;
      svc: string;
      trace: string;
      ref: string;
      fields: { action: string; actor: string; entityType: string };
      err: { message: string };
    };

    // `error`, so it reaches `app_events` and the alert path — an `info` here
    // would live in the container's stdout and die with the container, which is
    // the same silence this replaced.
    expect(record.level).toBe('error');
    expect(record.svc).toBe('dashboard');
    // Lifted into their own columns by `emit`, which is what lets «رویدادها»
    // gather this beside the rest of the request and find it by the entity.
    expect(record.trace).toBe('req-77');
    expect(record.ref).toBe('42');
    expect(record.fields.action).toBe('catalog.plan_updated');
    expect(record.fields.actor).toBe('admin@example.com');
    expect(record.err.message).toContain('deadlock');
  });

  it('still throws inside a transaction, so the pair rolls back together', async () => {
    // The case the widened `Db` type exists for: bulk repricing writes its
    // audit row in the same transaction as the prices, and swallowing the error
    // there would commit a repricing whose «before» is gone — the one record of
    // what the prices used to be.
    const out = captureStdout();
    await expect(
      audit(
        failing('session'),
        IDENT,
        'catalog.bulk_repriced',
        'PRODUCT_PLAN',
        'op-1',
        null,
        null,
        null,
      ),
    ).rejects.toThrow('deadlock');
    out.restore();
  });
});
