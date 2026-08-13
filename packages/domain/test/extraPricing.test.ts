/**
 * What an extra gigabyte and an extra day cost.
 *
 * The numbers are the admin's, set per panel and per tier years ago, and they
 * arrive in `provisioning_providers.config` exactly as the legacy row had them.
 * The fixtures below are the real production values — `marzban_panel` rows on
 * 2026-08-11 — so this test is measured against the outside and not against our
 * own idea of the shape.
 */

import { describe, expect, it } from 'vitest';
import { extraPricingFor } from '../src/index.js';

/** The VIP panel, verbatim. Toman, as text, keyed by tier. */
const VIP = {
  status_extend: 'on_extend',
  priceextravolume: '{"f":"50000","n":"5000","n2":"5000"}',
  priceextratime: '{"f":"15000","n":"4000","n2":"4000"}',
};

describe('what an add-on costs', () => {
  it('reads the live VIP panel, in IRR', () => {
    expect(extraPricingFor(VIP, 'f')).toEqual({
      volumeIrrPerGb: 500_000,
      timeIrrPerDay: 150_000,
    });
    // A reseller pays a tenth for volume on this panel. Reading the wrong tier
    // would overcharge them by 45,000 toman a gigabyte.
    expect(extraPricingFor(VIP, 'n')).toEqual({
      volumeIrrPerGb: 50_000,
      timeIrrPerDay: 40_000,
    });
  });

  it('sells nothing on the panel the admin closed', () => {
    // One of the five production panels is off_extend, and it has prices set.
    expect(extraPricingFor({ ...VIP, status_extend: 'off_extend' }, 'f')).toEqual({
      volumeIrrPerGb: null,
      timeIrrPerDay: null,
    });
  });

  it('refuses a price it cannot read rather than guessing one', () => {
    expect(extraPricingFor({}, 'f').volumeIrrPerGb).toBeNull();
    expect(extraPricingFor({ priceextravolume: 'not json' }, 'f').volumeIrrPerGb).toBeNull();
    expect(extraPricingFor({ priceextravolume: '{"n":"5000"}' }, 'f').volumeIrrPerGb).toBeNull();
    // Zero is not a price: the customer types the quantity, so zero times any
    // number of gigabytes is a service given away.
    expect(extraPricingFor({ priceextravolume: '{"f":"0"}' }, 'f').volumeIrrPerGb).toBeNull();
    expect(extraPricingFor({ priceextravolume: '{"f":"-100"}' }, 'f').volumeIrrPerGb).toBeNull();
  });

  it('takes the object shape too, because jsonb hands one back', () => {
    expect(extraPricingFor({ priceextravolume: { f: 50_000 } }, 'f').volumeIrrPerGb).toBe(500_000);
  });
});
