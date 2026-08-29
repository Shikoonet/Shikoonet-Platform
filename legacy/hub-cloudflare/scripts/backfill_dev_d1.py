#!/usr/bin/env python3
"""
Backfill payment_claims.operation_type + purchase_type on the DEVELOPMENT D1.

- Reads EVERY Hub payment_claim row that has source_system='MIRZABOT'
- Joins to Mirzabot MySQL via id_order (strip mirzabot:test: prefix from external_order_id)
- Extracts operation_type from Payment_report.id_invoice (text before '|')
- Maps to purchase_type using the mapping from the task:
    getconfigafterpay     -> NEW_PURCHASE
    getextenduser         -> RENEWAL
    getextratimeuser      -> RENEWAL
    getextravolumeuser    -> RENEWAL
    anything else / NULL  -> UNKNOWN

Mirzabot MySQL is read-only over SSH.
Dev D1 is the only thing we write to.

This script is ONLY for the one-shot historical backfill. It runs exactly once.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

BACKUP_ROOT = Path("/home/sam/Documents/mydev/smsverfication/.production-backups/dashboard-before-dev-20260810T064246Z")
PAYMENT_HUB_DEV = "payment-hub-dev"
WORKER_DIR = "/home/sam/Documents/mydev/smsverfication/apps/dashboard-worker"

# Mirzabot MySQL READ-ONLY via SSH.  We never write to Mirzabot.
MIRZA_SSH = "mirza"
MIRZA_DB = "mirzaprobot"
MIRZA_USER = "nVoPqjCg"
MIRZA_PASS = "QyfiM9Ax"

# Mapping from task definition
OPERATION_TO_PURCHASE = {
    "getconfigafterpay": "NEW_PURCHASE",
    "getextenduser": "RENEWAL",
    "getextratimeuser": "RENEWAL",
    "getextravolumeuser": "RENEWAL",
}


def ssh_mirza(sql: str) -> str:
    """Run a MySQL query on Mirzabot (read-only) and return tab-separated rows."""
    cmd = [
        "ssh", MIRZA_SSH,
        f"mysql -u {MIRZA_USER} -p{MIRZA_PASS} {MIRZA_DB} -N -e {sql!r}"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        sys.stderr.write(f"ssh mysql failed: {result.stderr}\n")
        sys.exit(1)
    return result.stdout


def wrangler_d1(sql: str, db: str = PAYMENT_HUB_DEV) -> list:
    """Run a SQL query on D1 remote and return result rows."""
    cmd = [
        "npx", "wrangler", "d1", "execute", db, "--remote",
        "--command", sql, "--json"
    ]
    result = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        sys.stderr.write(f"wrangler d1 failed: {result.stderr}\n")
        sys.exit(1)
    data = json.loads(result.stdout)
    return data[0].get("results", [])


def escape_sql_string(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def main():
    print("=" * 70)
    print("DEVELOPMENT BACKFILL — payment_claims.operation_type + purchase_type")
    print("Source: Mirzabot MySQL Payment_report.id_invoice (READ-ONLY via SSH)")
    print("Target: Hub dev D1 (payment-hub-dev)")
    print("=" * 70)

    # 1. Collect all Hub payment_claims with external_order_id starting mirzabot:test:
    print("\n[1/4] Reading Hub payment_claims from dev D1...")
    rows = wrangler_d1(
        "SELECT id, external_order_id FROM payment_claims WHERE source_system = 'MIRZABOT';"
    )
    print(f"  Found {len(rows)} MIRZABOT payment_claims in dev D1.")

    # 2. Collect id_invoice for every order we need from Mirzabot MySQL
    print("\n[2/4] Reading Mirzabot Payment_report.id_invoice (READ-ONLY)...")
    mirza_orders = {}
    # Mirzabot has them all. Single query.
    ts = time.time()
    raw = ssh_mirza(
        "SELECT id_order, id_invoice FROM Payment_report;"
    )
    te = time.time()
    print(f"  Pulled Mirzabot Payment_report in {te - ts:.2f}s")
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        order_id, id_invoice = parts[0], parts[1]
        mirza_orders[order_id] = id_invoice

    # 3. Compute classification for each Hub claim
    print("\n[3/4] Computing classification and writing to dev D1...")
    stats = {
        "total_hub_claims": len(rows),
        "matched_mirzabot": 0,
        "unmatched_mirzabot": 0,
        "new_purchase": 0,
        "renewal": 0,
        "unknown": 0,
        "operation_counts": {},
    }
    batches = []
    UPDATE_SQL = "UPDATE payment_claims SET operation_type = ?1, purchase_type = ?2 WHERE id = ?3;"

    for row in rows:
        claim_id = row["id"]
        ext = row["external_order_id"]
        # Strip mirzabot:test: prefix
        if ext.startswith("mirzabot:test:"):
            order_id = ext[len("mirzabot:test:"):]
        else:
            order_id = ext

        id_invoice = mirza_orders.get(order_id)
        if not id_invoice:
            stats["unmatched_mirzabot"] += 1
            stats["unknown"] += 1
            stats["operation_counts"]["UNMATCHED"] = stats["operation_counts"].get("UNMATCHED", 0) + 1
            continue

        # Extract operation prefix
        if "|" in id_invoice:
            op = id_invoice.split("|", 1)[0].strip()
        else:
            op = id_invoice.strip()

        purchase = OPERATION_TO_PURCHASE.get(op, "UNKNOWN")
        stats["matched_mirzabot"] += 1
        stats["operation_counts"][op] = stats["operation_counts"].get(op, 0) + 1
        if purchase == "NEW_PURCHASE":
            stats["new_purchase"] += 1
        elif purchase == "RENEWAL":
            stats["renewal"] += 1
        else:
            stats["unknown"] += 1

        batches.append((op, purchase, claim_id))

    # 4. Apply updates in one batch via d1 execute --file
    print(f"  Matched {stats['matched_mirzabot']}/{stats['total_hub_claims']}, "
          f"unmatched {stats['unmatched_mirzabot']}")
    print(f"  NEW_PURCHASE: {stats['new_purchase']}, RENEWAL: {stats['renewal']}, UNKNOWN: {stats['unknown']}")

    sql_file = BACKUP_ROOT / "backfill_purchase_type.sql"
    with open(sql_file, "w") as f:
        for op, purchase, claim_id in batches:
            f.write(f"UPDATE payment_claims SET operation_type='{op.replace(chr(39), chr(39)+chr(39))}', "
                    f"purchase_type='{purchase}' WHERE id='{claim_id}';\n")
    print(f"  Wrote backfill SQL: {sql_file}")

    # Apply
    cmd = ["npx", "wrangler", "d1", "execute", PAYMENT_HUB_DEV, "--remote",
           "--file", str(sql_file)]
    result = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        sys.stderr.write(f"backfill apply failed: {result.stderr}\n")
        sys.exit(1)
    print(f"  Applied: {result.stdout.splitlines()[-1] if result.stdout else '(no output)'}")

    # 5. Reconciliation report
    print("\n[4/4] Reconciliation report...")
    report = {
        "TOTAL_HUB_MIRZABOT_CLAIMS": stats["total_hub_claims"],
        "MATCHED_MIRZABOT": stats["matched_mirzabot"],
        "UNMATCHED_MIRZABOT": stats["unmatched_mirzabot"],
        "NEW_PURCHASE": stats["new_purchase"],
        "RENEWAL": stats["renewal"],
        "UNKNOWN": stats["unknown"],
        "OPERATION_DISTRIBUTION": dict(sorted(stats["operation_counts"].items(), key=lambda x: -x[1])),
    }
    report_path = BACKUP_ROOT / "backfill_reconciliation_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    print(f"\nReport saved: {report_path}")
    print("=" * 70)


if __name__ == "__main__":
    main()
