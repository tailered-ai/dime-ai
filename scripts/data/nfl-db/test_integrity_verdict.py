#!/usr/bin/env python3
"""Tests for the composed whole-build integrity verdict -- Phase 8.9.

    python3 scripts/data/nfl-db/test_integrity_verdict.py

Four mechanisms answer four different questions about depth_chart, and this
module decides what the build as a whole is allowed to say. Two properties are
non-negotiable, and both are things the pre-Phase-8 system got wrong:

  WORST-WINS      a green gate may never downgrade a stronger verdict. Before
                  the split, one digest reported a legitimate new resolution as
                  frozen-history corruption; the fix must not be a softer gate
                  that reports corruption as acceptable.

  COVERAGE IS     fill rate cannot raise, lower, or otherwise touch the
  TELEMETRY       correctness state. The two defects that matter -- a person
                  disappearing, and a row reassigned to the wrong person -- move
                  coverage by nothing at all.

`compose` therefore accepts `coverage_delta` and refuses to read it. That is
tested behaviourally, by holding everything else fixed and sweeping coverage
across its whole range, and structurally, by reading the source.
"""
from __future__ import annotations

import itertools
import json
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import identity_baseline as ib  # noqa: E402
import identity_layers as il  # noqa: E402
import integrity_verdict as iv  # noqa: E402
import season_pins as sp  # noqa: E402

ALL = (iv.PASS, iv.OBSERVED, iv.REVIEW_REQUIRED, iv.FAIL)
COLS = list(sp.FIELD_CLASSES["depth_chart"])


def row(i, espn, gsis, source="T3"):
    base = {c: None for c in COLS}
    base.update({"depth_chart_id": i, "source_shape": "A", "snapshot_ts": None,
                 "source_ordinal": 1, "season": 2020, "season_type": "REG",
                 "week": 1, "bucket": "regular", "franchise_id": 100,
                 "full_name": f"Player {i}", "espn_id": espn, "gsis_id": gsis,
                 "gsis_source": source, "depth_order": 1, "unit": "Offense"})
    return base


def build(rows):
    conn = sqlite3.connect(":memory:")
    for t in sp.all_frozen_tables():
        conn.execute(f"CREATE TABLE {t} ({', '.join(sp.FIELD_CLASSES[t])})")
    conn.executemany(
        f"INSERT INTO depth_chart ({','.join(COLS)}) "
        f"VALUES ({','.join('?' * len(COLS))})", [[r[c] for c in COLS] for r in rows])
    return conn


def baseline(tmp, mappings):
    p = os.path.join(tmp, "accepted-identities.json")
    with open(p, "w") as fh:
        json.dump({"schema": ib.SCHEMA_VERSION, "mappings": mappings}, fh)
    return p


def accepted(espn, gsis=None):
    return {"espn_id": espn, "gsis_id": gsis,
            "state": ib.RESOLVED if gsis else ib.UNRESOLVED}


class WorstWins(unittest.TestCase):

    def test_the_ordering_is_total_and_fail_is_maximal(self):
        for x, y in itertools.product(ALL, repeat=2):
            with self.subTest(x=x, y=y):
                self.assertIn(iv.worst(x, y), (x, y))
        for v in ALL:
            self.assertEqual(iv.worst(v, iv.FAIL), iv.FAIL)

    def test_no_green_peer_can_downgrade_a_verdict(self):
        for v in ALL:
            with self.subTest(verdict=v):
                self.assertEqual(iv.worst(iv.PASS, v, iv.PASS, iv.PASS), v)

    def test_it_is_order_independent(self):
        for combo in itertools.permutations(ALL):
            self.assertEqual(iv.worst(*combo), iv.FAIL)

    def test_no_verdicts_at_all_is_pass(self):
        self.assertEqual(iv.worst(), iv.PASS)

    def test_it_agrees_with_layer_c_on_every_shared_verdict(self):
        """Two ranking tables exist -- Layer C's and this one -- because Layer C
        has no OBSERVED state. Two authorities drift, so their agreement on the
        overlap is asserted rather than assumed."""
        shared = (ib.PASS, ib.REVIEW_REQUIRED, ib.FAIL)
        for x, y in itertools.product(shared, repeat=2):
            with self.subTest(x=x, y=y):
                self.assertEqual(iv.worst(x, y), ib.worst(x, y))


class CoverageIsTelemetry(unittest.TestCase):

    def test_sweeping_coverage_cannot_change_any_verdict(self):
        for a, b, c in itertools.product(ALL, repeat=3):
            expected = iv.compose(a, b, c)
            for delta in (None, -1.0, -0.99, -0.5, 0.0, 0.5, 1.0, 1e9):
                with self.subTest(parts=(a, b, c), coverage=delta):
                    self.assertEqual(iv.compose(a, b, c, coverage_delta=delta),
                                     expected)

    def test_a_catastrophic_coverage_collapse_still_passes(self):
        """A 99% coverage collapse with every mechanism green is a PASS. It
        would be a bad build and a loud telemetry signal -- but coverage is not
        a correctness authority, and pretending otherwise is how an 85% gate
        came to block a legitimate resolution."""
        self.assertEqual(
            iv.compose(iv.PASS, iv.PASS, iv.PASS, coverage_delta=-0.99), iv.PASS)

    def test_compose_does_not_read_the_coverage_argument(self):
        with open(os.path.join(HERE, "lib", "integrity_verdict.py")) as fh:
            src = fh.read()
        body = src[src.index("def compose("):src.index("def evaluate(")]
        body = "\n".join(ln for ln in body.splitlines()
                         if not ln.strip().startswith("#"))
        signature, rest = body.split(":", 1)
        rest = rest.split('"""')[-1]      # drop the docstring that explains it
        self.assertNotIn("coverage_delta", rest,
                         "coverage_delta is referenced in executable code")


class Composition(unittest.TestCase):

    def test_a_clean_build_passes(self):
        self.assertEqual(iv.compose(iv.PASS, iv.PASS, iv.PASS), iv.PASS)

    def test_a_legitimate_new_resolution_is_review_not_failure(self):
        """THE contradiction Phase 8 removed. One event, previously reported as
        both 'needs review' and 'frozen history is corrupt'."""
        self.assertEqual(
            iv.compose(iv.PASS, iv.PASS, iv.REVIEW_REQUIRED), iv.REVIEW_REQUIRED)

    def test_a_wrong_person_reassignment_fails_the_build(self):
        self.assertEqual(iv.compose(iv.PASS, iv.PASS, iv.FAIL), iv.FAIL)

    def test_a_benign_provenance_relabel_is_observed(self):
        self.assertEqual(
            iv.compose(iv.PASS, iv.PASS, iv.PASS, iv.OBSERVED), iv.OBSERVED)

    def test_frozen_history_corruption_fails_even_with_identity_green(self):
        self.assertEqual(iv.compose(iv.FAIL, iv.PASS, iv.PASS), iv.FAIL)
        self.assertEqual(iv.compose(iv.PASS, iv.FAIL, iv.PASS), iv.FAIL)


class Evaluate(unittest.TestCase):
    """The end-to-end read of a built database."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rows = [row(i, str(1000 + i), f"00-00{i:05}") for i in range(1, 6)]
        self.mappings = [accepted(str(1000 + i), f"00-00{i:05}") for i in range(1, 6)]

    def tearDown(self):
        self.tmp.cleanup()

    def parts_of(self, conn, mappings=None):
        p = baseline(self.tmp.name, mappings or self.mappings)
        return iv.evaluate(conn, baseline_path=p)

    def test_it_reports_every_mechanism_separately(self):
        conn = build(self.rows)
        _, parts = self.parts_of(conn)
        self.assertEqual(set(parts),
                         {"layer_a", "layer_b", "layer_c", "conservation"})
        conn.close()

    def test_layer_a_and_b_fail_a_database_that_is_not_the_accepted_build(self):
        """A five-row fixture is not the pinned build, and must not be able to
        claim otherwise."""
        conn = build(self.rows)
        overall, parts = self.parts_of(conn)
        self.assertEqual(parts["layer_a"]["verdict"], iv.FAIL)
        self.assertEqual(parts["layer_b"]["verdict"], iv.FAIL)
        self.assertEqual(overall, iv.FAIL)
        conn.close()

    def test_an_ungoverned_row_fails_the_composition(self):
        rows = list(self.rows)
        rows.append(row(99, "1099", None, source="T3"))   # label, no identity
        conn = build(rows)
        _, parts = self.parts_of(conn)
        self.assertEqual(parts["conservation"]["detail"]["ungoverned"], 1)
        self.assertEqual(parts["conservation"]["verdict"], iv.FAIL)
        conn.close()

    def test_conservation_is_part_of_the_composed_verdict(self):
        with open(os.path.join(HERE, "lib", "integrity_verdict.py")) as fh:
            src = fh.read()
        self.assertIn('parts["conservation"]["verdict"]', src)

    def test_a_wrong_person_is_caught_with_no_coverage_movement_at_all(self):
        """Layer C sees the reassignment; fill rate is identical before and
        after, which is exactly why coverage cannot be the authority."""
        conn = build(self.rows)
        before = conn.execute(
            "SELECT COUNT(gsis_id) FROM depth_chart").fetchone()[0]
        conn.execute("UPDATE depth_chart SET gsis_id='00-0099999' "
                     "WHERE espn_id='1001'")
        after = conn.execute(
            "SELECT COUNT(gsis_id) FROM depth_chart").fetchone()[0]
        self.assertEqual(before, after, "coverage must not move for this test")
        _, parts = self.parts_of(conn)
        self.assertEqual(parts["layer_c"]["verdict"], iv.FAIL)
        conn.close()

    def test_a_new_resolution_is_review_required_not_failure(self):
        rows = list(self.rows)
        rows.append(row(9, "1009", "00-0077777", source="T3"))
        mappings = list(self.mappings) + [accepted("1009")]   # accepted UNRESOLVED
        conn = build(rows)
        _, parts = self.parts_of(conn, mappings)
        self.assertEqual(parts["layer_c"]["verdict"], iv.REVIEW_REQUIRED)
        conn.close()


class AgainstTheAcceptedBuild(unittest.TestCase):
    """Only runs when a built database is supplied via NFLDB_TEST_DB."""

    def setUp(self):
        db = os.environ.get("NFLDB_TEST_DB", "")
        if not db or not os.path.exists(db):
            self.skipTest("set NFLDB_TEST_DB to a built nfl.db")
        self.conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    def tearDown(self):
        self.conn.close()

    def test_the_accepted_build_composes_to_pass(self):
        overall, parts = iv.evaluate(self.conn)
        self.assertEqual(overall, iv.PASS, parts)

    def test_conservation_is_an_exact_partition_of_the_frozen_window(self):
        c = il.conservation(self.conn)
        self.assertEqual(c["ungoverned"], 0)
        self.assertEqual(c["overlapping"], 0)
        self.assertEqual(c["governed"], c["frozen_rows"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
