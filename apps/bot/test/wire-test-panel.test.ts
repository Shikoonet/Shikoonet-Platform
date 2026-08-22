/**
 * The one guard in `scripts/wire-test-panel.ts`, tested against the hosts it
 * actually meets.
 *
 * The script repoints a product at a panel, so the question it answers — "is
 * this database allowed to be rewired?" — decides where a customer's order is
 * delivered. Until 2026-08-19 the answer was "only localhost", which was right
 * while the simulation was the only test environment and wrong the moment the
 * Coolify staging box arrived, where the database is reachable only as a Docker
 * service name.
 *
 * The escape hatch has to name the host. `=yes` would be typed once and then
 * live in a shell profile; `=zpuyfk3p3nqfpebybbxz6opy` cannot be carried to a
 * different database by accident, which is the whole failure being guarded.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CARD_DIGITS, assertLocal } from '../scripts/wire-test-panel.js';

const OVERRIDE = 'WIRE_TEST_PANEL_ON_HOST';
const url = (host: string): string => `postgres://u:p@${host}:5432/shikoo`;

afterEach(() => {
  delete process.env[OVERRIDE];
});

describe('assertLocal', () => {
  it('allows the simulation', () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      expect(() => assertLocal(url(host))).not.toThrow();
    }
  });

  it('refuses a database it was not pointed at on purpose', () => {
    expect(() => assertLocal(url('zpuyfk3p3nqfpebybbxz6opy'))).toThrow(/refusing/);
  });

  it('names the host in the refusal, so the operator can act on it', () => {
    expect(() => assertLocal(url('db.example.com'))).toThrow(`${OVERRIDE}=db.example.com`);
  });

  it('allows the exact host the operator named', () => {
    process.env[OVERRIDE] = 'zpuyfk3p3nqfpebybbxz6opy';
    expect(() => assertLocal(url('zpuyfk3p3nqfpebybbxz6opy'))).not.toThrow();
  });

  it('still refuses a DIFFERENT host while an override is set', () => {
    // The failure the override exists to survive: it is carried into a shell
    // that then points at production. Naming the host is what makes that safe.
    process.env[OVERRIDE] = 'zpuyfk3p3nqfpebybbxz6opy';
    expect(() => assertLocal(url('prod-db.internal'))).toThrow(/refusing/);
  });

  it('is not satisfied by a truthy value', () => {
    for (const value of ['yes', 'true', '1']) {
      process.env[OVERRIDE] = value;
      expect(() => assertLocal(url('zpuyfk3p3nqfpebybbxz6opy'))).toThrow(/refusing/);
    }
  });
});

/**
 * The card the script hands out, checked against the algorithm every bank and
 * every validator uses — not against a comment in the file that claims it is
 * valid. A test card that fails Luhn is rejected somewhere downstream and the
 * failure surfaces as "the purchase does not work", days later.
 */
describe('CARD_DIGITS', () => {
  const luhnTotal = (digits: string): number =>
    [...digits]
      .reverse()
      .map((c, i) => {
        const n = Number(c) * (i % 2 === 1 ? 2 : 1);
        return n > 9 ? n - 9 : n;
      })
      .reduce((a, b) => a + b, 0);

  it('is sixteen digits and passes Luhn', () => {
    expect(CARD_DIGITS).toMatch(/^\d{16}$/);
    expect(luhnTotal(CARD_DIGITS) % 10).toBe(0);
  });

  it('proves the check is a check — one digit changed and it fails', () => {
    const broken = `${CARD_DIGITS.slice(0, 15)}5`;
    expect(luhnTotal(broken) % 10).not.toBe(0);
  });
});
