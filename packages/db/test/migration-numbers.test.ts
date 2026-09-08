/**
 * One number, one migration — from here on.
 *
 * `migrations/` currently holds three pairs of files that share a number
 * (`0056`, `0057`, `0060`). Each pair is two PRs that both took the next free
 * number before the other merged, and the restore drill on the production host
 * is where they were finally noticed (issue #147).
 *
 * ## Why the three are allowed and a fourth is not
 *
 * Nothing is broken today, and that is precisely why this is a test and not a
 * rename. Apply order is the full-filename sort, `schema_migrations` stores the
 * full name, and `restore-drill.sh` compares full names with checksums — so
 * every layer already agrees. Renaming a file that has been applied would make
 * every existing database read as DRIFTED, which is a real outage in exchange
 * for a tidier listing.
 *
 * But every one of those facts is implicit. The number reads as an order and is
 * not one; two people saying «migration 0057» are talking about different
 * files; and anything that ever parses the numeric prefix — a squash script, an
 * `up-to 0057` runner, a dashboard — picks one of the pair in silence. So the
 * three that shipped are written down here by name, and the fourth fails.
 *
 * ## Why it reads the directory through `readMigrations`
 *
 * That function is what the loader uses to decide which files exist
 * (`/^0\d.*\.sql$/`, sorted). A second copy of the glob here would agree with
 * itself and drift from what actually ships — which is rule 6 in `CLAUDE.md`,
 * and the reason `verify_invariants.sql` needs no exception below: the loader
 * never sees it.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readMigrations } from '../src/schema.js';

const DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

/**
 * The collisions that already shipped, by number and by file.
 *
 * Written out in full rather than as a list of numbers: a bare `['0056']` would
 * keep passing if somebody added a THIRD `0056`, which is the same defect one
 * step further along.
 */
const SHIPPED_COLLISIONS: Record<string, string[]> = {
  '0056': ['0056_a_rate_limit_is_not_a_lost_customer.sql', '0056_checkout_paid_action.sql'],
  '0057': ['0057_shelf_of_accounts.sql', '0057_the_sweeps_get_switches.sql'],
  '0060': ['0060_a_badge_measured_as_drawn.sql', '0060_the_reseller_meter.sql'],
};

/** Every file the loader would take, grouped by the four digits it starts with. */
function byNumber(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { name } of readMigrations(DIR)) {
    const number = name.slice(0, 4);
    groups.set(number, [...(groups.get(number) ?? []), name]);
  }
  return groups;
}

describe('migration numbers', () => {
  it('gives no new number to two files', () => {
    const offenders: string[] = [];
    for (const [number, files] of byNumber()) {
      if (files.length < 2) continue;
      const allowed = SHIPPED_COLLISIONS[number];
      // Same number AND the same two files as the day this was written. A pair
      // that grew a third member, or whose members changed, is new.
      if (allowed && allowed.length === files.length && allowed.every((f) => files.includes(f))) {
        continue;
      }
      offenders.push(`${number}: ${files.join(', ')}`);
    }

    // Named rather than counted, because the fix is «rename YOUR file to the
    // next free number» and that needs the names.
    expect(offenders).toEqual([]);
  });

  it('still has the three that shipped, so the exception list cannot rot', () => {
    // If somebody does renumber one of them one day, this fails and sends them
    // to the paragraph above rather than leaving a stale allowance behind that
    // would quietly permit a fresh collision on the same number.
    const groups = byNumber();
    for (const [number, files] of Object.entries(SHIPPED_COLLISIONS)) {
      expect(groups.get(number)?.slice().sort()).toEqual(files.slice().sort());
    }
  });
});
