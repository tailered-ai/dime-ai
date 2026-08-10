#!/usr/bin/env python3
"""Observe the non-blocking fields against the accepted baseline (Phase 6).

    python3 scripts/data/nfl-db/observe_nonblocking.py [path/to/nfl.db]
    python3 scripts/data/nfl-db/observe_nonblocking.py --update [path/to/nfl.db]

This is AUDIT-ONLY. build_db.py does not call it and does not need the baseline
to build a database; the blocking content digest remains the build's gate. What
this adds is the other half of Phase 5's conclusion: those fields are allowed to
move, but not allowed to move invisibly.

Exit status mirrors the observation status:

    0  PASS             nothing moved
    0  OBSERVED_NOISE   only within-tolerance regeneration / benign relabels
    3  REVIEW_REQUIRED  material movement -- a human must classify it
    4  FAIL             a blocking invariant broke (identity regression,
                        unknown provenance tier)

--update regenerates the baseline. It refuses to run when blocking integrity
fails or the field registry is incomplete, because accepting an observational
delta on top of a corrupt database would launder the corruption into the
accepted state. There is deliberately no --accept-all.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import observational_integrity as oi  # noqa: E402
import season_pins as sp  # noqa: E402

DB_PATH = os.path.join(HERE, "nfl.db")
BASELINE_DIR = os.path.join(HERE, "observational-baseline")


def baseline_path(table):
    return os.path.join(BASELINE_DIR, f"{table}.txt.gz")


def blocking_integrity(conn):
    """(ok, lines). The prerequisite for accepting any observational delta."""
    ok, lines = True, []
    for t in sp.governed_tables():
        try:
            dg, n, _ = sp.content_digest(conn, t, sp.window(t).predicate)
        except sqlite3.OperationalError as exc:
            ok = False
            lines.append(f"  {t}: UNREADABLE -- {exc}")
            continue
        verdict, detail = sp.content_verdict(t, dg)
        if verdict is False:
            ok = False
        lines.append(f"  {t}: {'PASS' if verdict else 'FAIL'} ({n:,} rows)")
    return ok, lines


def registry_complete(conn):
    ok, lines = True, []
    for t in sp.governed_tables():
        unc = sp.unclassified_columns(conn, t)
        stale = sp.stale_classifications(conn, t)
        if unc or stale:
            ok = False
            lines.append(f"  {t}: unclassified={sorted(unc)} stale={sorted(stale)}")
    if ok:
        lines.append("  every physical column is classified")
    return ok, lines


def compare(conn):
    numeric, provenance, structural = [], None, oi.StructuralReport()
    for table in sp.observed_tables():
        fields = list(sp.observed_fields(table))
        # read_observed proves key uniqueness in the same pass it materialises
        # the surface; a separate SELECT DISTINCT over depth_chart's 22-column
        # key cost ~200s and proved nothing extra.
        current, cur_digest, n_cur = oi.read_observed(conn, table)
        base, base_digest, base_fields = oi.read_baseline(
            baseline_path(table), table, fields)
        structural.rows_baseline += len(base)
        structural.rows_current += n_cur
        if base_digest != cur_digest or len(base) != n_cur:
            structural.key_sequence_matches = False
            continue                      # never pair rows that may not correspond
        modes = [sp.observation(table, f).mode for f in fields]
        num_cols = [f for f, m in zip(fields, modes)
                    if m == sp.OBSERVE_TOLERANCE_NUMERIC]
        if num_cols:
            idx = [fields.index(c) for c in num_cols]
            numeric += oi.observe_numeric(
                table, num_cols,
                [tuple(r[i] for i in idx) for r in base],
                [tuple(r[i] for i in idx) for r in current])
        cat_cols = [f for f, m in zip(fields, modes)
                    if m == sp.OBSERVE_EXACT_CATEGORICAL]
        if cat_cols:
            idx = [fields.index(c) for c in cat_cols]
            provenance = oi.observe_provenance(
                [tuple(r[i] for i in idx) for r in base],
                [tuple(r[i] for i in idx) for r in current])
    return numeric, provenance, structural


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("db", nargs="?", default=DB_PATH)
    ap.add_argument("--update", action="store_true",
                    help="regenerate the accepted baseline (explicit, never automatic)")
    ap.add_argument("--reason", default="",
                    help="why the observed delta is accepted; recorded in the ledger")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"no database at {args.db}")
        return 1
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)

    if args.update:
        print("BASELINE UPDATE -- prerequisites")
        ok_b, lines_b = blocking_integrity(conn)
        for l in lines_b:
            print(l)
        ok_r, lines_r = registry_complete(conn)
        for l in lines_r:
            print(l)
        if not ok_b:
            print("\nREFUSED: blocking content integrity fails. Accepting an "
                  "observational delta on a corrupt database would launder the "
                  "corruption into the accepted baseline.")
            conn.close()
            return 4
        if not ok_r:
            print("\nREFUSED: the field registry is incomplete. Classification "
                  "must precede acceptance.")
            conn.close()
            return 4
        if not args.reason:
            print("\nREFUSED: --reason is required. A future investigator must be "
                  "able to tell why a historical observational value moved.")
            conn.close()
            return 4
        os.makedirs(BASELINE_DIR, exist_ok=True)
        print()
        for table in sp.observed_tables():
            n, digest, size = oi.write_baseline(conn, table, baseline_path(table))
            print(f"  wrote {table}: {n:,} rows, key digest {digest[:16]}..., "
                  f"{size/1e6:.2f} MB uncompressed")
        print(f"\n  reason: {args.reason}")
        conn.close()
        return 0

    try:
        numeric, provenance, structural = compare(conn)
    except (oi.BaselineError, oi.AmbiguousKeyError) as exc:
        print(f"OBSERVATION UNAVAILABLE: {exc}")
        conn.close()
        return 2
    finally:
        pass
    conn.close()

    print(oi.format_report(numeric, provenance, structural))
    status = oi.overall_status(numeric, provenance, structural)
    print(f"STATUS: {status}")
    return {oi.PASS: 0, oi.OBSERVED_NOISE: 0,
            oi.REVIEW_REQUIRED: 3, oi.FAIL: 4}[status]


if __name__ == "__main__":
    sys.exit(main())
