#!/usr/bin/env python3
"""Write the provenance sidecar for a D1 export.

The rehearsal cannot tell a real export from an invented one by looking at the
rows. The previous attempt tried: it scanned the first five rows of each table
for words like `example.com`, `synthetic` and `placeholder` and accepted the
export when it found none. That is not provenance, it is a spell-check. It
passes any fabricated dataset whose author avoided six English words, and it
fails a genuine export from a customer whose domain happens to be example.com.

Provenance has to be produced by the process that has the authority to make the
claim — the export itself — and then verified, rather than guessed at afterwards
by the consumer. This writes that claim:

  * one sha256 per table file, so a modified file, a file swapped in from
    another export, a missing file and an extra file are all detectable;
  * the complete table set bound as ONE object, so the export is accepted or
    refused whole and cannot be assembled from parts of two runs;
  * the sha256 of the MySQL dump taken from the same snapshot, which is what
    makes "these two came from the same moment" a checkable statement instead
    of an assumption.

Run this on the secure host, in the same operation that produces the export.

  d1-export-manifest.py <export-dir> <mirzabot-dump> <manifest-of-expected-tables>
"""
import hashlib
import os
import sys


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    export_dir, dump_path, tables_manifest = sys.argv[1:4]

    with open(tables_manifest, encoding="utf-8") as fh:
        tables = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    if not tables:
        print("[d1-manifest] the table manifest is empty", file=sys.stderr)
        return 1

    lines = []
    for table in sorted(tables):
        path = os.path.join(export_dir, table + ".json")
        if not os.path.isfile(path) or os.path.islink(path):
            print(f"[d1-manifest] {table}.json is missing or not a regular file", file=sys.stderr)
            return 1
        lines.append(f"{sha256_file(path)}  {table}.json")

    body = [
        "schema_version=1",
        f"table_count={len(tables)}",
        f"mysql_dump_sha256={sha256_file(dump_path)}",
        *lines,
    ]
    text = "\n".join(body) + "\n"

    out = os.path.join(export_dir, "d1-export.manifest")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)

    # The export's identity: a hash of hashes. It names the export as a whole
    # and is derived from no customer value directly, which is what makes it
    # safe to record in the attestation.
    print("sha256:" + hashlib.sha256(text.encode()).hexdigest())
    return 0


if __name__ == "__main__":
    sys.exit(main())
