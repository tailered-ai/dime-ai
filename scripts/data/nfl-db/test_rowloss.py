#!/usr/bin/env python3
"""Tests for the row-loss reconciliation accounting -- Phase 9.

    python3 scripts/data/nfl-db/test_rowloss.py

`rowloss.py` is 891 lines of reconciliation engine and had no tests. Its job is
to answer one question -- did every source row either land in the database or
get dropped for a declared reason -- and the ways that answer goes wrong are not
the ways a loader goes wrong.

The signature defect is F9-1: snap_count reports 324,611 missing and 324,611
loaded at the same time, because the database stores PFR-style game ids and the
replay emits nflverse-style ones. Losing every row while gaining an equal number
of different ones is not a failure mode any loader has -- it is two identifier
vocabularies being compared. A reconciler that reports that as loss is crying
wolf continuously, which is indistinguishable from not working at all.

The second defect has no visible symptom until you read the sign: `unexplained`
went NEGATIVE (-964,646 for depth_chart), which means the database held more
rows than the source could produce. That is only possible when the source is not
the source. Nothing in the tool binds an input to the build that consumed it.

These tests run without a database or an extract.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import unittest
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import rowloss  # noqa: E402


def recon(**kw):
    r = rowloss.Recon(table="t", source="s", key_cols=("k",))
    for name, value in kw.items():
        setattr(r, name, value)
    return r


def excs(*reasons):
    return [rowloss.Exception_(r, "f:1", {"k": i}) for i, r in enumerate(reasons)]


class Accounting(unittest.TestCase):
    """`unexplained` is the whole point: it is what nobody has accounted for."""

    def test_unexplained_is_source_minus_loaded_minus_excluded(self):
        r = recon(source_rows=100, loaded=90, exceptions=excs(*["why"] * 10))
        self.assertEqual(r.excluded, 10)
        self.assertEqual(r.unexplained, 0)

    def test_a_row_dropped_for_no_declared_reason_is_unexplained(self):
        r = recon(source_rows=100, loaded=90, exceptions=excs(*["why"] * 9))
        self.assertEqual(r.unexplained, 1)
        self.assertFalse(r.clean)

    def test_clean_requires_expected_to_equal_loaded(self):
        r = recon(source_rows=100, loaded=100, expected=99,
                  exceptions=[])
        self.assertEqual(r.unexplained, 0)
        self.assertFalse(r.clean, "expected != loaded must not be clean")

    def test_clean_requires_every_signal_to_be_empty(self):
        base = dict(source_rows=10, loaded=10, expected=10)
        self.assertTrue(recon(**base).clean)
        for field in ("missing_keys", "extra_keys", "duplicate_keys",
                      "value_drift", "manifest_errors"):
            with self.subTest(field=field):
                self.assertFalse(recon(**{**base, field: [("x", 1)]}).clean)

    def test_a_negative_unexplained_is_never_clean(self):
        """The database holding MORE rows than the source could produce is not a
        small anomaly -- it means the source is not the source. It must never
        read as clean just because the subtraction came out non-zero."""
        r = recon(source_rows=100, loaded=150, expected=100)
        self.assertEqual(r.unexplained, -50)
        self.assertFalse(r.clean)


class TheManifestIsBidirectional(unittest.TestCase):
    """A declared exclusion is a signed-off number, not a ceiling."""

    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE t (k)")
        self.addCleanup(self.conn.close)
        self.addCleanup(rowloss.TABLES.pop, "_t", None)
        self.addCleanup(rowloss.EXPECTED_EXCLUSIONS.pop, "_t", None)

    def register(self, keys, exceptions):
        rowloss.TABLES["_t"] = (
            lambda want_values: (Counter(keys), None, exceptions,
                                 len(keys) + len(exceptions)),
            "stub", ("k",), "SELECT k FROM t", "SELECT * FROM t")

    def test_a_matching_manifest_is_silent(self):
        rowloss.EXPECTED_EXCLUSIONS["_t"] = {"declared": 2}
        self.register([("a",)], excs("declared", "declared"))
        self.conn.execute("INSERT INTO t VALUES ('a')")
        r = rowloss.reconcile_table("_t", self.conn, want_values=False)
        self.assertEqual(r.manifest_errors, [])
        self.assertEqual(r.unexplained, 0)
        self.assertTrue(r.clean)

    def test_a_count_that_does_not_match_the_manifest_is_an_error(self):
        rowloss.EXPECTED_EXCLUSIONS["_t"] = {"declared": 2}
        self.register([("a",)], excs("declared"))
        self.conn.execute("INSERT INTO t VALUES ('a')")
        r = rowloss.reconcile_table("_t", self.conn, want_values=False)
        self.assertEqual(len(r.manifest_errors), 1)
        self.assertFalse(r.clean)

    def test_an_undeclared_exclusion_reason_is_an_error(self):
        """The one that matters. A new reason for dropping rows must not be able
        to arrive with the rows it drops."""
        rowloss.EXPECTED_EXCLUSIONS["_t"] = {}
        self.register([("a",)], excs("nobody_signed_off"))
        self.conn.execute("INSERT INTO t VALUES ('a')")
        r = rowloss.reconcile_table("_t", self.conn, want_values=False)
        self.assertEqual(len(r.manifest_errors), 1)
        self.assertIn("UNMANIFESTED", r.manifest_errors[0])
        self.assertFalse(r.clean)


class Detection(unittest.TestCase):
    """The reconciler must actually detect what it claims to detect."""

    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE t (k)")
        self.addCleanup(self.conn.close)
        self.addCleanup(rowloss.TABLES.pop, "_t", None)
        self.addCleanup(rowloss.EXPECTED_EXCLUSIONS.pop, "_t", None)
        rowloss.EXPECTED_EXCLUSIONS["_t"] = {}
        self.keys = [("a",), ("b",), ("c",)]
        rowloss.TABLES["_t"] = (
            lambda want_values: (Counter(self.keys), None, [], len(self.keys)),
            "stub", ("k",), "SELECT k FROM t", "SELECT * FROM t")

    def load(self, *values):
        self.conn.executemany("INSERT INTO t VALUES (?)", [(v,) for v in values])
        return rowloss.reconcile_table("_t", self.conn, want_values=False)

    def test_a_clean_load_is_clean(self):
        r = self.load("a", "b", "c")
        self.assertTrue(r.clean, r.summary())

    def test_a_dropped_row_is_reported_missing_and_unexplained(self):
        r = self.load("a", "b")
        self.assertEqual([k for k, _ in r.missing_keys], [("c",)])
        self.assertEqual(r.unexplained, 1)
        self.assertFalse(r.clean)

    def test_an_invented_row_is_reported_extra(self):
        r = self.load("a", "b", "c", "z")
        self.assertEqual(r.extra_keys, [("z",)])
        self.assertFalse(r.clean)

    def test_a_duplicate_does_not_cancel_a_drop(self):
        """Multiset, not set. Loading 'a' twice while losing 'c' must not net
        out to 'the counts match, everything is fine'."""
        r = self.load("a", "a", "b")
        self.assertEqual([k for k, _ in r.missing_keys], [("c",)])
        self.assertEqual(r.extra_keys, [("a",)])
        self.assertFalse(r.clean)

    def test_an_empty_source_does_not_pass_silently(self):
        rowloss.TABLES["_t"] = (lambda want_values: (Counter(), None, [], 0),
                                "stub", ("k",), "SELECT k FROM t", "SELECT * FROM t")
        r = self.load("a")
        self.assertFalse(r.clean, "an empty replay must not certify a full table")
        self.assertEqual(r.unexplained, -1)


class VocabularyMismatchIsNotLoss(unittest.TestCase):
    """F9-1. The shape that must never again be reported as row loss."""

    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE t (k)")
        self.addCleanup(self.conn.close)
        self.addCleanup(rowloss.TABLES.pop, "_t", None)
        self.addCleanup(rowloss.EXPECTED_EXCLUSIONS.pop, "_t", None)
        rowloss.EXPECTED_EXCLUSIONS["_t"] = {}

    def test_total_missing_with_an_equal_load_is_a_key_mismatch(self):
        """324,611 missing AND 324,611 loaded AND 0 excluded is not loss: no
        loader drops every row and invents an equal number of different ones.

        This asserts the DIAGNOSIS, not the tool's current output -- the tool
        still calls it unclean, correctly. What it must never do is let the
        number be read as rows that went missing.
        """
        src = [(f"nflverse_{i}",) for i in range(5)]
        rowloss.TABLES["_t"] = (
            lambda want_values: (Counter(src), None, [], len(src)),
            "stub", ("k",), "SELECT k FROM t", "SELECT * FROM t")
        self.conn.executemany("INSERT INTO t VALUES (?)",
                              [(f"pfr_{i}",) for i in range(5)])
        r = rowloss.reconcile_table("_t", self.conn, want_values=False)

        self.assertEqual(len(r.missing_keys), 5)
        self.assertEqual(r.loaded, 5)
        self.assertEqual(r.excluded, 0)
        self.assertEqual(r.unexplained, 0, "counts reconcile; only the keys differ")
        self.assertFalse(r.clean)
        self.assertTrue(vocabulary_mismatch(r),
                        "this signature must be classified as a key mismatch")

    def test_a_real_drop_is_not_classified_as_a_vocabulary_mismatch(self):
        """Specificity. The classifier must not swallow genuine loss."""
        src = [(f"k{i}",) for i in range(5)]
        rowloss.TABLES["_t"] = (
            lambda want_values: (Counter(src), None, [], len(src)),
            "stub", ("k",), "SELECT k FROM t", "SELECT * FROM t")
        self.conn.executemany("INSERT INTO t VALUES (?)",
                              [(f"k{i}",) for i in range(4)])
        r = rowloss.reconcile_table("_t", self.conn, want_values=False)
        self.assertEqual(r.unexplained, 1)
        self.assertFalse(vocabulary_mismatch(r))


def vocabulary_mismatch(rec):
    """Every source key missing, an equal number loaded, nothing excluded.

    Row loss cannot produce this. Two identifier vocabularies can, and did --
    see F9-1 in phase-9-rowloss-revalidation.md.
    """
    return (rec.loaded > 0
            and sum(v for _, v in rec.missing_keys) == rec.expected
            and rec.loaded == rec.expected
            and rec.excluded == 0)


class InputProvenanceIsNotYetBound(unittest.TestCase):
    """F9-2, recorded as an executable statement of a known gap.

    Nothing binds the extracts in raw/ to the build that consumed them, so the
    reconciler can compare a July extract against an August database and report
    the difference as loss. Phases 10 and 11 close this. Until they do, the gap
    is asserted rather than left to be rediscovered.
    """

    def test_the_reconciler_does_not_yet_verify_input_digests(self):
        with open(os.path.join(HERE, "lib", "rowloss.py")) as fh:
            src = fh.read()
        bound = any(t in src for t in ("build_inputs", "sha256", "digest"))
        self.assertFalse(bound, "input binding has landed -- retire this test and "
                                "assert the binding positively instead")


if __name__ == "__main__":
    unittest.main(verbosity=2)
