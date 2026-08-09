"""Frozen-vs-live season partition for the build's row-count assertions.

THE PROBLEM THIS SOLVES. `build_db.py` asserted aggregate row counts with exact
equality -- `n_rs == 43856`, `n_dc == EXPECTED_TOTAL` -- and any failed check
exits 1 and unlinks the temp database. Those constants came from the 2026-07-27
extract, taken when the 2026 season had published nothing at all. `fetch_raw.py`
(PR #427) fetches 2010-2026, so the moment upstream started serving the 2026
season the aggregates moved and the build refused:

    roster_season   pinned    43,856   live    46,786   +2,930   (2026 rosters)
    depth_chart     pinned 1,106,729   live 1,517,160  +410,431  (2026 depth charts)

None of that is corruption. Settled history had not moved by a single row --
every season <= 2025 still matched the audited extract exactly. The assertion
was conflating two things that need opposite treatment:

  * SETTLED SEASONS are final. Pin them exactly. If a closed season's row count
    changes, upstream rewrote history and the build MUST fail loudly -- that is
    the whole point of the corrections layer (PR #424), and this module does not
    weaken it.
  * THE IN-PROGRESS SEASON is still being written. Rosters churn daily through
    camp; depth charts publish all season. Pinning it turns ordinary growth into
    a build failure, so it is CONSERVED instead: the loader must carry over
    every source row it was given, but it may be given more each day.

Conservation is the stronger check for live data anyway. The D6 defect was not a
wrong count -- it was the original loader silently dropping all 554,215 shape-B
rows. A source-vs-loaded comparison catches that at any volume; a magic number
only catches it until upstream moves.
"""
from __future__ import annotations

#: The last season whose data is final. 2025 ended 2026-02-08; 2026 kicks off
#: 2026-09-10 and is still being written.
#:
#: BUMPING THIS IS A DELIBERATE RE-AUDIT, NOT A CONSTANT NUDGE. When a season
#: closes, re-run the row-level audit over its rows (the process in PR #425),
#: then move this line and the counts below together. Bumping it to make a
#: failing build pass discards exactly the protection it exists to provide.
#:
#: APPLIES TO THREE OF THE FOUR TABLES ONLY. player_game_stats, snap_count and
#: roster_season read `season` from a literal CSV column that stops changing when
#: the season ends, so "season <= FROZEN_THROUGH" really does mean settled there.
#: depth_chart does not -- see DEPTH_CHART_EXTRACT_CUTOFF.
FROZEN_THROUGH = 2025

#: depth_chart is partitioned by SNAPSHOT INSTANT, not by season. This is not a
#: stylistic difference; partitioning it by season is a bug, and PR #433 shipped
#: that bug:
#:
#:   Shape-B rows carry no season column. `derive_season_week()` recovers one
#:   from the snapshot `dt` against GameCalendar's dead-zone rule, which assigns
#:   season S to everything up to the MIDPOINT between S's Super Bowl and S+1's
#:   opener -- boundary(2025) = 2026-05-26. Upstream, meanwhile, files those same
#:   snapshots in `depth_charts_2026.csv`. The two disagree by ~2 months, so
#:   179,903 rows that upstream calls 2026 derive to season 2025 and land in the
#:   bucket the pins protect. A season-keyed frozen bucket therefore keeps
#:   accepting new rows for ~3.5 months after the Super Bowl, and the build fails
#:   claiming closed history was rewritten.
#:
#: The snapshot instant has no such ambiguity. The audited 2026-07-27 extract
#: holds shape-B rows from 2025-08-03T10:09:07Z to exactly this value, so
#: "snapshot_ts <= cutoff" is precisely "was in the audited extract" -- which is
#: what the pin is actually asserting. Shape A carries snapshot_ts IS NULL and is
#: closed history by construction (nflverse retired that release format in 2025).
DEPTH_CHART_EXTRACT_CUTOFF = "2026-03-14T07:32:09Z"

#: Exact row counts over seasons <= FROZEN_THROUGH, from the 2026-07-27 extract
#: recorded in EXTRACT-NOTES.md and audited row-by-row in PR #425. Re-verified
#: against live nflverse on 2026-08-07: zero drift on every one of them.
FROZEN_COUNTS = {
    "player_game_stats": 286_843,
    "snap_count": 324_611,
    "roster_season": 43_856,
    "depth_chart": 1_106_729,
}

#: nflverse changed the depth-chart release format for 2025. The two schemas
#: share exactly one column (`gsis_id`): shape A (2010-2024) carries
#: season/week/club_code, shape B (2025+) carries dt/team/pos_*. Shape A is
#: closed history and can never grow again. Shape B spans 2025 (frozen) and
#: 2026+ (live), so only its frozen part is pinned.
FROZEN_SHAPE_A = 552_514   # 2010-2024, 15-col schema
FROZEN_SHAPE_B = 554_215   # 2025 only, 12-col schema


def split(counts_by_season, frozen_through=FROZEN_THROUGH):
    """Partition {season: rows} into (frozen_rows, live_rows).

    A NULL season is not a bucket -- it is a defect. The loader resolves a
    season for every row (depth_chart shape B recovers it from `dt` against the
    game calendar), so a None key means normalisation silently failed and the
    build should stop rather than quietly drop the rows from both totals.
    """
    frozen = live = 0
    for season, rows in counts_by_season.items():
        if season is None:
            raise ValueError(
                f"{rows:,} rows carry a NULL season -- normalisation failed; "
                "refusing to partition them into either bucket")
        if season <= frozen_through:
            frozen += rows
        else:
            live += rows
    return frozen, live


def frozen_counts_verdict(table, frozen_rows, live_rows=0, basis="settled seasons"):
    """Exact equality against an ALREADY-partitioned pair. Returns (ok, detail).

    Callers that cannot partition by season -- depth_chart, whose season is
    derived -- partition on their own axis and come here. Raises KeyError for a
    table with no pin, so adding a table to the build without pinning it is a
    loud error rather than a silent pass.
    """
    expected = FROZEN_COUNTS[table]
    ok = frozen_rows == expected
    detail = f"{frozen_rows:,} vs {expected:,} pinned ({basis})"
    if live_rows:
        detail += f"; {live_rows:,} live rows excluded"
    return ok, detail


def frozen_verdict(table, counts_by_season, frozen_through=FROZEN_THROUGH):
    """Exact equality over settled seasons, partitioning by the `season` column.

    Valid ONLY for tables whose season is a literal CSV column: player_game_stats,
    snap_count, roster_season. depth_chart must not use this -- its season is
    derived, so the bucket stays open past the season's end (see
    DEPTH_CHART_EXTRACT_CUTOFF); it uses frozen_counts_verdict instead.
    """
    if table == "depth_chart":
        raise ValueError(
            "depth_chart's season is derived from the snapshot instant, so a "
            "season-keyed frozen bucket keeps accepting rows for months after the "
            "season ends. Partition on snapshot_ts against "
            "DEPTH_CHART_EXTRACT_CUTOFF and call frozen_counts_verdict instead.")
    frozen, live = split(counts_by_season, frozen_through)
    return frozen_counts_verdict(table, frozen, live,
                                 basis=f"<={frozen_through}")


def live_verdict(table, db_live_rows, source_live_rows):
    """Conservation over the in-progress seasons. Returns (ok, detail).

    Not a pinned count and not a floor: whatever the source served for a live
    season, the database must hold. Growth is free; loss is a defect.
    """
    ok = db_live_rows == source_live_rows
    detail = f"{db_live_rows:,} loaded vs {source_live_rows:,} in source"
    if not ok:
        detail += f" -- {source_live_rows - db_live_rows:+,} rows lost in load"
    return ok, detail


#: Columns excluded from the frozen-window CONTENT digest, per table, with the
#: reason each is allowed to move. Everything NOT listed here is pinned by
#: content, not merely by row count.
#:
#: WHY THIS EXISTS. The frozen checks were count-only, and a count cannot see a
#: value change. Measured 2026-08-07 against a clean-clone rebuild: 5,655 rows of
#: settled player_game_stats and 331 rows of the audited depth_chart window had
#: DIFFERENT CONTENT while every count matched and all 154 checks passed. 316 of
#: those depth_chart rows had silently lost their gsis_id. A count-only gate
#: cannot distinguish that from a perfect reproduction.
#:
#: The exclusions are not a loophole -- they are the line between what upstream
#: OWNS and what it merely REPORTS. nflverse recomputes EPA and usage shares
#: whenever its play-by-play models change; those are derived estimates and they
#: legitimately move. Identities, teams, games and raw counting stats do not.
CONTENT_DIGEST_EXCLUDE = {
    "depth_chart": {
        # Which crosswalk TIER resolved an identity, not the identity itself.
        # Legitimately moves as upstream player data improves (T3->T0 for 1,375
        # rows on 2026-08-07). gsis_id IS pinned, so a lost or changed identity
        # still fails -- which is exactly the 316-row regression this catches.
        "gsis_source",
        "depth_chart_id",   # surrogate, assignment order
    },
    "player_game_stats": {
        # nflverse-computed advanced metrics. Recomputed upstream on model
        # revision: 2,059 / 1,706 / 1,043 / 702 / 275 / 10 / 10 rows moved
        # between the 2026-07-27 extract and 2026-08-07 with ZERO change to any
        # raw counting stat and ZERO change to row identity.
        "passing_epa", "rushing_epa", "receiving_epa",
        "target_share", "air_yards_share",
        "fantasy_points", "fantasy_points_ppr",
    },
    # Surrogate row ids: assignment artefacts, not content. Verified against
    # PRAGMA table_info rather than guessed -- snap_count has none (its PK is
    # the natural pair pfr_player_id+pfr_game_id).
    "snap_count": set(),
    "roster_season": {"roster_row_id"},
}

#: sha256 (first 20 hex chars) of the frozen window's pinned columns, ordered by
#: the table's natural key. Computed from a clean-clone build against live
#: nflverse. Regenerate with: python3 scripts/data/nfl-db/content_digest.py
#:
#: A digest mismatch means settled history CHANGED, not merely that a count
#: moved. Treat it the way you would treat a failed count pin: investigate what
#: moved before touching this constant.
CONTENT_DIGESTS = {
    # From a clean-clone build against live nflverse, 2026-08-08, with the T4
    # identity file present (see build_db.py's T4 block -- without it these are
    # NOT reproducible, which is the whole reason that file is tracked now).
    "depth_chart": "d165550d624c6ccaf397",        # 1,106,729 rows, 23 pinned cols
    "player_game_stats": "c30625670748f488ff35",  #   286,843 rows, 22 pinned cols
    "snap_count": "ea44a47fecfeb0af8683",         #   324,611 rows, 19 pinned cols
    "roster_season": "4c610696494640288603",      #    43,856 rows, 15 pinned cols
}


def content_digest(conn, table, where, _key_cols=None):
    """Stable content hash of a frozen window's pinned columns.

    ORDER BY is the FULL hashed column list, deliberately. SQL leaves the order
    among ties unspecified, so ordering by a partial key would make the digest
    vary run-to-run on identical data -- a flaky gate is worse than no gate. A
    first attempt ordered depth_chart by its natural key and 545,225 of the
    1,106,729 audited rows landed in 51,280 tied groups (shape A repeats a
    player at a slot every week), which would have pinned a coin flip.

    Ordering by every hashed column removes the problem instead of working
    around it: two rows that tie are by definition IDENTICAL in the projection
    being hashed, so their relative order cannot change the result. No unique key
    is needed, and none has to be maintained as the schema evolves.

    `_key_cols` is accepted and ignored so existing call sites stay valid.
    """
    import hashlib
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    keep = [c for c in cols if c not in CONTENT_DIGEST_EXCLUDE.get(table, set())]
    projection = ", ".join(keep)
    h = hashlib.sha256()
    n = 0
    for row in conn.execute(
            f"SELECT {projection} FROM {table} WHERE {where} ORDER BY {projection}"):
        h.update(repr(row).encode())
        n += 1
    return h.hexdigest()[:20], n, keep


def content_verdict(table, digest):
    """(ok, detail) for a frozen-window content digest. Unpinned tables report."""
    want = CONTENT_DIGESTS.get(table)
    if want is None:
        return None, f"{digest} (not yet pinned)"
    return digest == want, f"{digest} vs {want} pinned"


def frozen_shape_verdict(shape_a, shape_b):
    """depth_chart shape split across FROZEN seasons only. Returns (ok, detail).

    Callers must pass shape-B counts for seasons <= FROZEN_THROUGH; live-season
    rows are shape B as well and belong to live_verdict, not here.
    """
    ok = (shape_a, shape_b) == (FROZEN_SHAPE_A, FROZEN_SHAPE_B)
    return ok, (f"A={shape_a:,} (pinned {FROZEN_SHAPE_A:,}) "
                f"B={shape_b:,} (pinned {FROZEN_SHAPE_B:,})")
