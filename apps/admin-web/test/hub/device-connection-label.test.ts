/**
 * «وضعیت» and «اتصال» are two different questions, and must not answer with the
 * same word.
 *
 * On 2026-08-24 the devices screen showed a row reading «وضعیت: فعال» beside
 * «اتصال: غیرفعال». It looked like the panel contradicting itself. It was not:
 * «وضعیت» is `d.active`, an administrative switch an operator flipped, and
 * «اتصال» is derived from timestamps — so "enabled, but we have not heard from
 * it" is a perfectly coherent state, and in fact the most important one on the
 * screen. A phone that should be relaying bank SMS and is silent means payments
 * stop verifying themselves, with nobody told.
 *
 * The data was right the whole time. Both columns simply said «غیرفعال», one
 * meaning "switched off" and the other meaning "silent", and the reader had no
 * way to know that. An operator who reads it as a contradiction concludes the
 * panel is broken and stops looking — which is the one outcome this row exists
 * to prevent.
 *
 * So the rule is structural, not cosmetic: no value «اتصال» can produce may be
 * a word «وضعیت» uses. Asserted over every branch rather than over the one that
 * collided, because the next collision will be somebody adding a state, not
 * somebody editing this one.
 */

import { describe, expect, it } from 'vitest';
import { connectionStateLabel } from '../../src/hub/DevicesView.js';
import type { DeviceListItem } from '../../src/hub/api.js';

/** Exactly what the «وضعیت» column renders — `d.active ? 'فعال' : 'غیرفعال'`. */
const STATUS_WORDS = ['فعال', 'غیرفعال'];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function device(over: Partial<DeviceListItem>): DeviceListItem {
  return {
    id: 'd1',
    device_code: 'phone-a',
    display_name: 'Phone A',
    // 0/1, not a boolean: `devices.active` is a smallint, ported from the
    // hub's original schema and read as `!d.active` throughout.
    active: 1,
    credential: { token_prefix: 'abcd', status: 'ACTIVE' },
    last_seen_at: null,
    last_success_at: null,
    last_auth_failure_at: null,
    created_at: 0,
    ...over,
  } as DeviceListItem;
}

/** One device per branch of `connectionStateLabel`, named by what it is. */
const NOW = Date.now();
const CASES: Array<[string, DeviceListItem]> = [
  ['switched off', device({ active: 0 })],
  ['no token yet', device({ credential: null })],
  ['authentication refused', device({ last_auth_failure_at: NOW, last_success_at: NOW - DAY })],
  ['never connected', device({ last_seen_at: null })],
  ['seen seconds ago', device({ last_seen_at: NOW - 5_000 })],
  ['seen minutes ago', device({ last_seen_at: NOW - 3 * MINUTE })],
  [
    'succeeded earlier today',
    device({ last_seen_at: NOW - 2 * 60 * MINUTE, last_success_at: NOW - 2 * 60 * MINUTE }),
  ],
  [
    'silent for over a day',
    device({ last_seen_at: NOW - 3 * DAY, last_success_at: NOW - 3 * DAY }),
  ],
];

describe('the «اتصال» column', () => {
  it.each(CASES)('never borrows a «وضعیت» word — %s', (_name, d) => {
    expect(STATUS_WORDS).not.toContain(connectionStateLabel(d).label);
  });

  it('says something different for "switched off" and for "silent"', () => {
    // The two that used to be one string. They are genuinely different
    // situations — one an operator caused on purpose, the other nobody chose —
    // and telling them apart is the whole point of the column.
    const off = connectionStateLabel(device({ active: 0 })).label;
    const silent = connectionStateLabel(
      device({ last_seen_at: NOW - 3 * DAY, last_success_at: NOW - 3 * DAY }),
    ).label;
    expect(off).not.toBe(silent);
  });

  it('does not paint an unheard-from phone the same colour as a refused one', () => {
    // `bad` is reserved for a device that answered and was turned away. A phone
    // that may simply be switched off on a shelf is `warn`. A screen that paints
    // both alike teaches the operator to ignore the colour.
    const refused = connectionStateLabel(
      device({ last_auth_failure_at: NOW, last_success_at: NOW - DAY }),
    );
    const silent = connectionStateLabel(
      device({ last_seen_at: NOW - 3 * DAY, last_success_at: NOW - 3 * DAY }),
    );
    expect(refused.tone).toBe('bad');
    expect(silent.tone).toBe('warn');
  });
});
