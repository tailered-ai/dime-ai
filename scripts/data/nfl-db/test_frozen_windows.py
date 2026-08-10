#!/usr/bin/env python3
"""Tests for the canonical frozen-window registry (lib/season_pins.FROZEN_WINDOWS).

    python3 scripts/data/nfl-db/test_frozen_windows.py

A correct hash over the wrong population is still wrong. Before this registry the
enforcer (build_db.py) and the generator (content_digest.py) each carried their own
WHERE clause and column list for the same four contracts, so one could silently
protect a different population than the other. These tests pin the single-authority
property mechanically rather than by convention.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import season_pins as sp  # noqa: E402

DB = os.environ.get("NFLDB_TEST_DB", "")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


class RegistryCompleteness(unittest.TestCase):
    """Section 20: no governed table may exist outside the registry."""

    def test_every_content_pinned_table_is_registered(self):
        self.assertEqual(set(sp.CONTENT_DIGESTS), set(sp.FROZEN_WINDOWS))

    def test_every_frozen_count_table_is_registered(self):
        self.assertEqual(set(sp.FROZEN_COUNTS), set(sp.FROZEN_WINDOWS))

    def test_registry_entries_carry_required_metadata(self):
        for t, w in sp.FROZEN_WINDOWS.items():
            self.assertIn(w.axis, (sp.AXIS_SEASON, sp.AXIS_SNAPSHOT), t)
            self.assertTrue(w.predicate.strip(), t)
            self.assertTrue(w.why_axis.strip(), f"{t} has no axis justification")
            self.assertIsInstance(w.expected_count, int)

    def test_expected_counts_agree_with_the_count_pins(self):
        for t, w in sp.FROZEN_WINDOWS.items():
            self.assertEqual(w.expected_count, sp.FROZEN_COUNTS[t], t)

    def test_unregistered_table_is_a_loud_error(self):
        with self.assertRaises(KeyError):
            sp.window("no_such_table")


class AxisCorrectness(unittest.TestCase):
    """Section 21: protects against recurrence of the #433 defect."""

    def test_depth_chart_uses_the_snapshot_axis(self):
        w = sp.window("depth_chart")
        self.assertEqual(w.axis, sp.AXIS_SNAPSHOT)
        self.assertIn("snapshot_ts", w.predicate)
        self.assertIn(sp.DEPTH_CHART_EXTRACT_CUTOFF, w.predicate)

    def test_depth_chart_predicate_contains_no_season_boundary(self):
        # A season term here would re-open the ~3.5-month window past the Super
        # Bowl that #433 shipped.
        self.assertNotIn("season <=", sp.window("depth_chart").predicate)
        self.assertNotIn("season <", sp.window("depth_chart").predicate)

    def test_season_axis_tables_use_the_literal_column(self):
        for t in ("player_game_stats", "snap_count", "roster_season"):
            w = sp.window(t)
            self.assertEqual(w.axis, sp.AXIS_SEASON, t)
            self.assertIn(f"season <= {sp.FROZEN_THROUGH}", w.predicate)
            self.assertNotIn("snapshot_ts", w.predicate)

    def test_season_keyed_frozen_verdict_still_refuses_depth_chart(self):
        with self.assertRaises(ValueError):
            sp.frozen_verdict("depth_chart", {2025: 1})


class LiveSeparation(unittest.TestCase):
    """Section 22: the frozen/live boundary is explicit and disjoint."""

    def test_every_window_declares_its_live_complement(self):
        for t, w in sp.FROZEN_WINDOWS.items():
            self.assertTrue(w.live_predicate, f"{t} has no live predicate")

    def test_frozen_and_live_predicates_are_not_identical(self):
        for t, w in sp.FROZEN_WINDOWS.items():
            self.assertNotEqual(w.predicate, w.live_predicate, t)

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_frozen_and_live_partition_the_table_exactly(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        for t, w in sp.FROZEN_WINDOWS.items():
            total = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            fr = c.execute(f"SELECT COUNT(*) FROM {t} WHERE {w.predicate}").fetchone()[0]
            lv = c.execute(f"SELECT COUNT(*) FROM {t} WHERE {w.live_predicate}").fetchone()[0]
            self.assertEqual(fr + lv, total, f"{t}: gap or overlap")
            self.assertEqual(fr, w.expected_count, t)
        c.close()


class SingleAuthority(unittest.TestCase):
    """Sections 15/17/18: enforcement and generation must share one definition."""

    def test_generator_derives_its_windows_from_the_registry(self):
        cd = _load("content_digest_under_test", os.path.join(HERE, "content_digest.py"))
        self.assertEqual(set(cd.WINDOWS), set(sp.FROZEN_WINDOWS))
        for t, pred in cd.WINDOWS.items():
            self.assertEqual(pred, sp.window(t).predicate, t)

    def test_generator_follows_a_registry_change(self):
        """Section 16/17: mutate the registry; the generator must move with it."""
        original = sp.FROZEN_WINDOWS["depth_chart"].predicate
        try:
            sp.FROZEN_WINDOWS["depth_chart"].predicate = "snapshot_ts <= '1999-01-01T00:00:00Z'"
            cd = _load("content_digest_mutated", os.path.join(HERE, "content_digest.py"))
            self.assertEqual(cd.WINDOWS["depth_chart"],
                             sp.FROZEN_WINDOWS["depth_chart"].predicate,
                             "generator kept an independent cutoff")
            self.assertNotEqual(cd.WINDOWS["depth_chart"], original)
        finally:
            sp.FROZEN_WINDOWS["depth_chart"].predicate = original

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_projection_has_one_authority(self):
        """Section 18: the hashed field list is derived in exactly one place, so
        the enforcer cannot hash A,B,C while the generator believes A,B,C,D."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                proj = sp.projection(c, t)
                _, _, keep = sp.content_digest(c, t, sp.window(t).predicate)
                self.assertEqual(proj, keep, t)
                for col in sp.CONTENT_DIGEST_EXCLUDE.get(t, set()):
                    self.assertNotIn(col, proj, f"{t}.{col} leaked into the projection")
            # mutate the ONE authority; the projection must follow
            original = set(sp.CONTENT_DIGEST_EXCLUDE["snap_count"])
            try:
                sp.CONTENT_DIGEST_EXCLUDE["snap_count"] = {"season"}
                self.assertNotIn("season", sp.projection(c, "snap_count"))
                _, _, keep2 = sp.content_digest(c, "snap_count",
                                                sp.window("snap_count").predicate)
                self.assertNotIn("season", keep2)
            finally:
                sp.CONTENT_DIGEST_EXCLUDE["snap_count"] = original
        finally:
            c.close()

    def test_no_governed_consumer_hard_codes_a_frozen_predicate(self):
        """Falsifiable evidence that a second definition cannot creep back."""
        offenders = []
        for f in ("build_db.py", "content_digest.py"):
            src = open(os.path.join(HERE, f)).read()
            body = "\n".join(l for l in src.splitlines()
                             if not l.lstrip().startswith("#"))
            for pat in ("source_shape='A' OR snapshot_ts",
                        f"season <= {sp.FROZEN_THROUGH}"):
                if pat in body:
                    offenders.append((f, pat))
        self.assertEqual(offenders, [],
                         f"independent frozen predicate reintroduced: {offenders}")


class PinnedDigestsHold(unittest.TestCase):
    """Section 23: the four governed contracts must reproduce their pinned
    digests from a real database. This is what makes the exclusion map and the
    predicate load-bearing -- change either and these go red."""

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_every_pinned_digest_reproduces(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                w = sp.window(t)
                dg, n, _ = sp.content_digest(c, t, w.predicate)
                ok, detail = sp.content_verdict(t, dg)
                self.assertTrue(ok, f"{t}: {detail}")
                self.assertEqual(n, w.expected_count, t)
        finally:
            c.close()


class ExclusionAuthority(unittest.TestCase):
    """Section 19: one field-classification authority per integrity surface."""

    def test_exclusions_live_only_in_the_canonical_map(self):
        self.assertEqual(set(sp.CONTENT_DIGEST_EXCLUDE), set(sp.FROZEN_WINDOWS))

    def test_digest_reads_exclusions_from_that_map_alone(self):
        # content_digest() must not accept a caller-supplied exclusion list.
        import inspect
        sig = inspect.signature(sp.content_digest)
        self.assertNotIn("exclude", sig.parameters)

    def test_gsis_id_is_never_excluded(self):
        for t, ex in sp.CONTENT_DIGEST_EXCLUDE.items():
            self.assertNotIn("gsis_id", ex, t)


class TransitionModel(unittest.TestCase):
    """Section 24: the registry must not imply the legacy digest is the goal."""

    def test_depth_chart_legacy_digest_is_marked_transitional(self):
        s = sp.INTEGRITY_SURFACES["depth_chart"]["legacy_content_digest"]
        self.assertEqual(s["status"], sp.TRANSITIONAL)
        self.assertIn("MUST NOT ship", s["note"])

    def test_layers_are_declared_planned_not_active(self):
        d = sp.INTEGRITY_SURFACES["depth_chart"]
        for k in ("layer_a_raw_facts", "layer_b_source_identity",
                  "layer_c_derived_identity"):
            self.assertEqual(d[k]["status"], sp.PLANNED, k)

    def test_provenance_is_observational_not_historical_truth(self):
        p = sp.INTEGRITY_SURFACES["depth_chart"]["provenance"]
        self.assertEqual(p["status"], sp.OBSERVATIONAL)
        self.assertEqual(p["field"], "gsis_source")

    def test_layer_b_records_why_its_provenance_predicate_is_safe(self):
        note = sp.INTEGRITY_SURFACES["depth_chart"]["layer_b_source_identity"]["note"]
        self.assertIn("measured", note.lower())

    def test_corrected_provenance_evidence_is_recorded(self):
        """The stale 1,375 figure must be RETRACTED WITH ITS REASON, not deleted.
        Silently swapping a number hides that the original was measured on a
        broken build -- so this asserts the correction, and that the old claim
        survives only inside it."""
        src = open(os.path.join(HERE, "lib", "season_pins.py")).read()
        self.assertIn("EVIDENCE CORRECTION", src)
        for fact in ("1,059", "881", "163", "BROKEN", "contamination"):
            self.assertIn(fact, src, fact)
        i_old, i_corr = src.find("1,375"), src.find("EVIDENCE CORRECTION")
        self.assertGreater(i_old, i_corr,
                           "the old figure appears outside the correction block")
        self.assertLess(i_old - i_corr, 600,
                        "the old figure is not adjacent to its retraction")


if __name__ == "__main__":
    unittest.main(verbosity=2)
