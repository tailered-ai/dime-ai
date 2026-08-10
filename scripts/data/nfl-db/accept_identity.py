#!/usr/bin/env python3
"""Admit ONE reviewed identity resolution into the accepted baseline (Phase 7).

    python3 scripts/data/nfl-db/accept_identity.py --check [db]
    python3 scripts/data/nfl-db/accept_identity.py <espn_id> --reason "..." [db]

The accepted baseline decides whether a derived identity is already trusted. It
must therefore never be written by the process whose output it judges: there is
no bulk mode, no --accept-all, and no path by which an ordinary build rewrites
accepted identity state.

This command admits exactly one Case E transition:

    accepted: unresolved   ->   current: resolved A

and refuses everything else. In particular it REFUSES Case C
(accepted A -> current B). A wrong-person reassignment and a new resolution look
superficially similar -- both end with a syntactically valid gsis_id -- but they
are different risk classes, and letting the routine command handle both is how a
reassignment gets rubber-stamped as an improvement.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import identity_baseline as ib  # noqa: E402
import season_pins as sp  # noqa: E402

DB_PATH = os.path.join(HERE, "nfl.db")


def blocking_integrity(conn):
    """Layer C acceptance may not paper over a broken build (§30)."""
    ok, lines = True, []
    for t in sp.governed_tables():
        try:
            dg, n, _ = sp.content_digest(conn, t, sp.window(t).predicate)
        except sqlite3.OperationalError as exc:
            ok = False
            lines.append(f"  {t}: UNREADABLE -- {exc}")
            continue
        verdict, _ = sp.content_verdict(t, dg)
        if verdict is False:
            ok = False
        lines.append(f"  {t}: {'PASS' if verdict else 'FAIL'} ({n:,} rows)")
    for t in sp.governed_tables():
        if sp.unclassified_columns(conn, t) or sp.stale_classifications(conn, t):
            ok = False
            lines.append(f"  {t}: field registry incomplete")
    return ok, lines


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("espn_id", nargs="?", help="the ONE source identity to admit")
    ap.add_argument("db", nargs="?", default=DB_PATH)
    ap.add_argument("--check", action="store_true",
                    help="report the current Layer C verdict and change nothing")
    ap.add_argument("--reason", default="",
                    help="evidence for the acceptance; recorded in the log")
    ap.add_argument("--root", default=None,
                    help="repository root to resolve the baseline against. Exists so "
                         "tests can exercise the WRITE path against a copy: a test "
                         "that drives this command against the real artifact will "
                         "modify reviewed evidence the moment a refusal regresses.")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"no database at {args.db}")
        return 1
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    verdict, findings, stats = ib.check(conn, root=args.root)

    if args.check or not args.espn_id:
        print(f"Layer C: {stats['accepted']} accepted "
              f"({stats['resolved']} resolved / {stats['unresolved']} unresolved)")
        for f in findings:
            print(f"  [{f['verdict']}] case {f['case']} {f['espn_id']}: "
                  f"accepted={f['accepted']!r} observed={f['observed']!r}")
            print(f"      {f['why']}")
        print(f"VERDICT: {verdict}")
        conn.close()
        return {ib.PASS: 0, ib.REVIEW_REQUIRED: 3, ib.FAIL: 4}[verdict]

    espn = args.espn_id
    target = [f for f in findings if f["espn_id"] == espn]
    if not target:
        print(f"REFUSED: {espn} has nothing to accept -- it is not reported as a "
              f"pending change. Run --check first.")
        conn.close()
        return 4
    f = target[0]

    if f["case"] == "C":
        print(f"REFUSED: {espn} is case C -- accepted {f['accepted']!r} but this "
              f"build derived {f['observed']!r}. That is a reassignment to a "
              f"DIFFERENT person, not a new resolution, and it may not be admitted "
              f"through this command. It requires an explicit reviewed correction.")
        conn.close()
        return 4
    if f["case"] != "E":
        print(f"REFUSED: {espn} is case {f['case']} ({f['why']}). Only case E "
              f"(unresolved -> resolved) may be admitted here.")
        conn.close()
        return 4
    if not args.reason:
        print("REFUSED: --reason is required. A future investigator must be able "
              "to tell why this identity became accepted.")
        conn.close()
        return 4

    ok_b, lines_b = blocking_integrity(conn)
    for line in lines_b:
        print(line)
    if not ok_b:
        print("\nREFUSED: blocking integrity fails. Accepting an identity on top of "
              "a broken build would launder the breakage into reviewed evidence.")
        conn.close()
        return 4

    current, present, derived, per_key, mixed = ib.observe(conn, {espn})
    if mixed or espn not in present:
        print(f"REFUSED: {espn} is ambiguous or absent in the current frozen "
              f"population; investigate before accepting.")
        conn.close()
        return 4
    new_gsis = current[espn]

    path = ib.baseline_path(args.root)
    with open(path) as fh:
        doc = json.load(fh)
    accepted_now = {m["espn_id"]: m for m in doc["mappings"]}
    taken = {m["gsis_id"]: m["espn_id"] for m in doc["mappings"]
             if m["gsis_id"] and m["espn_id"] != espn}
    if new_gsis in taken:
        print(f"REFUSED: {new_gsis} is already accepted for {taken[new_gsis]}; two "
              f"source identities may not name one person.")
        conn.close()
        return 4

    record = accepted_now[espn]
    print(f"\n  {espn}: {record['state']} -> {ib.RESOLVED}")
    print(f"      accepted gsis_id: {record['gsis_id']!r} -> {new_gsis!r}")
    print(f"      reason: {args.reason}")
    record["state"] = ib.RESOLVED
    record["gsis_id"] = new_gsis
    doc.setdefault("_acceptance_log", []).append(
        {"espn_id": espn, "gsis_id": new_gsis, "from_state": ib.UNRESOLVED,
         "to_state": ib.RESOLVED, "accepted_in": "targeted acceptance",
         "evidence": args.reason})
    doc["_counts"] = {
        "mappings": len(doc["mappings"]),
        "resolved": sum(1 for m in doc["mappings"] if m["gsis_id"]),
        "unresolved": sum(1 for m in doc["mappings"] if not m["gsis_id"]),
        "distinct_gsis": len({m["gsis_id"] for m in doc["mappings"] if m["gsis_id"]}),
        "rows_covered": doc.get("_counts", {}).get("rows_covered"),
    }
    ib.validate_document(doc)               # never write something invalid
    open(path, "w").write(ib.dump_document(doc))
    print(f"\n  wrote {os.path.basename(path)}: "
          f"{doc['_counts']['resolved']} resolved / "
          f"{doc['_counts']['unresolved']} unresolved")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
