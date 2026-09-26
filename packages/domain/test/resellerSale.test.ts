/**
 * The reseller price table, and the two guards around a panel admin.
 *
 * The prices below are written out by hand from Sam's own example (2026-09-26,
 * #474): from 1 TB at 3,000,000 Toman each, from 3 TB at 2,000,000 each, the
 * whole order at the rate of the tier it falls into. They are not derived from
 * `resellerPrice` — a table computed by the function under test would agree
 * with any bug in it (CLAUDE.md rule 6).
 */

import { describe, expect, it } from 'vitest';
import {
  generatePanelPassword,
  isSafeResellerRole,
  maxOrderTb,
  RESELLER_MAX_TB,
  RESELLER_USERNAME,
  resellerNote,
  resellerPrice,
  resellerSaleFor,
  TIB,
} from '../src/resellerSale.js';

const SAM = [
  { fromTb: 1, pricePerTbIrr: 30_000_000 },
  { fromTb: 3, pricePerTbIrr: 20_000_000 },
];

describe('resellerPrice — the whole order at its tier', () => {
  it.each([
    [1, 30_000_000, 30_000_000],
    [2, 30_000_000, 60_000_000],
    [3, 20_000_000, 60_000_000],
    [4, 20_000_000, 80_000_000],
    [5, 20_000_000, 100_000_000],
    [6, 20_000_000, 120_000_000],
  ])('%i TB costs %i IRR each, %i in all', (tb, unit, total) => {
    expect(resellerPrice(SAM, tb)).toEqual({ unitIrr: unit, totalIrr: total });
  });

  it('has no price below the first tier', () => {
    const fromTwo = [{ fromTb: 2, pricePerTbIrr: 30_000_000 }];
    expect(resellerPrice(fromTwo, 1)).toBeNull();
    expect(resellerPrice(fromTwo, 2)).toEqual({ unitIrr: 30_000_000, totalIrr: 60_000_000 });
  });

  it.each([0, -1, 1.5, Number.NaN, 1001])('refuses %s terabytes', (tb) => {
    expect(resellerPrice(SAM, tb)).toBeNull();
  });
});

describe('maxOrderTb — the largest order one transfer can pay', () => {
  it('is 5 TB under the shop card ceiling of 10,000,000 Toman', () => {
    // 5 × 2M = 10M fits exactly; 6 × 2M = 12M does not.
    expect(maxOrderTb(SAM, 100_000_000)).toBe(5);
  });

  it('is not fooled by the price going DOWN at a tier boundary', () => {
    // Cap 7M: 2 TB = 6M fits, 3 TB = 6M fits too — the walk must reach it
    // rather than stop at the first size that fails.
    expect(maxOrderTb(SAM, 70_000_000)).toBe(3);
  });

  it('is null when not even the smallest order fits', () => {
    expect(maxOrderTb(SAM, 29_999_999)).toBeNull();
  });
});

describe('resellerSaleFor — what a panel config offers', () => {
  const good = {
    reseller_sale: {
      tiers: [
        { from_tb: 1, price_per_tb_irr: 30_000_000 },
        { from_tb: 3, price_per_tb_irr: 20_000_000 },
      ],
      role_id: 4,
      term_days: 90,
      max_order_irr: 100_000_000,
    },
  };

  it('reads a well-formed table', () => {
    expect(resellerSaleFor(good)).toEqual({
      tiers: SAM,
      roleId: 4,
      termDays: 90,
      maxOrderIrr: 100_000_000,
    });
  });

  it('is null when nothing is configured', () => {
    expect(resellerSaleFor({})).toBeNull();
    expect(resellerSaleFor({ reseller_sale: null })).toBeNull();
    expect(resellerSaleFor({ reseller_sale: { tiers: [] } })).toBeNull();
  });

  it('is null — not free — for a malformed tier', () => {
    for (const tiers of [
      [{ from_tb: 1, price_per_tb_irr: 0 }],
      [{ from_tb: 0, price_per_tb_irr: 1 }],
      [{ from_tb: '1', price_per_tb_irr: 1 }],
      [{ from_tb: 1, price_per_tb_irr: 1.5 }],
      // Out of order, and a repeat: either would make the tier ambiguous.
      [
        { from_tb: 3, price_per_tb_irr: 2 },
        { from_tb: 1, price_per_tb_irr: 3 },
      ],
      [
        { from_tb: 1, price_per_tb_irr: 3 },
        { from_tb: 1, price_per_tb_irr: 2 },
      ],
    ]) {
      expect(resellerSaleFor({ reseller_sale: { tiers } })).toBeNull();
    }
  });

  it('never offers the owner role', () => {
    const owner = { reseller_sale: { ...good.reseller_sale, role_id: 1 } };
    expect(resellerSaleFor(owner)?.roleId).toBeNull();
  });
});

describe('isSafeResellerRole — who the bot may write to', () => {
  const own = { scope: 1 };

  it('accepts a role that manages its own users and only reads the rest', () => {
    expect(
      isSafeResellerRole({
        isOwner: false,
        permissions: {
          users: { create: own, read: own, update: own, delete: own, reset_usage: own },
          groups: { read: true, read_simple: true },
          hosts: { read: true },
          admins: null,
        },
      }),
    ).toBe(true);
  });

  it('refuses the owner', () => {
    expect(isSafeResellerRole({ isOwner: true, permissions: {} })).toBe(false);
  });

  it('refuses a role that can edit admins — it could raise its own limit', () => {
    expect(isSafeResellerRole({ isOwner: false, permissions: { admins: { update: true } } })).toBe(
      false,
    );
    expect(
      isSafeResellerRole({ isOwner: false, permissions: { admins: { reset_usage: true } } }),
    ).toBe(false);
  });

  it('refuses users of every admin, and moving a user between owners', () => {
    expect(
      isSafeResellerRole({ isOwner: false, permissions: { users: { read: { scope: 2 } } } }),
    ).toBe(false);
    // `true` is «allowed with no scope», which is every user on the panel.
    expect(isSafeResellerRole({ isOwner: false, permissions: { users: { read: true } } })).toBe(
      false,
    );
    expect(isSafeResellerRole({ isOwner: false, permissions: { users: { set_owner: own } } })).toBe(
      false,
    );
  });

  it('refuses writes outside users, and shapes it does not know', () => {
    expect(isSafeResellerRole({ isOwner: false, permissions: { nodes: { update: true } } })).toBe(
      false,
    );
    expect(
      isSafeResellerRole({ isOwner: false, permissions: { settings: { update: true } } }),
    ).toBe(false);
    expect(isSafeResellerRole({ isOwner: false, permissions: { users: 'all' } })).toBe(false);
    expect(isSafeResellerRole(null)).toBe(false);
  });
});

describe('the small rules', () => {
  it('a tebibyte is 1024 panel gigabytes', () => {
    expect(TIB).toBe(1_099_511_627_776);
    expect(Number.isSafeInteger(RESELLER_MAX_TB * TIB)).toBe(true);
  });

  it('usernames: the panel column holds 34', () => {
    expect(RESELLER_USERNAME.test('ali.reseller-1_x')).toBe(true);
    expect(RESELLER_USERNAME.test('ab')).toBe(false);
    expect(RESELLER_USERNAME.test('x'.repeat(34))).toBe(true);
    expect(RESELLER_USERNAME.test('x'.repeat(35))).toBe(false);
    expect(RESELLER_USERNAME.test('علی')).toBe(false);
    expect(RESELLER_USERNAME.test('a b')).toBe(false);
  });

  it('the note names the reseller exactly', () => {
    expect(resellerNote(12)).toBe('shikoo:reseller:12');
  });
});

describe('generatePanelPassword — what PasarGuard 5.2.1 accepts', () => {
  // The panel's own rules (app/models/validators.py, PasswordValidator),
  // restated rather than imported: this is the external truth.
  function panelAccepts(p: string): boolean {
    return (
      p.length >= 12 &&
      new TextEncoder().encode(p).length <= 72 &&
      (p.match(/\d/g) ?? []).length >= 2 &&
      (p.match(/[A-Z]/g) ?? []).length >= 2 &&
      (p.match(/[a-z]/g) ?? []).length >= 2 &&
      /[!@#$%^&*()\-_=+[\]{}|;:,.<>?/~`]/.test(p) &&
      !p.includes('"')
    );
  }

  it('is accepted by the panel, a thousand times over', () => {
    for (let i = 0; i < 1000; i++) {
      const p = generatePanelPassword();
      expect(panelAccepts(p), p).toBe(true);
      // Safe inside the HTML the bot sends it in.
      expect(/[<>&"`]/.test(p), p).toBe(false);
    }
  });

  it('still meets every class when the draw is as unlucky as it can be', () => {
    // Always index 0: every free character is the same letter.
    const p = generatePanelPassword(() => 0);
    expect(panelAccepts(p), p).toBe(true);
  });
});
