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


# ===========================================================================
# THE CANONICAL FROZEN-WINDOW REGISTRY
# ===========================================================================
# WHY. The constants above were already central, but the PREDICATES were not:
# build_db.py and content_digest.py each wrote their own WHERE clause and their
# own column list for the same four contracts. A correct hash over the wrong
# population is still wrong, and two independently-maintained definitions of one
# contract will eventually disagree -- silently, because both look right in
# isolation. This registry is the single authority both paths consume.
#
# AXES ARE NOT INTERCHANGEABLE. player_game_stats / snap_count / roster_season
# read `season` from a literal CSV column that stops changing when the season
# ends. depth_chart does not: its shape-B rows carry no season, so it is derived
# from the snapshot instant against the game calendar, and a season-keyed freeze
# there keeps absorbing rows for ~3.5 months after a season ends. That was the
# #433 defect. The registry therefore models the axis explicitly rather than
# assuming one column name fits every table.

AXIS_SEASON = "season"        # literal CSV season column; settles at season end
AXIS_SNAPSHOT = "snapshot"    # audited snapshot instant; immune to the calendar rule

#: Lifecycle of an integrity surface, so a planned mechanism is never mistaken
#: for an enforced one.
ACTIVE = "active"                 # enforced by the build today
TRANSITIONAL = "transitional"     # enforced today, known to need replacement
PLANNED = "planned"               # specified, deliberately NOT yet enforced
OBSERVATIONAL = "observational"   # measured and reported, never blocking


class FrozenWindow:
    """One governed frozen population. The only place its predicate exists."""

    #: NOTE ON PROJECTION. A `key_cols` field lived here briefly and was dead
    #: metadata: content_digest() orders by the FULL hashed projection (see its
    #: docstring), so an ordering key affects nothing. Dead metadata inside a
    #: registry that claims to be the single authority is a trap -- someone will
    #: edit it believing it matters. The real projection authority is
    #: CONTENT_DIGEST_EXCLUDE: projection = all columns minus that table's
    #: exclusions, computed in one place. A mutation test proves it.
    __slots__ = ("table", "axis", "predicate", "expected_count",
                 "why_axis", "live_predicate")

    def __init__(self, table, axis, predicate, expected_count, why_axis,
                 live_predicate=None):
        self.table = table
        self.axis = axis
        self.predicate = predicate
        self.expected_count = expected_count
        self.why_axis = why_axis
        self.live_predicate = live_predicate

    def __repr__(self):
        return f"FrozenWindow({self.table}, axis={self.axis})"


FROZEN_WINDOWS = {
    "depth_chart": FrozenWindow(
        table="depth_chart",
        axis=AXIS_SNAPSHOT,
        predicate=f"(source_shape='A' OR snapshot_ts <= '{DEPTH_CHART_EXTRACT_CUTOFF}')",
        live_predicate=f"(source_shape='B' AND snapshot_ts > '{DEPTH_CHART_EXTRACT_CUTOFF}')",
        expected_count=1_106_729,
        why_axis="shape-B rows carry no season column; it is derived from `dt` "
                 "against the game calendar's dead-zone rule, so a season-keyed "
                 "window stays open ~3.5 months past the Super Bowl. The snapshot "
                 "instant is exactly 'was in the audited extract'."),

    "player_game_stats": FrozenWindow(
        table="player_game_stats", axis=AXIS_SEASON,
        predicate=f"season <= {FROZEN_THROUGH}",
        live_predicate=f"season > {FROZEN_THROUGH}",
        expected_count=286_843,
        why_axis="`season` is a literal column in the upstream extract and stops "
                 "changing when the season ends."),

    "snap_count": FrozenWindow(
        table="snap_count", axis=AXIS_SEASON,
        predicate=f"season <= {FROZEN_THROUGH}",
        live_predicate=f"season > {FROZEN_THROUGH}",
        expected_count=324_611,
        why_axis="literal season column, as above."),

    "roster_season": FrozenWindow(
        table="roster_season", axis=AXIS_SEASON,
        predicate=f"season <= {FROZEN_THROUGH}",
        live_predicate=f"season > {FROZEN_THROUGH}",
        expected_count=43_856,
        why_axis="literal season column, as above."),
}


#: The integrity SURFACES over those populations, with honest lifecycle state.
#: depth_chart's provenance-aware replacement is specified here so later phases
#: can finish the migration WITHOUT inventing a second population definition --
#: which is the failure this registry exists to prevent.
#:
#: Measured populations backing the depth_chart layers (two clean-clone builds):
#:     frozen window            1,106,729
#:       shape A, feed-supplied   552,514   multiset identical between builds
#:       shape B, feed-supplied   548,638   0 gsis_id changes
#:       shape B, crosswalk-derived 5,229
#:       shape B, unresolved          348
#:     Layer B total            1,101,152  (99.50%)   Layer C  5,577 -> 204 mappings
INTEGRITY_SURFACES = {
    "depth_chart": {
        "legacy_content_digest": {
            "status": TRANSITIONAL,
            "note": "hashes crosswalk-DERIVED gsis_id as if it were immutable "
                    "source history. Measured non-stationary: 15 identities were "
                    "legitimately gained between two correct builds. Known to be "
                    "the wrong final mechanism; replaced by layers A/B/C. MUST "
                    "NOT ship as the Session 2 design.",
        },
        "layer_a_raw_facts": {
            "status": PLANNED,
            "population": "the full frozen window",
            "note": "blocking digest over columns whose semantics are stationary.",
        },
        "layer_b_source_identity": {
            "status": PLANNED,
            "population": "frozen window AND gsis_source='feed'  (1,101,152 rows)",
            "note": "source-owned identity, proven stationary across two builds. "
                    "The predicate selects on the PROVENANCE LABEL, so its safety "
                    "rests on a measured fact, not a definition: no row was "
                    "observed crossing the feed<->derived boundary. If a crossing "
                    "is ever observed, this surface must be re-derived, not "
                    "patched.",
        },
        "layer_c_derived_identity": {
            "status": PLANNED,
            "population": "204 canonical espn_id mappings, not 5,577 row copies",
            "note": "accepted-baseline state machine; artifacts exist but are "
                    "deliberately uncommitted until their own phase.",
        },
        "provenance": {
            "status": OBSERVATIONAL,
            "field": "gsis_source",
            "note": "describes the CURRENT derivation path, not history. 1,059 "
                    "legitimate transitions measured between two correct builds.",
        },
    },
}


def projection(conn, table):
    """The pinned column list for a table: every column minus its documented
    exclusions. ONE authority, so enforcement and generation cannot hash
    different fields."""
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    return [c for c in cols if c not in CONTENT_DIGEST_EXCLUDE.get(table, set())]


def window(table):
    """The one authority. KeyError for an unregistered table is deliberate:
    a governed contract with no registry entry must be a loud error."""
    return FROZEN_WINDOWS[table]


def governed_tables():
    return tuple(FROZEN_WINDOWS)


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
        #
        # EVIDENCE CORRECTION (2026-08-08). An earlier comment here claimed
        # "T3->T0 for 1,375 rows". That figure was measured against the BROKEN
        # no-T4 build, so roughly 316 rows of the apparent movement were
        # contamination from the missing-T4 defect itself, and it named the wrong
        # dominant transition. Re-measured full-population between two correct
        # builds:
        #
        #     total provenance transitions   1,059
        #       T1 -> T0                       881    <- the dominant movement
        #       T3 -> T0                       163
        #       NULL -> T0                      15
        #
        # gsis_id is NOT excluded here, so a lost or changed identity still fails
        # -- which is exactly the 316-row regression this distinction protects.
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

#: Full SHA-256 (all 64 hex chars) over the DIGEST_ALGORITHM serialization of a
#: frozen window's pinned columns, ordered by the full hashed projection.
#: Regenerate with: python3 scripts/data/nfl-db/content_digest.py
#:
#: A digest mismatch means settled history CHANGED, not merely that a count
#: moved. Treat it the way you would treat a failed count pin: investigate what
#: moved before touching this constant.
CONTENT_DIGESTS = {
    # From a clean-clone build against live nflverse, 2026-08-08, with the T4
    # identity file present (see build_db.py's T4 block -- without it these are
    # NOT reproducible, which is the whole reason that file is tracked now).
    "depth_chart":
        "cf0e5b7749e2c07858f51f6670840017650713cfe4b01177f94f02ba5fc311b1",
    "player_game_stats":
        "86f772898f7afc159e38ef729ab9714150100bacd3fd226e9304949f13a0bfbc",
    "snap_count":
        "117acf47dd3a875ed177139aba27dc5663947d7627a8a455ceb2a3b27fbd386a",
    "roster_season":
        "8e87bc733dc0820464b7d35dd829c2864600185dcadbf8c4f7284faf0fef7c2a",
}

#: The pre-Phase-4 repr() digests over the SAME accepted content, at full width.
#:
#: These are not a fallback. They are the migration's evidence: Phase 4 replaced
#: the serializer, and the only way to show that swap did not quietly change
#: WHAT is protected is to keep proving the old function still reproduces its
#: own accepted answer over today's rows. test_canonical_digest recomputes both
#: hashes from a single cursor -- if content ever drifts, the legacy hash moves
#: too, and "the digest changed because we changed the hashing code" stops being
#: available as an excuse.
#:
#: The Phase-3 pins were the first 20 chars of exactly these values; that
#: prefix relationship was verified before any constant was rewritten.
LEGACY_CONTENT_DIGESTS = {
    "depth_chart":
        "d165550d624c6ccaf397142b679b03a9acfd4641071fc8efbb2d67efa0bf47be",
    "player_game_stats":
        "c30625670748f488ff35dbb4a838c820effb957cb7a34171ef582e885df75140",
    "snap_count":
        "ea44a47fecfeb0af86832837a1c9d985e9f0021fb1c36d1244fa6458ffdb583e",
    "roster_season":
        "4c610696494640288603e7f7c486e6402bd06b7e6029af34e4619d0af225e1dc",
}


# --------------------------------------------------------------------------
# Canonical digest serialization  (Phase 4)
# --------------------------------------------------------------------------
# Digests through Phase 3 hashed `repr(row)` and stored 20 of 64 hex chars.
# That was never shown to collide -- an attempt to construct one failed, and
# repr appears injective over fixed-arity SQLite value tuples. It was replaced
# because its correctness rested on properties nothing enforced:
#
#   D2  no schema binding.  The stream carried VALUES ONLY. Two rows [1,'a'] are
#       hashed identically whether the columns are (id, name) or (week, team),
#       so renaming or repurposing a column was invisible to the pin.  <- the
#       decisive defect; demonstrated, not argued.
#   D3  unframed row stream.  Rows were concatenated with no separator and no
#       count, so "the stream cannot be reparsed two ways" was an argument about
#       balanced parentheses rather than a property of the encoding.
#   D4  80-bit commitment.  hexdigest()[:20] discarded 176 of 256 bits.
#   D5  repr() is a debugging function with no cross-interpreter stability
#       contract, and it collapses every NaN payload to the token 'nan'.
#   D6  unversioned.  A legacy pin and a canonical pin were indistinguishable
#       strings, so an algorithm swap could not be detected by inspection.
#
# The replacement is a prefix-free TLV encoding: every element carries a type
# tag and an explicit length, so the byte stream is DECODABLE. Injectivity is
# then a property of the format -- proven by exhibiting decode_canonical() and
# round-tripping the real corpus -- rather than a property we hope repr has.
DIGEST_ALGORITHM = "nfldb-canon-1"

_TAG_NULL = b"N"
_TAG_INT = b"I"
_TAG_REAL = b"F"
_TAG_TEXT = b"S"
_TAG_BLOB = b"B"
_TAG_ROW = b"R"
_TAG_HEADER = b"H"
_TAG_FOOTER = b"Z"


def _frame(payload: bytes) -> bytes:
    """Length-prefixed field. 8-byte big-endian length makes the stream self-
    delimiting, which is what buys decodability (and therefore injectivity)."""
    return len(payload).to_bytes(8, "big") + payload


def encode_value(v) -> bytes:
    """One SQLite value -> canonical bytes. Type tag is part of the stream, so
    1, 1.0 and '1' can never share an encoding regardless of the hash."""
    import struct
    if v is None:
        return _TAG_NULL + _frame(b"")
    if isinstance(v, bool):                       # sqlite3 never yields bool;
        raise TypeError("bool is not a SQLite storage class")   # fail loud
    if isinstance(v, int):
        # Fixed 8-byte two's complement: minimal-length encoding would admit
        # sign-extended variants of the same integer, i.e. non-canonical forms.
        try:
            return _TAG_INT + _frame(v.to_bytes(8, "big", signed=True))
        except OverflowError as exc:
            raise ValueError(f"integer outside SQLite INTEGER range: {v}") from exc
    if isinstance(v, float):
        # IEEE-754 big-endian: interpreter-independent, unlike repr() (D5).
        return _TAG_REAL + _frame(struct.pack(">d", v))
    if isinstance(v, str):
        return _TAG_TEXT + _frame(v.encode("utf-8"))   # raises on lone surrogates
    if isinstance(v, (bytes, bytearray)):
        return _TAG_BLOB + _frame(bytes(v))
    raise TypeError(f"unencodable storage class {type(v).__name__}")


def canonical_header(table: str, where: str, cols) -> bytes:
    """Binds algorithm, table, population predicate and the ORDERED column NAMES
    into the hash. This is the fix for D2: the digest now commits to which
    columns produced the values, not merely to the values."""
    out = _TAG_HEADER + _frame(DIGEST_ALGORITHM.encode("utf-8"))
    out += _frame(table.encode("utf-8")) + _frame(where.encode("utf-8"))
    out += len(cols).to_bytes(4, "big")
    for c in cols:
        out += _frame(c.encode("utf-8"))
    return out


def canonical_row(row) -> bytes:
    """One row: tag, field count, then each length-framed field."""
    out = _TAG_ROW + len(row).to_bytes(4, "big")
    for v in row:
        out += encode_value(v)
    return out


def canonical_footer(n: int) -> bytes:
    """Binds the population SIZE, so a digest over N rows can never equal one
    over a prefix of those rows (D3)."""
    return _TAG_FOOTER + n.to_bytes(8, "big")


def decode_canonical(blob: bytes):
    """Inverse of the encoder -> (algorithm, table, where, cols, rows).

    This exists to be RUN, not to be read: a stream that decodes back to exactly
    the input is by definition an injective encoding of it. test_canonical_digest
    round-trips the full governed corpus through it.
    """
    import struct
    p = 0

    def take(n):
        nonlocal p
        if p + n > len(blob):
            raise ValueError(f"truncated stream at byte {p}")
        p += n
        return blob[p - n:p]

    def framed():
        return take(int.from_bytes(take(8), "big"))

    if take(1) != _TAG_HEADER:
        raise ValueError("missing canonical header")
    algo = framed().decode("utf-8")
    table = framed().decode("utf-8")
    where = framed().decode("utf-8")
    cols = [framed().decode("utf-8") for _ in range(int.from_bytes(take(4), "big"))]
    rows = []
    while True:
        tag = take(1)
        if tag == _TAG_FOOTER:
            n = int.from_bytes(take(8), "big")
            if n != len(rows):
                raise ValueError(f"footer claims {n} rows, decoded {len(rows)}")
            if p != len(blob):
                raise ValueError("trailing bytes after footer")
            return algo, table, where, cols, rows
        if tag != _TAG_ROW:
            raise ValueError(f"unexpected tag {tag!r} at byte {p - 1}")
        vals = []
        for _ in range(int.from_bytes(take(4), "big")):
            t = take(1)
            payload = framed()
            if t == _TAG_NULL:
                vals.append(None)
            elif t == _TAG_INT:
                vals.append(int.from_bytes(payload, "big", signed=True))
            elif t == _TAG_REAL:
                vals.append(struct.unpack(">d", payload)[0])
            elif t == _TAG_TEXT:
                vals.append(payload.decode("utf-8"))
            elif t == _TAG_BLOB:
                vals.append(payload)
            else:
                raise ValueError(f"unknown value tag {t!r}")
        rows.append(tuple(vals))


def content_digest(conn, table, where):
    """Canonical content hash of a frozen window's pinned columns. Full SHA-256.

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

    The projection comes from projection() -- the single field authority.
    """
    import hashlib
    keep = globals()["projection"](conn, table)
    proj_sql = ", ".join(keep)
    h = hashlib.sha256()
    h.update(canonical_header(table, where, keep))
    n = 0
    for row in conn.execute(
            f"SELECT {proj_sql} FROM {table} WHERE {where} ORDER BY {proj_sql}"):
        h.update(canonical_row(row))
        n += 1
    h.update(canonical_footer(n))
    return h.hexdigest(), n, keep


def legacy_content_digest(conn, table, where):
    """The pre-Phase-4 repr() digest, retained ONLY as migration evidence.

    Not a fallback and not a second authority: nothing in the build calls it.
    test_canonical_digest uses it to keep proving that the content protected by
    the canonical pins is the same content the legacy pins accepted -- the claim
    Phase 4 rests on. Deleting it would make that claim unfalsifiable.
    """
    import hashlib
    keep = globals()["projection"](conn, table)
    proj_sql = ", ".join(keep)
    h = hashlib.sha256()
    n = 0
    for row in conn.execute(
            f"SELECT {proj_sql} FROM {table} WHERE {where} ORDER BY {proj_sql}"):
        h.update(repr(row).encode())
        n += 1
    return h.hexdigest(), n, keep


def content_verdict(table, digest):
    """(ok, detail) for a frozen-window content digest. Unpinned tables report."""
    want = CONTENT_DIGESTS.get(table)
    if want is None:
        return None, f"{digest} (not yet pinned)"
    # D6: a truncated legacy-width digest must not be silently compared against
    # a canonical pin -- it can only ever mismatch, which would read as data
    # corruption instead of "you are running the old algorithm".
    if len(digest) != 64:
        return False, (f"{digest} is {len(digest)} hex chars; {DIGEST_ALGORITHM} "
                       f"pins are full 64-char SHA-256 (legacy digest?)")
    return digest == want, f"{digest} vs {want} pinned"


def frozen_shape_verdict(shape_a, shape_b):
    """depth_chart shape split across FROZEN seasons only. Returns (ok, detail).

    Callers must pass shape-B counts for seasons <= FROZEN_THROUGH; live-season
    rows are shape B as well and belong to live_verdict, not here.
    """
    ok = (shape_a, shape_b) == (FROZEN_SHAPE_A, FROZEN_SHAPE_B)
    return ok, (f"A={shape_a:,} (pinned {FROZEN_SHAPE_A:,}) "
                f"B={shape_b:,} (pinned {FROZEN_SHAPE_B:,})")
