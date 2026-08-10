#!/usr/bin/env python3
"""Tests for the frozen-vs-live season partition (lib/season_pins.py).

    python3 scripts/data/nfl-db/test_season_pins.py

Why this exists. build_db.py used to assert aggregate row counts with exact
equality -- `n_rs == 43856`, `n_dc == EXPECTED_TOTAL`. Those numbers were taken
from the 2026-07-27 extract, when the 2026 season had published nothing. The
moment upstream started serving 2026 rosters and depth charts, a fresh
`fetch_raw.py` + `build_db.py` run failed three of those assertions and exited 1
with no database written -- fail-closed on ordinary in-season growth.

The fix splits the assertion by season finality, so both properties hold at
once, and these tests pin BOTH:

  * settled history stays exact -- rewriting a closed season must still fail
    loudly, because that is what the corrections layer is for (PR #424);
  * the in-progress season is conserved, not pinned -- it may grow freely, but
    the loader is not allowed to silently drop its rows (the D6 defect: the
    original loader dropped all 554,215 shape-B rows).
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

import season_pins as sp  # noqa: E402


#: The built database as of the 2026-07-27 extract, per season. Real numbers.
DEPTH_CHART_0727 = {y: n for y, n in [
    (2010, 38421), (2011, 37941), (2012, 37312), (2013, 37066), (2014, 32542),
    (2015, 37058), (2016, 36612), (2017, 36620), (2018, 36560), (2019, 36308),
    (2020, 36168), (2021, 37487), (2022, 37780), (2023, 37327), (2024, 37312),
    (2025, 554215),
]}
ROSTER_0727 = {y: n for y, n in [
    (2010, 2152), (2011, 2099), (2012, 2120), (2013, 2137), (2014, 2153),
    (2015, 2190), (2016, 3061), (2017, 3082), (2018, 3142), (2019, 3114),
    (2020, 3068), (2021, 2961), (2022, 3134), (2023, 3090), (2024, 3216),
    (2025, 3137),
]}


class TestSplit(unittest.TestCase):
    def test_partitions_on_frozen_through(self):
        frozen, live = sp.split({2024: 10, 2025: 20, 2026: 30})
        self.assertEqual((frozen, live), (30, 30))

    def test_no_live_seasons_yields_zero(self):
        frozen, live = sp.split(ROSTER_0727)
        self.assertEqual(frozen, 43_856)
        self.assertEqual(live, 0)

    def test_frozen_through_is_the_last_settled_season(self):
        # 2025 ended 2026-02-08; 2026 kicks off 2026-09-10 and is still being
        # written. If this ever needs bumping it is a deliberate re-audit, not
        # a constant nudge to make a build pass.
        self.assertEqual(sp.FROZEN_THROUGH, 2025)


class TestFrozenVerdict(unittest.TestCase):
    """Settled history keeps exact equality -- the PR #424 property."""

    def test_frozen_match_passes(self):
        ok, _ = sp.frozen_verdict("roster_season", ROSTER_0727)
        self.assertTrue(ok)

    def test_frozen_match_passes_even_when_a_live_season_appears(self):
        # The exact bug: 2026 rosters (+2,930) showed up and the aggregate
        # assertion failed although settled history had not moved at all.
        with_2026 = {**ROSTER_0727, 2026: 2930}
        ok, _ = sp.frozen_verdict("roster_season", with_2026)
        self.assertTrue(ok)

    def test_rewritten_history_still_fails(self):
        # Non-negotiable: if upstream revises a closed season, the build must
        # still refuse. One row is enough.
        tampered = {**ROSTER_0727, 2018: ROSTER_0727[2018] + 1}
        ok, detail = sp.frozen_verdict("roster_season", tampered)
        self.assertFalse(ok)
        self.assertIn("43,857", detail)

    def test_a_dropped_frozen_season_fails(self):
        missing = {y: n for y, n in ROSTER_0727.items() if y != 2015}
        ok, _ = sp.frozen_verdict("roster_season", missing)
        self.assertFalse(ok)

    def test_every_pinned_table_is_covered(self):
        self.assertEqual(
            set(sp.FROZEN_COUNTS),
            {"player_game_stats", "snap_count", "roster_season", "depth_chart"},
        )

    def test_unknown_table_is_an_error_not_a_silent_pass(self):
        with self.assertRaises(KeyError):
            sp.frozen_verdict("no_such_table", {})


class TestLiveVerdict(unittest.TestCase):
    """The in-progress season is conserved, not pinned."""

    def test_growth_is_allowed(self):
        # 2026 depth charts went 0 -> 410,431 between Jul 27 and Aug 7.
        ok, _ = sp.live_verdict("depth_chart", db_live_rows=410_431,
                                source_live_rows=410_431)
        self.assertTrue(ok)

    def test_empty_live_season_is_allowed(self):
        # Before a season publishes anything, zero is the correct answer.
        ok, _ = sp.live_verdict("snap_count", db_live_rows=0, source_live_rows=0)
        self.assertTrue(ok)

    def test_silently_dropped_live_rows_fail(self):
        # The D6 defect, reproduced against the live span: the source had rows
        # and the loader kept none of them.
        ok, detail = sp.live_verdict("depth_chart", db_live_rows=0,
                                     source_live_rows=410_431)
        self.assertFalse(ok)
        self.assertIn("410,431", detail)

    def test_partial_loss_fails(self):
        ok, _ = sp.live_verdict("depth_chart", db_live_rows=410_430,
                                source_live_rows=410_431)
        self.assertFalse(ok)


class TestDepthChartShapes(unittest.TestCase):
    """depth_charts ships two schemas sharing only `gsis_id`; the shape split
    is pinned across frozen seasons only."""

    def test_frozen_shape_split_matches_the_audited_extract(self):
        self.assertEqual(sp.FROZEN_SHAPE_A, 552_514)   # 2010-2024, 15-col
        self.assertEqual(sp.FROZEN_SHAPE_B, 554_215)   # 2025 only, 12-col
        self.assertEqual(sp.FROZEN_SHAPE_A + sp.FROZEN_SHAPE_B,
                         sp.FROZEN_COUNTS["depth_chart"])

    def test_shape_a_is_frozen_history_only(self):
        # Shape A stopped at 2024 when nflverse changed the release format.
        # It must never grow again; if it does, history was rewritten.
        ok, _ = sp.frozen_shape_verdict(shape_a=552_514, shape_b=554_215)
        self.assertTrue(ok)
        ok, _ = sp.frozen_shape_verdict(shape_a=552_515, shape_b=554_215)
        self.assertFalse(ok)

    def test_frozen_shape_b_excludes_the_live_season(self):
        # 2026 rows are shape B too. They must NOT be counted against the
        # frozen shape-B pin -- that was the third failing assertion.
        ok, _ = sp.frozen_shape_verdict(shape_a=552_514, shape_b=554_215 + 410_431)
        self.assertFalse(ok, "live-season shape-B rows must be excluded first")


class TestDepthChartUsesTheSnapshotAxis(unittest.TestCase):
    """depth_chart must NEVER be partitioned by season. PR #433 did, and shipped
    a fix that still fail-closed on a clean clone.

    Shape-B rows carry no season column; it is derived from the snapshot `dt`
    against GameCalendar's dead-zone rule, which assigns season S up to the
    MIDPOINT between S's Super Bowl and S+1's opener -- boundary(2025) is
    2026-05-26. Upstream files those same snapshots in depth_charts_2026.csv.
    Measured against live nflverse on 2026-08-07, that disagreement puts
    179,903 of the 410,431 new rows into derived season 2025 -- inside the
    bucket the pins protect.
    """

    #: Measured 2026-08-07 by running the real classify_shape + normalize over
    #: the live depth_charts_2026.csv with the calendar built from nfl.db.
    LIVE_2026_FILE_BY_DERIVED_SEASON = {2025: 179_903, 2026: 230_528}

    def test_season_axis_is_refused_outright(self):
        with self.assertRaises(ValueError) as ctx:
            sp.frozen_verdict("depth_chart", DEPTH_CHART_0727)
        self.assertIn("snapshot", str(ctx.exception).lower())

    def test_the_season_axis_would_have_overcounted_the_frozen_bucket(self):
        # The bug, as arithmetic: season-keyed frozen = audited + 179,903.
        leaked = self.LIVE_2026_FILE_BY_DERIVED_SEASON[2025]
        season_keyed_frozen = sp.FROZEN_COUNTS["depth_chart"] + leaked
        self.assertNotEqual(season_keyed_frozen, sp.FROZEN_COUNTS["depth_chart"])
        self.assertEqual(season_keyed_frozen, 1_286_632)

    def test_snapshot_axis_passes_with_the_same_live_data(self):
        # Partitioned on the snapshot instant, the audited window is untouched
        # and every new row is live -- which is the truth.
        ok, detail = sp.frozen_counts_verdict(
            "depth_chart", frozen_rows=1_106_729, live_rows=410_431,
            basis=f"snapshot <= {sp.DEPTH_CHART_EXTRACT_CUTOFF}")
        self.assertTrue(ok, detail)
        self.assertIn("410,431 live rows excluded", detail)

    def test_a_changed_audited_row_still_fails(self):
        ok, _ = sp.frozen_counts_verdict("depth_chart", frozen_rows=1_106_730,
                                         live_rows=410_431)
        self.assertFalse(ok)

    def test_cutoff_is_the_audited_extract_boundary(self):
        # The last shape-B snapshot in the 2026-07-27 extract. Not a round
        # number and not a guess -- MAX(snapshot_ts) from the shipped database.
        self.assertEqual(sp.DEPTH_CHART_EXTRACT_CUTOFF, "2026-03-14T07:32:09Z")


class TestContentPins(unittest.TestCase):
    """A row COUNT cannot see a value change. On 2026-08-07 a clean-clone rebuild
    had 5,655 settled player_game_stats rows and 331 audited depth_chart rows with
    different CONTENT while every count matched and all 154 checks passed -- 316 of
    those had silently lost their gsis_id. These pin the content."""

    def test_every_pinned_table_has_a_digest(self):
        self.assertEqual(set(sp.CONTENT_DIGESTS), set(sp.FROZEN_COUNTS))

    def test_gsis_id_is_never_excluded(self):
        # The regression that started this: 316 audited rows lost their gsis_id
        # and every count still matched. Excluding gsis_id would re-open exactly
        # that hole, so this is the load-bearing assertion of the whole mechanism.
        for table, excluded in sp.CONTENT_DIGEST_EXCLUDE.items():
            self.assertNotIn("gsis_id", excluded,
                             f"{table}: excluding gsis_id would hide identity loss")

    def test_player_game_stats_excludes_only_derived_metrics(self):
        # Upstream recomputes these when its play-by-play models change; raw
        # counting stats and identities do not move. Anything else appearing here
        # is a loophole, not an exclusion.
        self.assertEqual(
            sp.CONTENT_DIGEST_EXCLUDE["player_game_stats"],
            {"passing_epa", "rushing_epa", "receiving_epa", "target_share",
             "air_yards_share", "fantasy_points", "fantasy_points_ppr"})

    def test_depth_chart_excludes_the_tier_label_but_not_the_identity(self):
        excl = sp.CONTENT_DIGEST_EXCLUDE["depth_chart"]
        self.assertIn("gsis_source", excl)   # which tier resolved it: may move
        self.assertNotIn("gsis_id", excl)    # what it resolved to: may not
        self.assertNotIn("espn_id", excl)

    def test_verdict_reports_when_unpinned_and_asserts_when_pinned(self):
        ok, detail = sp.content_verdict("no_such_table", "abc")
        self.assertIsNone(ok)
        self.assertIn("not yet pinned", detail)
        ok, _ = sp.content_verdict("depth_chart", sp.CONTENT_DIGESTS["depth_chart"])
        self.assertTrue(ok)
        # A CONTENT fault: right algorithm, wrong bytes. The detail must name
        # the pin the operator is supposed to investigate against.
        ok, detail = sp.content_verdict("depth_chart", "0" * 60 + "dead")
        self.assertFalse(ok)
        self.assertIn(sp.CONTENT_DIGESTS["depth_chart"], detail)
        # An ALGORITHM fault: a legacy-width digest. This is deliberately NOT
        # reported as a content mismatch -- quoting the expected pin here would
        # send an operator hunting for data corruption that has not happened.
        ok, detail = sp.content_verdict("depth_chart", "0000000000000000dead")
        self.assertFalse(ok)
        self.assertIn("legacy digest?", detail)
        self.assertNotIn(sp.CONTENT_DIGESTS["depth_chart"], detail)


class TestAgainstRealUpstream(unittest.TestCase):
    """The numbers measured against live nflverse on 2026-08-07."""

    #: roster_season keeps the season axis: its `season` is a literal CSV column.
    ROSTER_LIVE_0807 = {**ROSTER_0727, 2026: 2930}                   # 46,786

    def test_todays_upstream_passes_the_season_axis_tables(self):
        ok, detail = sp.frozen_verdict("roster_season", self.ROSTER_LIVE_0807)
        self.assertTrue(ok, detail)

    def test_todays_upstream_would_have_failed_the_old_aggregate_pin(self):
        # Documents the original regression (PR #433's motivation).
        self.assertNotEqual(sum(self.ROSTER_LIVE_0807.values()),
                            sp.FROZEN_COUNTS["roster_season"])
        self.assertEqual(sum(self.ROSTER_LIVE_0807.values()), 46_786)


if __name__ == "__main__":
    unittest.main(verbosity=2)
