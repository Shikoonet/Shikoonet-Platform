#!/usr/bin/env python3
"""
Seed the development D1 (payment-hub-dev) from the production backup.

Reads production JSON exports from .production-backups/dashboard-before-dev-20260810T064246Z/d1-export/
and INSERTs them into the dev D1 in the correct foreign-key order.

NEVER touches production D1. NEVER touches production Mirzabot.
"""

import json
import subprocess
import sys
from pathlib import Path

BACKUP_ROOT = Path("/home/sam/Documents/mydev/smsverfication/.production-backups/dashboard-before-dev-20260810T064246Z")
EXPORT_DIR = BACKUP_ROOT / "d1-export"
PAYMENT_HUB_DEV = "payment-hub-dev"
WORKER_DIR = "/home/sam/Documents/mydev/smsverfication/apps/dashboard-worker"

# Tables in FK-safe seed order (no inbound FKs first, then dependents).
# Adapted from the sqlite_schema dump.
SEED_ORDER = [
    # no FKs / self-contained
    "access_users",
    "devices",
    "device_credentials",
    "financial_accounts",
    "financial_account_identifiers",
    "raw_sms_events",
    "transaction_candidates",
    "transaction_detected_identifiers",
    "transaction_account_assignments",
    "transaction_reviews",
    "payment_cards",
    "payment_claims",
    "reconciliation_matches",
    "comments",
    "audit_logs",
    "integration_tokens",
    "integration_events",
    "webhook_deliveries",
    "dashboard_notification_state",
    "dashboard_transaction_reads",
    "dashboard_payment_event_reads",
    "account_assignment_previews",
    "account_assignment_preview_items",
    "resellers",
    "reseller_transactions",
    "income_declined_transactions",
]


def load_export(table: str) -> list:
    p = EXPORT_DIR / f"{table}.json"
    if not p.exists():
        return []
    data = json.loads(p.read_text())
    return data[0].get("results", [])


def escape_sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


CHUNK_SIZE = 50  # rows per INSERT statement, to stay under SQLITE_TOOBIG


def build_insert(table: str, rows: list) -> str:
    if not rows:
        return ""
    cols = list(rows[0].keys())
    if not cols:
        return ""
    statements = []
    for i in range(0, len(rows), CHUNK_SIZE):
        chunk = rows[i:i + CHUNK_SIZE]
        col_list = ", ".join(cols)
        value_rows = []
        for r in chunk:
            vs = [escape_sql_value(r.get(c)) for c in cols]
            value_rows.append("(" + ", ".join(vs) + ")")
        stmt = f"INSERT OR REPLACE INTO {table} ({col_list}) VALUES\n"
        stmt += ",\n".join(value_rows) + ";"
        statements.append(stmt)
    return "\n".join(statements)


def main():
    print("=" * 70)
    print("DEVELOPMENT D1 SEED from production backup")
    print("=" * 70)

    # Concatenate all inserts into one SQL file
    seed_sql = BACKUP_ROOT / "seed_dev_d1.sql"
    total_rows = 0
    with open(seed_sql, "w") as f:
        f.write("PRAGMA foreign_keys = OFF;\n")
        for table in SEED_ORDER:
            rows = load_export(table)
            if not rows:
                print(f"  {table:40s} 0 rows (skip)")
                continue
            insert = build_insert(table, rows)
            if insert:
                f.write(insert + "\n")
                total_rows += len(rows)
                print(f"  {table:40s} {len(rows):5d} rows")
        f.write("PRAGMA foreign_keys = ON;\n")
    print(f"\nTotal rows to insert: {total_rows}")
    print(f"SQL file: {seed_sql}")

    # Apply to dev D1 (we already have persistence; this will be a fresh seed)
    print("\nApplying seed to dev D1...")
    cmd = ["npx", "wrangler", "d1", "execute", PAYMENT_HUB_DEV, "--remote",
           "--file", str(seed_sql)]
    result = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        sys.stderr.write(f"seed failed: {result.stderr}\n")
        sys.exit(1)
    lines = result.stdout.strip().splitlines()
    print(f"Apply complete. Last line: {lines[-1] if lines else '(empty)'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
