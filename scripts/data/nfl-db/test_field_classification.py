#!/usr/bin/env python3
"""Tests for the field-semantics registry (Phase 5).

    python3 scripts/data/nfl-db/test_field_classification.py

Phase 4 proved the digest represents its content contract exactly. That makes the
only remaining question the semantic one: is the CONTRACT right? A
cryptographically perfect digest over the wrong fields is still a wrong integrity
system.

So these tests do not ask "does the digest work". They ask, per column:

  * does every BLOCKING field deserve immutability -- i.e. does mutating it,
    without changing the row count, actually fail the gate?
  * does every NON-BLOCKING field deserve to move -- and is it still governed by
    something rather than dropped out of integrity entirely?
  * can a NEW column enter, or a REMOVED column linger, without anyone deciding?
  * can a provenance relabel launder a wrong-person identity change?

The last one is the point of the whole exercise. gsis_source is deliberately
outside the blocking digest; that must never become a path by which the human a
row refers to can be replaced silently.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import season_pins as sp  # noqa: E402

DB = os.environ.get("NFLDB_TEST_DB", "")
CMP_A = os.environ.get("NFLDB_COMPARE_A", "")   # controlled build A
CMP_B = os.environ.get("NFLDB_COMPARE_B", "")   # controlled build B


def fixture(table, rows=None):
    """A table carrying the real column set, so projection() and the exclusion
    derivation behave exactly as they do against nfl.db."""
    cols = list(sp.FIELD_CLASSES[table])
    c = sqlite3.connect(":memory:")
    c.execute(f"CREATE TABLE {table} ({', '.join(cols)})")
    if rows:
        c.executemany(f"INSERT INTO {table} VALUES ({','.join('?' * len(cols))})",
                      [[r.get(k) for k in cols] for r in rows])
    return c, cols


def dg(c, table, where="1=1"):
    return sp.content_digest(c, table, where)[0]


# --------------------------------------------------------------------------
# Sections 28 / 29 -- the taxonomy must cover the real schema
# --------------------------------------------------------------------------
class TaxonomyCoverage(unittest.TestCase):

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_every_physical_column_is_classified(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                self.assertEqual(sp.unclassified_columns(c, t), set(),
                                 f"{t}: physical columns with no classification")
        finally:
            c.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_no_classification_references_a_missing_column(self):
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                self.assertEqual(sp.stale_classifications(c, t), set(),
                                 f"{t}: registry claims a column that no longer exists")
        finally:
            c.close()

    @unittest.skipUnless(DB and os.path.exists(DB), "needs NFLDB_TEST_DB")
    def test_registry_blocking_set_equals_the_projection(self):
        """The registry is the authority; projection() must be its consequence."""
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        try:
            for t in sp.governed_tables():
                self.assertEqual(sp.blocking_columns(t), set(sp.projection(c, t)), t)
        finally:
            c.close()

    def test_registry_blocking_set_equals_the_projection_without_a_database(self):
        """The parity test above needs nfl.db, so it does not run on CI or a
        fresh clone. The §40 mutation matrix proved that gap was real: a second
        exclusion added locally inside projection() -- exactly the two-authority
        defect this registry exists to prevent -- survived every database-free
        test. This one runs everywhere."""
        for t in sp.governed_tables():
            c, _ = fixture(t)
            try:
                self.assertEqual(sp.blocking_columns(t), set(sp.projection(c, t)),
                                 f"{t}: projection() disagrees with the registry")
            finally:
                c.close()

    def test_classes_are_mutually_exclusive(self):
        for t in sp.governed_tables():
            blocking = sp.blocking_columns(t)
            nonblocking = sp.CONTENT_DIGEST_EXCLUDE[t]
            self.assertEqual(blocking & nonblocking, set(), t)
            self.assertEqual(blocking | nonblocking, sp.classified_columns(t), t)

    def test_exclusions_are_derived_not_declared_twice(self):
        """§18: one authority. CONTENT_DIGEST_EXCLUDE must follow FIELD_CLASSES."""
        for t in sp.governed_tables():
            expected = {c for c, s in sp.FIELD_CLASSES[t].items() if not s.blocking}
            self.assertEqual(sp.CONTENT_DIGEST_EXCLUDE[t], expected, t)


# --------------------------------------------------------------------------
# Sections 19 / 20 -- reason codes and governance completeness
# --------------------------------------------------------------------------
class GovernanceCompleteness(unittest.TestCase):

    def test_every_non_blocking_field_has_a_reason_code(self):
        for t in sp.governed_tables():
            for col in sp.CONTENT_DIGEST_EXCLUDE[t]:
                self.assertIn(sp.field(t, col).reason,
                              (sp.REASON_PROVIDER_DERIVED_METRIC,
                               sp.REASON_PROVENANCE_LABEL,
                               sp.REASON_SURROGATE_KEY), f"{t}.{col}")

    def test_every_non_blocking_field_names_a_governance_mechanism(self):
        """§20: a field outside the blocking digest must not fall out of
        governance entirely. GOV_NONE_INERT is allowed only for fields proven
        semantically inert, and it must say so."""
        for t in sp.governed_tables():
            for col in sp.CONTENT_DIGEST_EXCLUDE[t]:
                spec = sp.field(t, col)
                self.assertIn(spec.governance,
                              (sp.GOV_OBSERVATIONAL_DIGEST,
                               sp.GOV_IDENTITY_STATE_MACHINE,
                               sp.GOV_NONE_INERT), f"{t}.{col}")
                if spec.governance == sp.GOV_NONE_INERT:
                    self.assertEqual(spec.semantic_class, sp.SURROGATE_OR_TECHNICAL,
                                     f"{t}.{col}: only technical fields may be ungoverned")
                    self.assertIn("inert", spec.note.lower(), f"{t}.{col}")

    def test_no_non_blocking_semantic_field_is_ungoverned(self):
        ungoverned = [(t, c) for t in sp.governed_tables()
                      for c in sp.CONTENT_DIGEST_EXCLUDE[t]
                      if sp.field(t, c).governance == sp.GOV_NONE_INERT
                      and sp.field(t, c).semantic_class != sp.SURROGATE_OR_TECHNICAL]
        self.assertEqual(ungoverned, [])

    def test_no_field_is_declared_non_blocking_on_unresolved_evidence(self):
        """§12: 'movement is real but we cannot say why' does NOT make a field
        safe to treat as non-invariant. A field may only leave the blocking
        digest on evidence that actually establishes its semantics.

        This also keeps FieldSpec.evidence load-bearing. Phase 3 recorded the
        lesson that dead metadata inside a registry claiming to be the single
        authority is a trap -- someone eventually edits it believing it matters.
        Every classification is PROVEN today; this is what makes that a claim
        rather than a decoration."""
        for t in sp.governed_tables():
            for col, spec in sp.FIELD_CLASSES[t].items():
                self.assertIn(spec.evidence,
                              (sp.PROVEN, sp.STRONGLY_SUPPORTED, sp.UNRESOLVED),
                              f"{t}.{col}")
                if not spec.blocking:
                    self.assertNotEqual(
                        spec.evidence, sp.UNRESOLVED,
                        f"{t}.{col} is outside the blocking digest on unresolved "
                        f"evidence -- classify the movement or keep it blocking")

    def test_blocking_fields_carry_no_exclusion_reason(self):
        for t in sp.governed_tables():
            for col in sp.blocking_columns(t):
                self.assertIsNone(sp.field(t, col).reason, f"{t}.{col}")

    def test_fieldspec_rejects_incoherent_declarations(self):
        with self.assertRaises(ValueError):     # non-blocking without a reason
            sp.FieldSpec(sp.RAW_SOURCE_FACT, False, "x", sp.GOV_NONE_INERT)
        with self.assertRaises(ValueError):     # blocking with one
            sp.FieldSpec(sp.RAW_SOURCE_FACT, True, "x", sp.GOV_BLOCKING_DIGEST,
                         reason=sp.REASON_SURROGATE_KEY)

    def test_semantic_class_implies_its_mechanism(self):
        want = {sp.RAW_SOURCE_FACT: sp.GOV_BLOCKING_DIGEST,
                sp.SOURCE_OWNED_IDENTITY: sp.GOV_BLOCKING_DIGEST,
                sp.DERIVED_PROVIDER_METRIC: sp.GOV_OBSERVATIONAL_DIGEST,
                sp.PROVENANCE_LABEL: sp.GOV_OBSERVATIONAL_DIGEST,
                sp.SURROGATE_OR_TECHNICAL: sp.GOV_NONE_INERT}
        for t in sp.governed_tables():
            for col, spec in sp.FIELD_CLASSES[t].items():
                if spec.semantic_class in want:
                    self.assertEqual(spec.governance, want[spec.semantic_class],
                                     f"{t}.{col}")


# --------------------------------------------------------------------------
# Section 32 -- classification changes must never be casual
# --------------------------------------------------------------------------
class LockedClassifications(unittest.TestCase):
    """High-value fields are pinned. Flipping one now fails a test rather than
    quietly widening or narrowing what history means."""

    LOCKED = {
        ("depth_chart", "gsis_id"): (sp.SOURCE_OWNED_IDENTITY, True),
        ("depth_chart", "gsis_source"): (sp.PROVENANCE_LABEL, False),
        ("depth_chart", "depth_chart_id"): (sp.SURROGATE_OR_TECHNICAL, False),
        ("depth_chart", "source_ordinal"): (sp.RAW_SOURCE_FACT, True),
        ("depth_chart", "espn_id"): (sp.RAW_SOURCE_FACT, True),
        ("player_game_stats", "gsis_id"): (sp.SOURCE_OWNED_IDENTITY, True),
        ("player_game_stats", "receiving_yards"): (sp.RAW_SOURCE_FACT, True),
        ("player_game_stats", "receptions"): (sp.RAW_SOURCE_FACT, True),
        ("player_game_stats", "passing_tds"): (sp.RAW_SOURCE_FACT, True),
        ("player_game_stats", "game_id"): (sp.RAW_SOURCE_FACT, True),
        ("player_game_stats", "franchise_id"): (sp.RAW_SOURCE_FACT, True),
        ("player_game_stats", "receiving_epa"): (sp.DERIVED_PROVIDER_METRIC, False),
        ("player_game_stats", "fantasy_points"): (sp.DERIVED_PROVIDER_METRIC, False),
        ("snap_count", "gsis_id"): (sp.DERIVED_INTERNAL_IDENTITY, True),
        ("snap_count", "offense_snaps"): (sp.RAW_SOURCE_FACT, True),
        ("snap_count", "offense_pct"): (sp.RAW_SOURCE_FACT, True),
        ("roster_season", "gsis_id"): (sp.SOURCE_OWNED_IDENTITY, True),
        ("roster_season", "source_ordinal"): (sp.RAW_SOURCE_FACT, True),
        ("roster_season", "roster_row_id"): (sp.SURROGATE_OR_TECHNICAL, False),
    }

    def test_high_value_classifications_are_locked(self):
        for (t, col), (cls, blocking) in self.LOCKED.items():
            spec = sp.field(t, col)
            self.assertEqual(spec.semantic_class, cls, f"{t}.{col} class changed")
            self.assertEqual(spec.blocking, blocking, f"{t}.{col} blocking changed")

    def test_no_raw_counting_statistic_is_non_blocking(self):
        """A raw counting stat is immutable history. It may never be excluded."""
        raw_stats = ("completions", "attempts", "passing_yards", "passing_tds",
                     "interceptions", "carries", "rushing_yards", "rushing_tds",
                     "receptions", "targets", "receiving_yards", "receiving_tds")
        for col in raw_stats:
            spec = sp.field("player_game_stats", col)
            self.assertTrue(spec.blocking, f"{col} became non-blocking")
            self.assertEqual(spec.semantic_class, sp.RAW_SOURCE_FACT, col)

    def test_identity_columns_are_never_excluded(self):
        for t in sp.governed_tables():
            self.assertNotIn("gsis_id", sp.CONTENT_DIGEST_EXCLUDE[t], t)


# --------------------------------------------------------------------------
# Sections 30 / 31 -- silence guards
# --------------------------------------------------------------------------
class SchemaDriftGuards(unittest.TestCase):

    def test_a_new_column_cannot_enter_silently(self):
        """§30: adding a column without classifying it must FAIL."""
        c, _ = fixture("roster_season")
        try:
            self.assertEqual(sp.unclassified_columns(c, "roster_season"), set())
            c.execute("ALTER TABLE roster_season ADD COLUMN new_upstream_field TEXT")
            self.assertEqual(sp.unclassified_columns(c, "roster_season"),
                             {"new_upstream_field"},
                             "a new column landed outside every integrity guarantee")
        finally:
            c.close()

    def test_a_new_column_would_silently_join_the_blocking_digest(self):
        """Why §30 matters: projection() is 'all columns minus exclusions', so an
        unclassified column is not merely undocumented -- it starts being hashed,
        and the pinned digest breaks with no statement of what it is."""
        c, _ = fixture("roster_season")
        try:
            before = set(sp.projection(c, "roster_season"))
            c.execute("ALTER TABLE roster_season ADD COLUMN new_upstream_field TEXT")
            after = set(sp.projection(c, "roster_season"))
            self.assertEqual(after - before, {"new_upstream_field"})
        finally:
            c.close()

    def test_a_removed_column_cannot_linger_in_the_registry(self):
        """§31: the registry must not claim to protect a column that is gone."""
        c, cols = fixture("roster_season")
        try:
            keep = [x for x in cols if x != "years_exp"]
            c.execute("DROP TABLE roster_season")
            c.execute(f"CREATE TABLE roster_season ({', '.join(keep)})")
            self.assertEqual(sp.stale_classifications(c, "roster_season"),
                             {"years_exp"})
        finally:
            c.close()


# --------------------------------------------------------------------------
# Sections 22 / 25 -- every blocking field must actually be defended
# --------------------------------------------------------------------------
class BlockingNegativeControls(unittest.TestCase):
    """Cardinality-preserving corruption: the row count never moves, so a count
    gate sees nothing. The digest must."""

    ROW = {"gsis_id": "00-0011111", "season": 2020, "week": 3,
           "season_type": "REG", "game_id": "2020_03_AAA_BBB", "franchise_id": 7,
           "opponent_id": 8, "position": "WR", "position_group": "REC",
           "completions": 0, "attempts": 0, "passing_yards": 0, "passing_tds": 0,
           "interceptions": 0, "sacks_suffered": 0, "carries": 1,
           "rushing_yards": 5, "rushing_tds": 0, "receptions": 4, "targets": 6,
           "receiving_yards": 52, "receiving_tds": 1,
           "passing_epa": 0.0, "rushing_epa": 0.11, "receiving_epa": 2.34,
           "target_share": 0.25, "air_yards_share": 0.31,
           "fantasy_points": 11.7, "fantasy_points_ppr": 15.7}

    def mutate(self, col, value, table="player_game_stats", row=None):
        row = row or self.ROW
        c, _ = fixture(table, [row])
        try:
            before = dg(c, table)
            n0 = c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            c.execute(f"UPDATE {table} SET {col}=?", (value,))
            n1 = c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            after = dg(c, table)
            return before, after, n0, n1
        finally:
            c.close()

    def test_every_blocking_semantic_class_is_defended(self):
        cases = [("gsis_id", "00-0099999", "identity"),
                 ("franchise_id", 8, "team"),
                 ("game_id", "2020_03_CCC_DDD", "game"),
                 ("receiving_yards", 53, "raw counting statistic"),
                 ("receptions", 5, "raw counting statistic"),
                 ("season", 2021, "date/season axis"),
                 ("week", 4, "date/week axis"),
                 ("position", "TE", "categorical source fact")]
        for col, val, kind in cases:
            with self.subTest(field=col, kind=kind):
                before, after, n0, n1 = self.mutate(col, val)
                self.assertEqual(n0, n1, "row count must be preserved")
                self.assertNotEqual(before, after,
                                    f"{col} ({kind}) is blocking but mutating it "
                                    f"did not change the digest")

    def test_every_blocking_column_is_individually_defended(self):
        """Not a sample: every blocking column of player_game_stats."""
        for col in sorted(sp.blocking_columns("player_game_stats")):
            with self.subTest(column=col):
                cur = self.ROW[col]
                val = (cur + 1) if isinstance(cur, int) else f"{cur}-X"
                before, after, n0, n1 = self.mutate(col, val)
                self.assertEqual(n0, n1)
                self.assertNotEqual(before, after, f"{col} is undefended")

    def test_snapshot_axis_is_defended_on_depth_chart(self):
        row = {c: None for c in sp.FIELD_CLASSES["depth_chart"]}
        row.update({"source_shape": "A", "snapshot_ts": "2020-09-01T00:00:00Z",
                    "source_ordinal": 1, "season": 2020, "week": 1,
                    "franchise_id": 7, "gsis_id": "00-0011111", "espn_id": "1234567",
                    "full_name": "Test Player", "depth_position": "WR",
                    "unit": "OFF", "gsis_source": "feed", "depth_chart_id": 1})
        before, after, n0, n1 = self.mutate("snapshot_ts", "2021-09-01T00:00:00Z",
                                            "depth_chart", row)
        self.assertEqual(n0, n1)
        self.assertNotEqual(before, after)


# --------------------------------------------------------------------------
# Sections 23 / 24 -- specificity, and the isolation it must not break
# --------------------------------------------------------------------------
class NonBlockingSpecificity(unittest.TestCase):
    """These prove only that the blocking digest DELIBERATELY does not govern
    these fields. They do not prove the fields are unimportant -- the evidence
    for that decision is the full-population semantic analysis in the Phase 5
    record, not this test."""

    def row(self, table):
        r = {c: None for c in sp.FIELD_CLASSES[table]}
        r.update({"gsis_id": "00-0011111", "season": 2020, "week": 3,
                  "season_type": "REG", "franchise_id": 7, "source_ordinal": 1})
        return r

    def test_each_non_blocking_field_alone_leaves_the_digest_unchanged(self):
        for t in sp.governed_tables():
            for col in sorted(sp.CONTENT_DIGEST_EXCLUDE[t]):
                with self.subTest(table=t, column=col):
                    c, _ = fixture(t, [self.row(t)])
                    try:
                        before = dg(c, t)
                        c.execute(f"UPDATE {t} SET {col}=?", ("MUTATED-SENTINEL",))
                        self.assertEqual(dg(c, t), before,
                                         f"{t}.{col} is declared non-blocking but "
                                         f"still moved the blocking digest")
                    finally:
                        c.close()

    def test_cross_field_isolation(self):
        """§24: excluding one field must not remove protection from its
        neighbours or from the row as a whole."""
        t = "player_game_stats"
        c, _ = fixture(t, [self.row(t)])
        try:
            base = dg(c, t)
            c.execute(f"UPDATE {t} SET receiving_epa=99.9")     # excluded only
            self.assertEqual(dg(c, t), base, "excluded field leaked into the digest")
            c.execute(f"UPDATE {t} SET receiving_yards=1234")   # + a blocking fact
            self.assertNotEqual(dg(c, t), base,
                                "excluding receiving_epa also dropped protection "
                                "from its neighbouring blocking column")
        finally:
            c.close()

    def test_excluding_a_field_does_not_unprotect_the_whole_row(self):
        t = "depth_chart"
        r = {c: None for c in sp.FIELD_CLASSES[t]}
        r.update({"source_shape": "A", "snapshot_ts": "2020-09-01T00:00:00Z",
                  "source_ordinal": 1, "season": 2020, "gsis_id": "00-0011111",
                  "gsis_source": "T1", "depth_chart_id": 1, "full_name": "A B"})
        c, _ = fixture(t, [r])
        try:
            base = dg(c, t)
            c.execute(f"UPDATE {t} SET gsis_source='T0', depth_chart_id=999")
            self.assertEqual(dg(c, t), base)
            c.execute(f"UPDATE {t} SET full_name='C D'")
            self.assertNotEqual(dg(c, t), base)
        finally:
            c.close()


# --------------------------------------------------------------------------
# Sections 26 / 27 -- legitimate movement passes; identity replacement does not
# --------------------------------------------------------------------------
class LegitimateMovementAndIdentityRegression(unittest.TestCase):

    def depth_row(self, **kw):
        r = {c: None for c in sp.FIELD_CLASSES["depth_chart"]}
        r.update({"source_shape": "A", "snapshot_ts": "2020-09-01T00:00:00Z",
                  "source_ordinal": 1, "season": 2020, "week": 1, "franchise_id": 7,
                  "espn_id": "4431597", "full_name": "Roc Taylor",
                  "gsis_id": "00-0040531", "gsis_source": "T1",
                  "depth_position": "WR", "unit": "OFF", "depth_chart_id": 1})
        r.update(kw)
        return r

    def test_provenance_relabel_with_unchanged_identity_passes(self):
        """§26: the real T1->T0 movement -- 881 rows in the controlled pair --
        must not fail core integrity."""
        c, _ = fixture("depth_chart", [self.depth_row()])
        try:
            before = dg(c, "depth_chart")
            c.execute("UPDATE depth_chart SET gsis_source='T0'")
            self.assertEqual(dg(c, "depth_chart"), before)
        finally:
            c.close()

    def test_provider_metric_float_noise_passes(self):
        """§26: the measured movement class -- last-bit float differences."""
        t = "player_game_stats"
        r = {c: None for c in sp.FIELD_CLASSES[t]}
        r.update({"gsis_id": "00-0011111", "season": 2020, "receiving_epa": 0.06,
                  "fantasy_points": 0.6})
        c, _ = fixture(t, [r])
        try:
            before = dg(c, t)
            c.execute(f"UPDATE {t} SET receiving_epa=0.0599999999999999, "
                      f"fantasy_points=0.600000000000001")
            self.assertEqual(dg(c, t), before)
        finally:
            c.close()

    def test_wrong_person_replacement_fails_even_though_provenance_is_excluded(self):
        """§27. THE control this phase exists for.

        Same espn_id, same row count, gsis_source changes -- and gsis_id is
        swapped to a different human. A provenance-label exclusion must never
        become a laundering path for identity replacement."""
        c, _ = fixture("depth_chart", [self.depth_row()])
        try:
            before = dg(c, "depth_chart")
            n0 = c.execute("SELECT COUNT(*) FROM depth_chart").fetchone()[0]
            c.execute("UPDATE depth_chart SET gsis_source='T0', "
                      "gsis_id='00-0099999'")          # a DIFFERENT person
            n1 = c.execute("SELECT COUNT(*) FROM depth_chart").fetchone()[0]
            self.assertEqual(n0, n1, "row count unchanged, so counts cannot catch it")
            self.assertNotEqual(dg(c, "depth_chart"), before,
                                "a provenance relabel laundered an identity change")
        finally:
            c.close()

    def test_identity_loss_fails(self):
        """The 316-row T4 regression class: identity dropped to NULL."""
        c, _ = fixture("depth_chart", [self.depth_row(gsis_source="T4")])
        try:
            before = dg(c, "depth_chart")
            c.execute("UPDATE depth_chart SET gsis_source=NULL, gsis_id=NULL")
            self.assertNotEqual(dg(c, "depth_chart"), before)
        finally:
            c.close()

    def test_unresolved_to_resolved_is_visible_to_the_blocking_digest(self):
        """§26/§35: the 15 Roc Taylor rows. gsis_id is blocking, so an identity
        IMPROVEMENT is not silently absorbed either -- it surfaces and must be
        accepted deliberately through the Phase 0R identity contract."""
        c, _ = fixture("depth_chart", [self.depth_row(gsis_source=None, gsis_id=None)])
        try:
            before = dg(c, "depth_chart")
            c.execute("UPDATE depth_chart SET gsis_source='T0', gsis_id='00-0040531'")
            self.assertNotEqual(dg(c, "depth_chart"), before)
        finally:
            c.close()


# --------------------------------------------------------------------------
# Sections 33 / 34 -- the same claims, against the real controlled builds
# --------------------------------------------------------------------------
_CMP = CMP_A and CMP_B and os.path.exists(CMP_A) and os.path.exists(CMP_B)


class RealControlledComparison(unittest.TestCase):
    """Fixtures prove the mechanism; these prove it on the actual populations
    that motivated every exclusion."""

    @unittest.skipUnless(_CMP, "needs NFLDB_COMPARE_A and NFLDB_COMPARE_B")
    def test_pgs_movement_touches_only_non_blocking_columns(self):
        a = sqlite3.connect(f"file:{CMP_A}?mode=ro", uri=True)
        b = sqlite3.connect(f"file:{CMP_B}?mode=ro", uri=True)
        try:
            cols = [r[1] for r in a.execute("PRAGMA table_info(player_game_stats)")]
            key = ["gsis_id", "season", "week", "season_type", "game_id"]
            nk = len(key)
            sel = ",".join(key + cols)
            def load(c):
                return {r[:nk]: r[nk:] for r in c.execute(
                    f"SELECT {sel} FROM player_game_stats")}
            da, db_ = load(a), load(b)
            common = set(da) & set(db_)
            self.assertGreater(len(common), 200_000)
            moved = set()
            for k in common:
                for i, col in enumerate(cols):
                    if da[k][i] != db_[k][i]:
                        moved.add(col)
            blocking = sp.blocking_columns("player_game_stats")
            self.assertEqual(moved & blocking, set(),
                             "a BLOCKING column moved between the controlled builds")
            self.assertTrue(moved, "the comparison found no movement at all")
            self.assertLessEqual(moved, sp.CONTENT_DIGEST_EXCLUDE["player_game_stats"])
        finally:
            a.close(); b.close()

    @unittest.skipUnless(_CMP, "needs NFLDB_COMPARE_A and NFLDB_COMPARE_B")
    def test_provider_metric_movement_is_float_noise_not_revision(self):
        """The claim that replaced 'recomputed upstream on model revision'."""
        a = sqlite3.connect(f"file:{CMP_A}?mode=ro", uri=True)
        b = sqlite3.connect(f"file:{CMP_B}?mode=ro", uri=True)
        try:
            excl = sorted(sp.CONTENT_DIGEST_EXCLUDE["player_game_stats"])
            key = ["gsis_id", "season", "week", "season_type", "game_id"]
            nk = len(key)
            sel = ",".join(key + excl)
            def load(c):
                return {r[:nk]: r[nk:] for r in c.execute(
                    f"SELECT {sel} FROM player_game_stats")}
            da, db_ = load(a), load(b)
            worst = 0.0
            for k in set(da) & set(db_):
                for i in range(len(excl)):
                    x, y = da[k][i], db_[k][i]
                    if isinstance(x, float) and isinstance(y, float) and x != y:
                        worst = max(worst, abs(y - x) / max(abs(x), 1e-12))
            self.assertGreater(worst, 0.0, "no movement observed to classify")
            self.assertLess(worst, 1e-9,
                            f"max relative movement {worst:.3e} is too large to be "
                            f"float serialization -- this is a substantive revision "
                            f"and the classification must be revisited")
        finally:
            a.close(); b.close()

    @unittest.skipUnless(_CMP, "needs NFLDB_COMPARE_A and NFLDB_COMPARE_B")
    def test_provenance_only_rows_move_nothing_but_provenance(self):
        """§34, on the real transition rows, with the 15 NULL->T0 identity
        improvements and 316 T4->NULL regressions held out by construction."""
        a = sqlite3.connect(f"file:{CMP_A}?mode=ro", uri=True)
        b = sqlite3.connect(f"file:{CMP_B}?mode=ro", uri=True)
        try:
            W = sp.window("depth_chart").predicate
            key = ["source_shape", "snapshot_ts", "source_ordinal", "season",
                   "week", "franchise_id", "espn_id", "depth_position", "unit"]
            val = ["gsis_source", "gsis_id", "full_name", "position", "depth_order"]
            nk = len(key)
            sel = ",".join(key + val)
            def load(c):
                return {r[:nk]: r[nk:] for r in c.execute(
                    f"SELECT {sel} FROM depth_chart WHERE {W}")}
            da, db_ = load(a), load(b)
            prov = [k for k in set(da) & set(db_)
                    if (da[k][0], db_[k][0]) in (("T1", "T0"), ("T3", "T0"))]
            self.assertGreater(len(prov), 500, "no provenance-only rows found")
            for k in prov:
                self.assertEqual(da[k][1:], db_[k][1:],
                                 "a provenance-only row moved something else")
        finally:
            a.close(); b.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
