#!/usr/bin/env python3
"""Every D1 table the migrator reads, derived from its own source.

The rehearsal has to validate a production D1 export before it trusts it, and
"validate" means "the complete set is present". An abbreviated list looks like a
check and is not one: the first version named four tables out of twenty-three,
so a missing nineteen would have passed.

This is the single derivation. `deploy/d1-tables.manifest` is generated from it
and committed, and a test regenerates and compares so that adding a table to the
migrator without updating the manifest fails CI rather than silently widening
what the rehearsal accepts.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
tables: set[str] = set()

# `const D1_TABLES: [table, columns, conflict?][]` — the copy-across list.
src = (root / 'packages/migrate/src/migrate.ts').read_text(encoding='utf-8')
start = src.index('const D1_TABLES')
block = src[start:src.index('\n];', start)]
# Only the FIRST string of each entry is a table; the rest are column names.
#
# Bracket depth rather than a line pattern, because entries are written two
# ways — `['access_users', [...]]` on one line, and `[\n  'devices',\n  [` split
# across several. A line-anchored regex picked up the column array's own
# opening line and reported `id` as a table.
depth = 0
pending_entry = False
for tok in re.finditer(r"\[|\]|'([a-z0-9_]+)'", block):
    t = tok.group(0)
    if t == '[':
        depth += 1
        # Depth 2, not 1: depth 1 is the D1_TABLES array itself, and each
        # entry opens at 2. Getting this off by one silently dropped every
        # table migrate.ts contributes and left only preflight's list.
        if depth == 2:
            pending_entry = True
    elif t == ']':
        depth -= 1
    elif depth == 2 and pending_entry:
        tables.add(tok.group(1))
        pending_entry = False

# Explicit `copyD1` calls outside the D1_TABLES loop. `migrateHub` reads
# dashboard_notification_state, dashboard_transaction_reads and
# dashboard_payment_event_reads through their own calls, and the bracket-depth
# walk above cannot see them because they are arguments, not array entries.
# Omitting them made the contract 23 tables where the migrator reads 26 — so a
# COMPLETE export would have been refused as holding unexpected files, and a
# rehearsal that matched the contract would have been missing three tables of
# data. That is the same failure the first version of this file had, in the
# opposite direction.
for call in re.finditer(r"copyD1\(\s*ctx,\s*'([a-z0-9_]+)'", src):
    tables.add(call.group(1))

# preflight counts a further set that migrate.ts does not copy directly.
pre = (root / 'packages/migrate/src/preflight.ts').read_text(encoding='utf-8')
pstart = pre.index('d1Counts.set(table')
pblock = pre[max(0, pstart - 2000):pstart]
loop = pblock[pblock.rindex('for (const table of ['):]
for name in re.findall(r"'([a-z0-9_]+)'", loop):
    tables.add(name)

# `payment_cards` is read directly rather than through either list.
if "d1Table<{ card_digits" in pre:
    tables.add('payment_cards')

if not tables:
    print('derived no D1 tables — the extractor no longer matches the source', file=sys.stderr)
    sys.exit(1)
print('\n'.join(sorted(tables)))
