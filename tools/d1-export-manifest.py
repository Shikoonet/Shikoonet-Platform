#!/usr/bin/env python3
"""Write the provenance sidecar for a D1 export.

WHAT THIS PROVES, AND WHAT IT DOES NOT
======================================

It proves **bundle binding**: that one named MySQL dump and one complete
23-table D1 export were sealed together, and that neither has changed since.
A modified file, a file swapped in from another export, a missing file, an
extra file and a substituted dump are all detected, because every artifact is
covered by a digest and the digests are covered by the sidecar's own checksum.

It does **not** prove the two were read from one transactionally consistent
moment, and nothing at this layer could. D1 is a Cloudflare service and
Mirzabot's MySQL is a different machine; there is no cross-database snapshot
to take. Anyone running this may pass any export directory and any dump path.

The earlier version of this file called its output "same snapshot". That was
an overclaim, and the sort that matters: a promotion gate reading it would
believe a stronger fact than anyone had established.

So the contract is BOUNDED CONSISTENCY, stated in the sidecar and enforced by
the consumer:

  * **capture window** — every artifact was written within
    `capture_window_max` seconds of every other. This bounds how far the two
    sources can have drifted apart. It rests on file mtimes, which a
    determined operator can forge; it is a guard against the ordinary mistake
    (yesterday's export beside today's dump), not against a forger who already
    has root on the secure host.

  * **capture order** — the MySQL dump must be no OLDER than the newest D1
    file. Direction matters: with MySQL captured last it is the superset, so a
    claim D1 knows about has its order in the dump. The other way round, D1
    may reference orders the dump has never heard of, and the migration would
    invent them.

  * **cross-source coherence** — every distinct Mirzabot order reference
    carried by D1's `payment_claims` must appear in the dump. This is what
    catches an export paired with an unrelated dump even when both are fresh.
    It is a presence test over the dump text, deliberately: it needs no
    knowledge of Mirzabot's schema and cannot be fooled by a dump that simply
    lacks the rows. Only counts are recorded — never a reference.

The sidecar records verdicts and counts. It never records a customer
identifier, a value, a timestamp of customer activity, or a path.

  d1-export-manifest.py <export-dir> <mirzabot-dump> <tables-manifest>
"""
import hashlib
import json
import math
import os
import re
import signal
import stat
import sys
import tempfile

SCHEMA_VERSION = "2"

# The maximum drift between the oldest and newest artifact in the bundle.
CAPTURE_WINDOW_MAX = 3600

# deploy/d1-tables.manifest, pinned. The table set is generated from the
# migrator's own source by tools/d1-contract.py, and a sidecar written against
# some other list would cover the wrong 23 tables. Pinning the digest here
# means the generator refuses a manifest that is not the reviewed one;
# deploy/test/d1-contract.test.sh fails the build if this pin and the tracked
# file ever drift apart.
TABLES_MANIFEST_SHA256 = "c1e7da80e3033a8c78c4c365c42bbca002a87daebd08ca32ff6bb7a848c55a27"

# Written by the publication path; removed by the signal handlers.
_TMP_PATH = None


def refuse(msg):
    """Refuse by describing the problem, never by quoting the input.

    Messages here reach an operator's terminal and, through them, sometimes a
    ticket. A filename is safe; a row, a reference, a path or a token is not.
    """
    print("[d1-manifest] " + msg, file=sys.stderr)
    _cleanup()  # the only cleanup on the refusal path
    sys.exit(1)


def _cleanup(*_):
    global _TMP_PATH
    if _TMP_PATH and os.path.exists(_TMP_PATH):
        try:
            os.unlink(_TMP_PATH)
        except OSError:
            pass
    _TMP_PATH = None


def _on_signal(signum, _frame):
    # A partial sidecar must never survive, and a previous valid one must be
    # untouched — which it is, because nothing is renamed over it until the
    # complete file has been written and verified.
    _cleanup()
    print("[d1-manifest] interrupted — no sidecar was written", file=sys.stderr)
    sys.exit(128 + signum)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def require_secure(path, label, want_dir=False):
    """A regular file (or directory), not a symlink, not group- or world-writable."""
    if os.path.islink(path):
        refuse(f"{label} is a symlink — refusing")
    if want_dir:
        if not os.path.isdir(path):
            refuse(f"{label} is not a directory")
    elif not os.path.isfile(path):
        refuse(f"{label} is not a regular file")
    st = os.stat(path)
    if not want_dir and not stat.S_ISREG(st.st_mode):
        refuse(f"{label} is not a regular file")
    if st.st_mode & 0o022:
        refuse(f"{label} is group- or world-writable")


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    export_dir, dump_path, tables_manifest = sys.argv[1:4]

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    # ── the inputs, before anything is read ──────────────────────────────
    #
    # Canonicalised first: a path with `..` in it, or one whose parent is a
    # symlink, resolves somewhere the operator did not name, and every check
    # below would then be about a different directory than the one written to.
    export_dir = os.path.realpath(export_dir)
    require_secure(export_dir, "the export directory", want_dir=True)
    require_secure(dump_path, "the MySQL dump")
    require_secure(tables_manifest, "the table manifest")

    if sha256_file(tables_manifest) != TABLES_MANIFEST_SHA256:
        refuse(
            "the table manifest is not the reviewed deploy/d1-tables.manifest "
            "from this repository revision"
        )

    with open(tables_manifest, encoding="utf-8") as fh:
        tables = sorted(
            ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")
        )
    if not tables:
        refuse("the table manifest is empty")

    # ── the artifacts ────────────────────────────────────────────────────
    want = {t + ".json" for t in tables}
    present = {f for f in os.listdir(export_dir) if f.endswith(".json")}
    if want - present:
        refuse("the export is incomplete; missing: " + ",".join(sorted(want - present)))
    if present - want:
        refuse(
            "the export directory holds files that are not part of the contract: "
            + ",".join(sorted(present - want))
        )

    mtimes = []
    lines = []
    for table in tables:
        path = os.path.join(export_dir, table + ".json")
        require_secure(path, table + ".json")
        mtimes.append(os.stat(path).st_mtime)
        lines.append(f"{sha256_file(path)}  {table}.json")

    dump_mtime = os.stat(dump_path).st_mtime
    dump_digest = sha256_file(dump_path)

    # ── bounded consistency ──────────────────────────────────────────────
    # Compared unrounded, recorded rounded UP. `int(round(3600.4))` is 3600,
    # so a bundle that genuinely exceeded the window sealed anyway.
    span = max(mtimes + [dump_mtime]) - min(mtimes + [dump_mtime])
    window = math.ceil(span)
    if span > CAPTURE_WINDOW_MAX:
        refuse(
            f"the artifacts span {window}s, more than the {CAPTURE_WINDOW_MAX}s "
            "capture window — they were not captured together"
        )
    if dump_mtime < max(mtimes):
        refuse(
            "the MySQL dump is older than the newest D1 file. Capture MySQL "
            "last: with D1 newer, it can reference orders the dump does not "
            "contain and the migration would invent them"
        )

    # ── cross-source coherence ───────────────────────────────────────────
    #
    # Every Mirzabot order D1 has a claim for must be present in the dump.
    # Read as text and matched as text: this needs no knowledge of Mirzabot's
    # schema, and a dump from another system simply will not contain them.
    claims = os.path.join(export_dir, "payment_claims.json")
    refs = set()
    if os.path.isfile(claims):
        try:
            data = json.load(open(claims, encoding="utf-8"))
        except Exception:
            refuse("payment_claims.json is not valid JSON")
        rows = data if isinstance(data, list) else (data.get("results") or data.get("rows") or [])
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            if (row.get("source_system") or "").upper() != "MIRZABOT":
                continue
            ext = row.get("external_order_id")
            if isinstance(ext, str) and ext:
                # `mirzabot:test:<id>` is the prefixed form the hub writes.
                refs.add(re.sub(r"^mirzabot:test:", "", ext))

    missing = 0
    if refs:
        # Delimited, not "appears anywhere". A bare substring test lets a short
        # reference such as `7` match the middle of an unrelated number while
        # the order it names is absent from the dump entirely, and the bundle
        # then records coherence=pass. The reference has to stand alone,
        # bounded by something that is not part of an identifier.
        blob = open(dump_path, "rb").read()
        for ref in refs:
            pattern = (
                rb"(?<![A-Za-z0-9_-])"
                + re.escape(ref.encode("utf-8", "ignore"))
                + rb"(?![A-Za-z0-9_-])"
            )
            if not re.search(pattern, blob):
                missing += 1
        del blob

    coherence = "pass" if missing == 0 else "fail"
    if coherence != "pass":
        refuse(
            f"{missing} of {len(refs)} Mirzabot order reference(s) carried by the "
            "D1 export are absent from this dump — the two artifacts are not "
            "views of the same system state"
        )

    # ── the sidecar, written completely before it is published ───────────
    body = [
        f"schema_version={SCHEMA_VERSION}",
        f"table_count={len(tables)}",
        f"mysql_dump_sha256={dump_digest}",
        f"capture_window_seconds={window}",
        f"capture_window_max={CAPTURE_WINDOW_MAX}",
        "capture_order=mysql-not-older-than-d1",
        f"coherence_checked={len(refs)}",
        f"coherence_missing={missing}",
        f"coherence={coherence}",
        *lines,
    ]
    text = "\n".join(body) + "\n"

    # The capture identity: a hash over the sealed content, so a hash of
    # hashes. It names the bundle and is derived from no customer value.
    capture_id = hashlib.sha256(text.encode()).hexdigest()
    text = f"capture_id={capture_id}\n" + text
    export_id = "sha256:" + hashlib.sha256(text.encode()).hexdigest()

    out = os.path.join(export_dir, "d1-export.manifest")
    # `os.rename` replaces a symlink rather than following it, so publication
    # is safe either way — but a sidecar that is a symlink at all means someone
    # has been arranging where this file lands, and that is worth refusing
    # rather than quietly correcting.
    if os.path.islink(out):
        refuse("d1-export.manifest is a symlink — refusing to publish over it")
    global _TMP_PATH
    fd, _TMP_PATH = tempfile.mkstemp(dir=export_dir, prefix=".d1-export.manifest.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        # Verified as a complete file on disk before anything is replaced. A
        # short write, a full filesystem or a truncated buffer is caught here,
        # while the previous sidecar is still the one in place.
        if open(_TMP_PATH, encoding="utf-8").read() != text:
            refuse("the sidecar did not survive its own write — refusing to publish it")
        # Enforced, not requested. `mkstemp` honours the umask and an existing
        # file could carry any mode at all, so the mode is set on the object
        # that is about to become the sidecar.
        os.chmod(_TMP_PATH, 0o640)
        # Same directory, therefore the same filesystem, therefore one atomic
        # rename. A reader sees the whole old sidecar or the whole new one.
        os.rename(_TMP_PATH, out)
        _TMP_PATH = None
    except OSError as err:
        # `refuse` removes the temporary file itself. Calling `_cleanup` here
        # as well meant either call could be deleted without any test noticing.
        refuse(f"the sidecar could not be published ({err.strerror}) — the previous one is untouched")

    # Nothing fallible follows the rename, other than reporting.
    print(export_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
