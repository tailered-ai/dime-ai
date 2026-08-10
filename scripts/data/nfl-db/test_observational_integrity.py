#!/usr/bin/env python3
"""Tests for the non-blocking observation layer (Phase 6).

    python3 scripts/data/nfl-db/test_observational_integrity.py

Phase 5 proved these fields are ALLOWED to move. This layer adds the other half:
allowed to move is not allowed to move invisibly. The tests are therefore built
around two opposite failure modes, because a tolerance is only defensible if
both are ruled out:

  FALSE POSITIVE -- the proven serialisation noise trips review. If it does, the
    gate is noise and will be ignored within a month.
  FALSE NEGATIVE -- a real provider revision slips under the threshold. If it
    does, excluding these columns from the blocking digest created a blind spot
    rather than a considered decision.

The primary specificity evidence is the REAL corpus: 5,655 rows that actually
moved between two controlled builds. Toy values cannot prove a tolerance is
correctly calibrated against a defect that only appears at the 15th digit.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import observational_integrity as oi  # noqa: E402
import season_pins as sp  # noqa: E402

DB = os.environ.get("NFLDB_TEST_DB", "")
CMP_A = os.environ.get("NFLDB_COMPARE_A", "")
CMP_B = os.environ.get("NFLDB_COMPARE_B", "")
_CMP = CMP_A and CMP_B and os.path.exists(CMP_A) and os.path.exists(CMP_B)
BASELINE_DIR = os.path.join(HERE, "observational-baseline")

PGS = "player_game_stats"
SPEC = sp.observation(PGS, "receiving_epa")


def load_corpus():
    """The real regeneration corpus: aligned (old, new) pairs per metric."""
    metrics = sorted(sp.CONTENT_DIGEST_EXCLUDE[PGS])
    key = oi.KEY_SPEC[PGS]["explicit"]
    nk = len(key)
    sel = ",".join(tuple(key) + tuple(metrics))
    def load(p):
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        d = {r[:nk]: r[nk:] for r in c.execute(f"SELECT {sel} FROM {PGS}")}
        c.close()
        return d
    a, b = load(CMP_A), load(CMP_B)
    return metrics, a, b, sorted(set(a) & set(b))


# --------------------------------------------------------------------------
# Section 32 -- one authority for tolerance
# --------------------------------------------------------------------------
class ToleranceAuthority(unittest.TestCase):

    def test_every_observed_field_reads_its_spec_from_the_registry(self):
        for t in sp.observed_tables():
            for c in sp.observed_fields(t):
                self.assertIsNotNone(sp.observation(t, c))

    def test_module_defines_no_tolerance_of_its_own(self):
        """The comparator must not carry a private threshold. A second copy is
        how build, audit and test drift into disagreeing about what 'material'
        means."""
        src = open(os.path.join(HERE, "lib", "observational_integrity.py")).read()
        body = "\n".join(l for l in src.splitlines()
                         if not l.lstrip().startswith("#"))
        for forbidden in ("1e-12", "1e-6", "abs_tol =", "rel_tol =", "isclose"):
            self.assertNotIn(forbidden, body,
                             f"{forbidden!r} appears in the comparator; tolerance "
                             f"belongs only to season_pins.OBSERVATION_SPECS")

    def test_changing_the_canonical_tolerance_moves_every_consumer(self):
        spec = sp.observation(PGS, "receiving_epa")
        original = spec.rel_tolerance
        try:
            spec.rel_tolerance = 0.0
            spec.abs_tolerance = 0.0
            v, _, _ = oi.classify_numeric(1.0, 1.0 + 1e-15, spec)
            self.assertEqual(v, oi.MATERIAL_CHANGE)
        finally:
            spec.rel_tolerance = original
            spec.abs_tolerance = sp.DEFAULT_ABS_TOLERANCE

    def test_tolerance_exceeds_the_measured_noise_ceiling(self):
        self.assertGreater(sp.DEFAULT_REL_TOLERANCE, sp.NOISE_CEILING_RELATIVE)
        self.assertGreater(sp.DEFAULT_ABS_TOLERANCE, sp.NOISE_CEILING_ABSOLUTE)

    def test_spec_rejects_incoherent_declarations(self):
        with self.assertRaises(ValueError):
            sp.ObservationSpec(sp.OBSERVE_TOLERANCE_NUMERIC)          # no tolerances
        with self.assertRaises(ValueError):
            sp.ObservationSpec(sp.OBSERVE_EXACT_CATEGORICAL, abs_tolerance=1e-9)


# --------------------------------------------------------------------------
# Sections 52 / 23 -- the real noise corpus must never trip review
# --------------------------------------------------------------------------
class RealNoiseCorpus(unittest.TestCase):

    @unittest.skipUnless(_CMP, "needs NFLDB_COMPARE_A and NFLDB_COMPARE_B")
    def test_every_proven_regeneration_delta_classifies_as_noise(self):
        metrics, a, b, common = load_corpus()
        counts = {m: {"exact": 0, "noise": 0, "material": 0, "structural": 0}
                  for m in metrics}
        for k in common:
            for i, m in enumerate(metrics):
                v, _, _ = oi.classify_numeric(a[k][i], b[k][i], sp.observation(PGS, m))
                if v == oi.SAME:
                    continue
                counts[m]["exact"] += 1
                counts[m][{oi.NUMERICAL_NOISE: "noise",
                           oi.MATERIAL_CHANGE: "material",
                           oi.TYPE_OR_NULL_CHANGE: "structural"}[v]] += 1
        total_material = sum(c["material"] for c in counts.values())
        total_exact = sum(c["exact"] for c in counts.values())
        self.assertGreater(total_exact, 5000, "the corpus should contain real movement")
        self.assertEqual(total_material, 0,
                         f"proven serialisation noise was classified material: {counts}")
        self.assertEqual(sum(c["structural"] for c in counts.values()), 0)

    @unittest.skipUnless(_CMP, "needs NFLDB_COMPARE_A and NFLDB_COMPARE_B")
    def test_the_corpus_row_count_matches_phase_5(self):
        metrics, a, b, common = load_corpus()
        moved = {k for k in common
                 for i in range(len(metrics)) if a[k][i] != b[k][i]}
        self.assertEqual(len(moved), 5655)


# --------------------------------------------------------------------------
# Sections 53 / 24 / 45 -- material revisions must always be caught
# --------------------------------------------------------------------------
class MaterialSensitivity(unittest.TestCase):

    #: Realistic magnitudes, not absurd sentinels. An EPA model revision moves
    #: values by hundredths; a usage-share denominator change by thousandths.
    PLAUSIBLE = {"passing_epa": 0.01, "rushing_epa": 0.01, "receiving_epa": 0.01,
                 "target_share": 0.001, "air_yards_share": 0.001,
                 "fantasy_points": 0.01, "fantasy_points_ppr": 0.01}

    def test_plausible_revisions_are_detected_for_every_metric(self):
        for m, shift in self.PLAUSIBLE.items():
            spec = sp.observation(PGS, m)
            for base in (0.0, 0.5, -0.5, 2.34, -17.3, 41.5):
                for direction in (1, -1):
                    with self.subTest(metric=m, base=base, shift=shift * direction):
                        v, _, _ = oi.classify_numeric(base, base + shift * direction, spec)
                        self.assertEqual(v, oi.MATERIAL_CHANGE)

    def test_multiples_of_tolerance_are_detected(self):
        spec = sp.observation(PGS, "receiving_epa")
        for mult in (10, 100, 1000):
            delta = spec.rel_tolerance * mult
            v, _, _ = oi.classify_numeric(1.0, 1.0 + delta, spec)
            self.assertEqual(v, oi.MATERIAL_CHANGE, f"{mult}x tolerance missed")

    def test_no_false_negatives_across_a_swept_corpus(self):
        """Every metric x magnitude x sign, all material. Zero misses allowed."""
        missed = []
        for m, shift in self.PLAUSIBLE.items():
            spec = sp.observation(PGS, m)
            for base in (0.0, 1e-3, 0.25, 1.0, 12.5, 53.2, -0.25, -12.5):
                for s in (shift, -shift, shift * 10, -shift * 10):
                    v, _, _ = oi.classify_numeric(base, base + s, spec)
                    if v != oi.MATERIAL_CHANGE:
                        missed.append((m, base, s))
        self.assertEqual(missed, [], f"false negatives: {missed[:10]}")


# --------------------------------------------------------------------------
# Section 25 -- the boundary is defined, not accidental
# --------------------------------------------------------------------------
class ToleranceBoundary(unittest.TestCase):

    def test_just_below_at_and_just_above_the_absolute_threshold(self):
        spec = sp.observation(PGS, "receiving_epa")
        at = spec.abs_tolerance
        # base 0.0 isolates the absolute term: the relative term is undefined there
        self.assertEqual(oi.classify_numeric(0.0, at * 0.5, spec)[0], oi.NUMERICAL_NOISE)
        self.assertEqual(oi.classify_numeric(0.0, at, spec)[0], oi.NUMERICAL_NOISE)
        self.assertEqual(oi.classify_numeric(0.0, at * 10, spec)[0], oi.MATERIAL_CHANGE)

    def test_the_threshold_itself_is_inclusive(self):
        """<= not <. Stated as a test so it cannot drift silently."""
        spec = sp.observation(PGS, "receiving_epa")
        self.assertEqual(oi.classify_numeric(0.0, spec.abs_tolerance, spec)[0],
                         oi.NUMERICAL_NOISE)

    def test_just_below_and_above_the_relative_threshold(self):
        spec = sp.observation(PGS, "receiving_epa")
        base = 10.0
        below = base * (1 + spec.rel_tolerance * 0.5)
        above = base * (1 + spec.rel_tolerance * 100)
        self.assertEqual(oi.classify_numeric(base, below, spec)[0], oi.NUMERICAL_NOISE)
        self.assertEqual(oi.classify_numeric(base, above, spec)[0], oi.MATERIAL_CHANGE)


# --------------------------------------------------------------------------
# Sections 26 / 27 / 28 -- zero, magnitude, sign
# --------------------------------------------------------------------------
class ZeroMagnitudeAndSign(unittest.TestCase):

    def test_exact_zero_to_exact_zero_is_same(self):
        self.assertEqual(oi.classify_numeric(0.0, 0.0, SPEC)[0], oi.SAME)

    def test_relative_tolerance_alone_would_fail_at_zero(self):
        """Why the absolute term exists. Against 0.0 the denominator is the other
        operand, so the relative ratio saturates at 1.0 no matter how tiny the
        movement -- 1e-18 and 1e+18 both score 1.0. A relative-only policy would
        therefore call every departure from zero material. The absolute term is
        what makes this case decidable."""
        v, delta, rel = oi.classify_numeric(0.0, 1e-18, SPEC)
        self.assertEqual(rel, 1.0)                       # relative is useless here
        self.assertGreater(rel, SPEC.rel_tolerance)      # and would say MATERIAL
        self.assertEqual(v, oi.NUMERICAL_NOISE)          # rescued by the absolute term
        self.assertLessEqual(delta, SPEC.abs_tolerance)

    def test_material_change_around_zero_is_still_material(self):
        self.assertEqual(oi.classify_numeric(0.0, 0.01, SPEC)[0], oi.MATERIAL_CHANGE)
        self.assertEqual(oi.classify_numeric(0.0, -0.01, SPEC)[0], oi.MATERIAL_CHANGE)

    def test_absolute_tolerance_alone_would_be_wrong_at_large_magnitude(self):
        """And why the relative term exists: passing_epa reaches +-41, where the
        proven noise (1.03e-13) exceeds a tight absolute threshold."""
        spec = sp.observation(PGS, "passing_epa")
        self.assertEqual(oi.classify_numeric(41.58, 41.58 + 1.03e-13, spec)[0],
                         oi.NUMERICAL_NOISE)

    def test_tiny_sign_flip_near_zero_is_noise_by_distance_not_by_rule(self):
        v, _, _ = oi.classify_numeric(1e-16, -1e-16, SPEC)
        self.assertEqual(v, oi.NUMERICAL_NOISE)

    def test_material_sign_flip_is_material(self):
        self.assertEqual(oi.classify_numeric(0.5, -0.5, SPEC)[0], oi.MATERIAL_CHANGE)
        self.assertEqual(oi.classify_numeric(-2.3, 2.3, SPEC)[0], oi.MATERIAL_CHANGE)

    def test_negative_to_nearby_negative_is_noise(self):
        self.assertEqual(oi.classify_numeric(-17.3, -17.3 - 1e-14, SPEC)[0],
                         oi.NUMERICAL_NOISE)


# --------------------------------------------------------------------------
# Sections 12 / 29 / 30 -- structural cases never reach tolerance
# --------------------------------------------------------------------------
class StructuralNeverTolerated(unittest.TestCase):

    def test_null_transitions_are_structural(self):
        self.assertEqual(oi.classify_numeric(None, 0.5, SPEC)[0], oi.TYPE_OR_NULL_CHANGE)
        self.assertEqual(oi.classify_numeric(0.5, None, SPEC)[0], oi.TYPE_OR_NULL_CHANGE)

    def test_null_to_tiny_value_is_not_rescued_by_tolerance(self):
        """The dangerous case: a NULL becoming a value smaller than tolerance."""
        self.assertEqual(oi.classify_numeric(None, 1e-18, SPEC)[0],
                         oi.TYPE_OR_NULL_CHANGE)

    def test_both_null_is_same(self):
        self.assertEqual(oi.classify_numeric(None, None, SPEC)[0], oi.SAME)

    def test_non_finite_values_are_structural(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertEqual(oi.classify_numeric(1.0, bad, SPEC)[0],
                             oi.TYPE_OR_NULL_CHANGE)
            self.assertEqual(oi.classify_numeric(bad, 1.0, SPEC)[0],
                             oi.TYPE_OR_NULL_CHANGE)

    def test_nan_to_nan_does_not_become_same(self):
        """math.isclose(nan, nan) is False but a naive == guard plus tolerance
        could still mis-handle it; NaN has no defined semantics here at all."""
        self.assertEqual(oi.classify_numeric(float("nan"), float("nan"), SPEC)[0],
                         oi.TYPE_OR_NULL_CHANGE)

    def test_type_changes_are_structural(self):
        self.assertEqual(oi.classify_numeric(1.0, "1.0", SPEC)[0], oi.TYPE_OR_NULL_CHANGE)
        self.assertEqual(oi.classify_numeric(True, 1.0, SPEC)[0], oi.TYPE_OR_NULL_CHANGE)


# --------------------------------------------------------------------------
# Sections 18 / 49 / 50 / 51 -- provenance
# --------------------------------------------------------------------------
class ProvenanceObservation(unittest.TestCase):

    def test_categorical_comparison_is_exact(self):
        self.assertEqual(oi.classify_categorical("T1", "T1"), oi.SAME)
        self.assertEqual(oi.classify_categorical("T1", "T0"), oi.MATERIAL_CHANGE)
        self.assertEqual(oi.classify_categorical(None, "T0"), oi.MATERIAL_CHANGE)

    def test_benign_relabel_is_not_review_required(self):
        p = oi.observe_provenance([("T1",), ("T3",)], [("T0",), ("T0",)],
                                  current_identity=["00-1", "00-2"],
                                  baseline_identity=["00-1", "00-2"])
        self.assertEqual(p.benign_relabels, 2)
        self.assertEqual(p.identity_changed, [])
        self.assertEqual(p.status(), oi.OBSERVED_NOISE)

    def test_identity_improvement_routes_to_review_not_to_drift(self):
        """Roc Taylor: unresolved -> resolved is an identity IMPROVEMENT and must
        be accepted deliberately, never absorbed as harmless provenance drift."""
        p = oi.observe_provenance([(None,)], [("T0",)],
                                  baseline_identity=[None],
                                  current_identity=["00-0040531"])
        self.assertEqual(p.identity_improved, 1)
        self.assertEqual(p.benign_relabels, 0)
        self.assertEqual(p.status(), oi.REVIEW_REQUIRED)

    def test_identity_regression_fails(self):
        """The 316-row T4 loss must still FAIL, not merely be reported."""
        p = oi.observe_provenance([("T4",)], [(None,)],
                                  baseline_identity=["00-0040531"],
                                  current_identity=[None])
        self.assertEqual(p.identity_regressed, 1)
        self.assertEqual(p.status(), oi.FAIL)

    def test_wrong_person_replacement_fails_despite_provenance_being_non_blocking(self):
        """THE control. A provenance relabel must never launder a change to the
        human a row refers to."""
        p = oi.observe_provenance([("T1",)], [("T0",)],
                                  baseline_identity=["00-0040531"],
                                  current_identity=["00-0099999"])
        self.assertEqual(len(p.identity_changed), 1)
        self.assertEqual(p.benign_relabels, 0)
        self.assertEqual(p.status(), oi.FAIL)

    def test_unknown_provenance_tier_fails(self):
        p = oi.observe_provenance([("T9",)], [("T9",)])
        self.assertTrue(p.unknown_values)
        self.assertEqual(p.status(), oi.FAIL)

    def test_known_tiers_are_pinned(self):
        self.assertEqual(set(sp.KNOWN_GSIS_SOURCES),
                         {"feed", "T0", "T1", "T2", "T3", "T4", None})

    def test_transition_matrix_is_reported_not_just_a_count(self):
        p = oi.observe_provenance([("T1",), ("T1",), ("T3",)],
                                  [("T0",), ("T0",), ("T0",)],
                                  baseline_identity=["a", "b", "c"],
                                  current_identity=["a", "b", "c"])
        self.assertEqual(p.transitions[("T1", "T0")], 2)
        self.assertEqual(p.transitions[("T3", "T0")], 1)


# --------------------------------------------------------------------------
# Section 40 -- status semantics
# --------------------------------------------------------------------------
class StatusSemantics(unittest.TestCase):

    def test_precedence_is_worst_wins(self):
        self.assertEqual(oi.worst(oi.PASS, oi.OBSERVED_NOISE), oi.OBSERVED_NOISE)
        self.assertEqual(oi.worst(oi.OBSERVED_NOISE, oi.REVIEW_REQUIRED),
                         oi.REVIEW_REQUIRED)
        self.assertEqual(oi.worst(oi.REVIEW_REQUIRED, oi.FAIL), oi.FAIL)

    def test_observation_cannot_downgrade_a_blocking_failure(self):
        """§40: observational code must never reclassify FAIL as review-only."""
        p = oi.observe_provenance([("T4",)], [(None,)],
                                  baseline_identity=["00-1"], current_identity=[None])
        f = oi.FieldObservation(PGS, "receiving_epa")
        f.noise = 5
        self.assertEqual(oi.overall_status([f], p, None), oi.FAIL)

    def test_material_change_is_never_auto_accepted(self):
        """§16: a material provider revision must surface as REVIEW_REQUIRED. It
        may not be absorbed as noise because the build completed, because the
        values came from nflverse, or because the percentage looked small."""
        f = oi.FieldObservation(PGS, "receiving_epa")
        f.exact_unequal = 1
        f.material = 1
        self.assertEqual(f.status(), oi.REVIEW_REQUIRED)
        self.assertEqual(oi.overall_status([f], None, None), oi.REVIEW_REQUIRED)

    def test_structural_change_is_never_auto_accepted(self):
        f = oi.FieldObservation(PGS, "receiving_epa")
        f.exact_unequal = 1
        f.structural = 1
        self.assertEqual(f.status(), oi.REVIEW_REQUIRED)

    def test_noise_is_reported_not_hidden(self):
        """§41: within-tolerance movement must not fail, but must not be silent."""
        f = oi.FieldObservation(PGS, "receiving_epa")
        f.exact_unequal = 2059
        f.noise = 2059
        self.assertEqual(f.status(), oi.OBSERVED_NOISE)
        d = f.as_dict()
        self.assertEqual(d["exact_unequal"], 2059)
        self.assertEqual(d["noise"], 2059)


# --------------------------------------------------------------------------
# Sections 35 / 36 / 37 -- the baseline itself
# --------------------------------------------------------------------------
class BaselineEncoding(unittest.TestCase):

    def test_float_round_trip_is_exact(self):
        vals = [0.0, -0.0, 0.06, 0.0599999999999999, -22.8214770330778,
                1e-300, 1e300, 41.582800000000001, 2.2250738585072014e-308]
        for v in vals:
            self.assertEqual(oi.decode_value(oi.encode_value(v), True), v)

    def test_strings_are_not_repr_quoted(self):
        """The bug this test exists for: repr('feed') is \"'feed'\", which
        decoded to a different value and made 1,106,381 provenance rows lossy."""
        self.assertEqual(oi.encode_value("feed"), "feed")
        self.assertEqual(oi.decode_value(oi.encode_value("feed"), False), "feed")

    def test_null_round_trips_and_is_distinguishable(self):
        self.assertEqual(oi.encode_value(None), "")
        self.assertIsNone(oi.decode_value("", True))
        self.assertIsNone(oi.decode_value("", False))

    def test_delimiter_collisions_are_refused_not_corrupted(self):
        for bad in ("a|b", "a\nb", ""):
            with self.assertRaises(oi.BaselineError):
                oi.encode_value(bad)

    def test_baseline_is_not_stored_at_the_lossy_upstream_precision(self):
        """§36/§37: 15 significant digits is what caused the upstream noise.
        Storing the baseline that way would make the comparison self-noisy.

        Not every double loses information at 15g -- 0.0599999999999999 happens
        to survive -- so the test uses values that provably do not, and asserts
        the encoder round-trips them anyway."""
        lossy_at_15g = [0.1 + 0.2, 1 / 3, 2 ** 0.5, 1e-7 / 3]
        proved = 0
        for v in lossy_at_15g:
            self.assertEqual(float(oi.encode_value(v)), v, f"encoder lost {v!r}")
            if float(f"{v:.15g}") != v:
                proved += 1
        self.assertGreater(proved, 0, "no example actually loses data at 15g")
        # and the value class the corpus is made of round-trips too
        for v in (0.06, 0.0599999999999999, -22.8214770330778):
            self.assertEqual(float(oi.encode_value(v)), v)

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_stored_baseline_round_trips_bit_identically(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.observed_tables():
                path = os.path.join(BASELINE_DIR, f"{t}.txt.gz")
                if not os.path.exists(path):
                    self.skipTest("baseline not generated")
                fields = list(sp.observed_fields(t))
                current, digest, n = oi.read_observed(c, t)
                base, base_digest, _ = oi.read_baseline(path, t, fields)
                self.assertEqual(len(base), n, t)
                self.assertEqual(base_digest, digest, f"{t}: key sequence differs")
                for a, b in zip(base, current):
                    self.assertEqual(a, b, t)
                    for x, y in zip(a, b):
                        self.assertIs(type(x), type(y), t)
        finally:
            c.close()

    def test_baseline_rejects_a_field_set_it_was_not_written_for(self):
        path = os.path.join(BASELINE_DIR, "player_game_stats.txt.gz")
        if not os.path.exists(path):
            self.skipTest("baseline not generated")
        with self.assertRaises(oi.BaselineError):
            oi.read_baseline(path, PGS, ["receiving_epa"])

    def test_missing_baseline_is_a_clear_error_not_a_silent_pass(self):
        with self.assertRaises(oi.BaselineError):
            oi.read_baseline("/nonexistent/baseline.txt.gz", PGS, ["receiving_epa"])


# --------------------------------------------------------------------------
# Section 11 -- key alignment
# --------------------------------------------------------------------------
class KeyAlignment(unittest.TestCase):

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_observation_keys_are_one_to_one(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.observed_tables():
                self.assertGreater(oi.prove_key_is_unique(c, t), 0)
        finally:
            c.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_the_hand_picked_phase5_key_would_have_been_rejected(self):
        """Regression guard for a real defect. Phase 5 aligned depth_chart on
        nine hand-picked columns; that key collapses 331,628 of 1,106,729 rows,
        and a dict load silently dropped them. The findings survived, but only
        by luck. This proves the guard now refuses that key."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            original = oi.KEY_SPEC["depth_chart"]
            oi.KEY_SPEC["depth_chart"] = {"explicit": (
                "source_shape", "snapshot_ts", "source_ordinal", "season", "week",
                "franchise_id", "espn_id", "depth_position", "unit")}
            with self.assertRaises(oi.AmbiguousKeyError):
                oi.prove_key_is_unique(c, "depth_chart")
            with self.assertRaises(oi.AmbiguousKeyError):
                oi.read_observed(c, "depth_chart")
        finally:
            oi.KEY_SPEC["depth_chart"] = original
            c.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_depth_chart_key_excludes_the_identity_it_cross_checks(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            self.assertNotIn("gsis_id", oi.observation_key(c, "depth_chart"))
            self.assertNotIn("gsis_source", oi.observation_key(c, "depth_chart"))
        finally:
            c.close()


# --------------------------------------------------------------------------
# Sections 42 / 43 / 44 -- acceptance is deliberate, and refuses on bad ground
# --------------------------------------------------------------------------
class AcceptanceWorkflow(unittest.TestCase):
    """The updater must refuse to enshrine a delta on top of a broken database.
    Accepting an observational change while blocking integrity fails would
    launder the corruption into the accepted state."""

    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "observe_nonblocking", os.path.join(HERE, "observe_nonblocking.py"))
        self.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli)

    def fixture(self, classified=True):
        """A database carrying ALL governed tables, because registry_complete
        checks every one of them -- a fixture with a single table would report
        the others as stale and fail for the wrong reason."""
        c = sqlite3.connect(":memory:")
        for table in sp.governed_tables():
            cols = list(sp.FIELD_CLASSES[table])
            if not classified and table == "snap_count":
                cols.append("unclassified_new_column")
            c.execute(f"CREATE TABLE {table} ({', '.join(cols)})")
        c.execute("INSERT INTO snap_count (gsis_id) VALUES ('x')")
        return c

    def test_blocking_integrity_failure_blocks_acceptance(self):
        c = self.fixture()
        try:
            ok, lines = self.cli.blocking_integrity(c)
            self.assertFalse(ok, "a database that cannot reproduce its pins "
                                 "must not be accepted as a baseline")
        finally:
            c.close()

    def test_unclassified_column_blocks_acceptance(self):
        c = self.fixture(classified=False)
        try:
            ok, _ = self.cli.registry_complete(c)
            self.assertFalse(ok, "classification must precede acceptance")
        finally:
            c.close()

    def test_registry_complete_passes_on_a_classified_schema(self):
        c = self.fixture()
        try:
            ok, _ = self.cli.registry_complete(c)
            self.assertTrue(ok)
        finally:
            c.close()

    def test_there_is_no_accept_all_shortcut(self):
        """The flag must not EXIST. Checked against the argparse declarations
        rather than raw text, because the module docstring deliberately mentions
        --accept-all in order to record that it is absent by design."""
        src = open(os.path.join(HERE, "observe_nonblocking.py")).read()
        declared = [l for l in src.splitlines() if "add_argument(" in l]
        for l in declared:
            self.assertNotIn("accept-all", l)
            self.assertNotIn("accept_all", l)
        self.assertTrue(any("--update" in l for l in declared))
        self.assertTrue(any("--reason" in l for l in declared))

    def test_update_requires_an_explicit_reason(self):
        """§17: a future investigator must be able to tell why a historical
        observational value moved."""
        src = open(os.path.join(HERE, "observe_nonblocking.py")).read()
        self.assertIn("--reason", src)
        self.assertIn("REFUSED", src)

    def test_update_actually_refuses_and_writes_nothing(self):
        """§43 end to end, not just the predicate.

        The mutation matrix caught that testing blocking_integrity() alone
        proves nothing about whether main() honours it: neutering the refusal
        branch left every other test green. This drives the real entry point and
        asserts BOTH the exit status and that no baseline was written -- a
        refusal that still writes the file would be no refusal at all.
        """
        import tempfile
        tmp = tempfile.mkdtemp()
        db = os.path.join(tmp, "corrupt.db")
        out = os.path.join(tmp, "baseline")
        os.makedirs(out)
        c = sqlite3.connect(db)
        for table in sp.governed_tables():          # right shape, wrong content
            c.execute(f"CREATE TABLE {table} "
                      f"({', '.join(sp.FIELD_CLASSES[table])})")
        c.commit()
        c.close()

        original_dir, original_argv = self.cli.BASELINE_DIR, sys.argv
        try:
            self.cli.BASELINE_DIR = out
            sys.argv = ["observe_nonblocking.py", "--update",
                        "--reason", "test", db]
            rc = self.cli.main()
            self.assertEqual(rc, 4, "a corrupt database was accepted as a baseline")
            self.assertEqual(os.listdir(out), [],
                             "refused, yet a baseline file was still written")
        finally:
            self.cli.BASELINE_DIR = original_dir
            sys.argv = original_argv

    def test_the_build_does_not_depend_on_the_baseline(self):
        """§60: observation is audit-only. If build_db.py imported it, a missing
        baseline would break database construction."""
        build = open(os.path.join(HERE, "build_db.py")).read()
        self.assertNotIn("observational_integrity", build)
        self.assertNotIn("observe_nonblocking", build)
        self.assertNotIn("observational-baseline", build)


if __name__ == "__main__":
    unittest.main(verbosity=2)
