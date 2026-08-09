#!/usr/bin/env python3
"""Print the frozen-window content digests for lib/season_pins.CONTENT_DIGESTS.

    python3 scripts/data/nfl-db/content_digest.py [path/to/nfl.db]

Row counts cannot see a value change. These digests pin the CONTENT of the
frozen window -- every column except the ones CONTENT_DIGEST_EXCLUDE documents as
legitimately upstream-revised (crosswalk tier labels, nflverse-computed EPA and
usage shares).

Output is the full SHA-256 over the season_pins.DIGEST_ALGORITHM serialization,
which binds the algorithm tag, table, window predicate, ordered column NAMES and
row count into the hash. A 20-char digest is a pre-Phase-4 value and will be
rejected by content_verdict() as an algorithm mismatch, not a content one.

Regenerate ONLY when you have established that a content change is correct, the
same way you would re-pin a row count: find out what moved first.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import sqlite3  # noqa: E402
import season_pins as sp  # noqa: E402

# The frozen populations come from season_pins.FROZEN_WINDOWS. This file used to
# carry its own copy of every predicate and column list, so the regenerator could
# silently protect a different population than the gate it feeds. Same authority,
# same rows, or the digest means nothing.
WINDOWS = {t: sp.window(t).predicate for t in sp.governed_tables()}


def main() -> int:
    db = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "nfl.db")
    if not os.path.exists(db):
        print(f"no database at {db}")
        return 1
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    print(f"# from {db}")
    print("CONTENT_DIGESTS = {")
    bad = 0
    for table, where in WINDOWS.items():
        try:
            d, n, keep = sp.content_digest(conn, table, where)
        except sqlite3.OperationalError as exc:
            print(f"    # {table}: SKIPPED -- {exc}")
            bad += 1
            continue
        excl = sorted(sp.CONTENT_DIGEST_EXCLUDE.get(table, set()))
        # Full SHA-256 no longer fits beside its comment; emit the same shape
        # season_pins.py uses so the output is paste-ready rather than reflowed
        # by hand (a hand-reflowed digest is a digest someone can mistype).
        print(f'    # {n:,} rows, {len(keep)} pinned cols, excludes {excl}')
        print(f'    "{table}":\n        "{d}",')
        ok, detail = sp.content_verdict(table, d)
        if ok is False:
            print(f"    #   MISMATCH vs the pinned value: {detail}")
            bad += 1
    print("}")
    conn.close()
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
