#!/usr/bin/env python3
"""Load the unified NFL dataset (games + lines + team-game + player level) into
a constrained SQLite database and prove its integrity four independent ways.

The passes are deliberately different in METHOD. A check that agrees with
itself proves nothing.

  PASS 1 - STRUCTURAL. Does the database defend itself? Constraints are probed
           by attempting writes that must fail; FKs, indexes and views are
           inspected directly. Includes a NEGATIVE CONTROL for foreign-key
           enforcement itself (D22): the pragma is per-connection and is never
           persisted, so "declared" and "enforced" are different claims.
  PASS 2 - RECONCILIATION. Does the database agree with the files it came from?
           SQL aggregates are compared against the JSON/CSV inputs row by row.
           EVERY GATE IN THIS PASS IS AN ABSOLUTE ASSERTION AGAINST THE BUILT
           DATABASE. There are no percentage thresholds anywhere in this file:
           the prior build shipped 227 orphan snap rows behind a ">=95%" gate
           that passed at 99.93% (D4, CONTEXT.md standing rule 2).
  PASS 2b - ROW LOSS. lib/rowloss.py, wired in as a gate. Every source row is
           loaded or on a named exception manifest. There is no third state.
  PASS 3 - EXTERNAL. Does it agree with upstream nflverse? Data is re-fetched
           live via R and compared against SQL, independent of every
           intermediate artifact this pipeline produced.

Modules are wired in the order B5 proved is load-bearing:
  player_dimension -> team_aliases -> snap_crosswalk -> depth_charts -> rowloss
The player dimension must be first: 00-0039856 is one of the snap crosswalk's
targets and does not exist in the players.csv-only dimension, so loading the
crosswalk first would re-orphan it.

Run: python3 scripts/data/nfl-db/build_db.py
Exits non-zero on any failure and never leaves a half-built database in place.
"""

import csv
import datetime as dt
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
HERE = os.path.join(ROOT, "scripts/data/nfl-db")
LIB = os.path.join(HERE, "lib")
RAW = os.path.join(HERE, "raw")
SCHEMA = os.path.join(HERE, "schema.sql")
DB_PATH = os.path.join(HERE, "nfl.db")
UNIFIED = os.path.join(ROOT, "scripts/data/nfl-unified-2010-2026/games.json")
HIST = os.path.join(ROOT, "scripts/data/nfl-lines-2010-2025/games.json")
NEW = os.path.join(ROOT, "scripts/data/nfl-2026/games.json")
TEAMS = os.path.join(ROOT, "scripts/data/nfl-2026/teams.json")
VENUES = os.path.join(ROOT, "scripts/data/nfl-2026/venues.json")

if LIB not in sys.path:
    sys.path.insert(0, LIB)

import build_inputs                    # noqa: E402  the canonical build-input contract
import build_provenance                # noqa: E402  binds this DB to its input bytes
import corrections                     # noqa: E402  data corrections, each asserting its prior
import espn_identities                 # noqa: E402  the ONE T4 loader/validator
import identity_baseline                # noqa: E402  Layer C: accepted derived identity
import identity_layers                  # noqa: E402  Layers A/B: facts + source identity
import depth_charts as depth_lib       # noqa: E402  B3
import player_dimension                # noqa: E402  B5
import rowloss                         # noqa: E402  B4
import season_pins                     # noqa: E402  frozen history vs in-progress season
import snap_crosswalk                  # noqa: E402  B1
import team_aliases                    # noqa: E402  B2

csv.field_size_limit(10 ** 9)

# `nfl.db` spans 2010-2026 only. team_aliases.SEASON_DEPENDENT resolves the
# era-split abbreviations across all of NFL history; inside this window each has
# exactly one referent, and these are the three that appear in the feeds.
ERA_ALIASES_IN_WINDOW = {
    "HOU": (34, "Houston Texans, 2002-present (Oilers <=1996 were franchise 10)"),
    "BAL": (33, "Baltimore Ravens, 1996-present (Colts <=1983 were franchise 11)"),
    "STL": (14, "St. Louis Rams, 1995-2015 (Cardinals <=1987 were franchise 22)"),
}

DB_WINDOW_FIRST_SEASON = 2010
DB_WINDOW_LAST_SEASON = 2026

results = []


def check(p, name, ok, detail=""):
    results.append((p, name, ok, detail))
    print(f"    [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail and not ok else ""))
    return ok


def report(name, detail):
    """State a fact without asserting it. Used for the in-progress season, whose
    row count is not knowable in advance and must not gate the build."""
    print(f"    [INFO] {name} -- {detail}")


def per_season(conn, table):
    """{season: rows} for a fact table. Feeds season_pins' frozen/live split."""
    return {s: n for s, n in
            conn.execute(f"SELECT season, COUNT(*) FROM {table} GROUP BY season")}


def connect(path):
    """Every connection in this loader, without exception.

    D22: `PRAGMA foreign_keys` is a PER-CONNECTION setting that SQLite never
    persists in the database file. A schema full of REFERENCES clauses is
    decorative until a connection asks for enforcement, and the shipped database
    reads back `PRAGMA foreign_keys -> 0` for exactly that reason. This helper
    turns it on and refuses to hand back a connection where it did not take.
    """
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        conn.close()
        raise RuntimeError(f"PRAGMA foreign_keys did not take on {path}")
    return conn


def load_json(p):
    with open(p) as fh:
        return json.load(fh)


def read_csv(path):
    if not os.path.exists(path):
        return None
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        return list(csv.DictReader(fh))


def stream_csv(path):
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            yield row


def pick(row, *names):
    """First present, non-empty column among `names` (schema-drift tolerant)."""
    for n in names:
        if n in row and row[n] not in ("", None):
            return row[n]
    return None


def as_int(v):
    if v in (None, "", "NA"):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def as_real(v):
    if v in (None, "", "NA"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# week / playoff_round encoding, shared by every player-level feed.
#
# nflverse publishes a CONTINUOUS 1..22 week counter plus a game_type of
# REG/WC/DIV/CON/SB. The schema convention is REG/POST + playoff_round with
# week NULL in the postseason (D8, D20). Both are stored: the derived pair to
# join on, the source pair so reconciliation against nflverse stays byte-exact.
# --------------------------------------------------------------------------
GAME_TYPE_TO_ROUND = {"WC": "WC", "DIV": "DIV", "CON": "CON", "SB": "SB"}


def encode_week(source_game_type, source_week):
    """(season_type, week, playoff_round) from nflverse's (game_type, week)."""
    if source_game_type == "REG":
        return "REG", source_week, None
    rnd = GAME_TYPE_TO_ROUND.get(source_game_type)
    if rnd is None:
        raise ValueError(f"unmapped game_type {source_game_type!r}")
    return "POST", None, rnd


# =========================================================== build
def build(conn, rows, teams, venues):
    with open(SCHEMA) as fh:
        conn.executescript(fh.read())
    # executescript() commits and can reset connection state; re-assert.
    conn.execute("PRAGMA foreign_keys = ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise RuntimeError("PRAGMA foreign_keys lost across executescript()")

    counts = {}

    # ---- team + team_alias (B2) --------------------------------------------
    conn.executemany("INSERT INTO team VALUES (?,?,?,?,?)",
                     [(t["espnId"], t["abbreviation"], t["displayName"],
                       t["conference"], t["division"]) for t in teams])
    espn_current = set(team_aliases.ESPN_ABBR.values())
    alias_rows = [(a, fid, int(a in espn_current), None)
                  for a, fid in sorted(team_aliases.ALIASES.items())]
    alias_rows += [(a, fid, int(a in espn_current), note)
                   for a, (fid, note) in sorted(ERA_ALIASES_IN_WINDOW.items())]
    conn.executemany("INSERT INTO team_alias VALUES (?,?,?,?)", alias_rows)
    counts["team_alias"] = len(alias_rows)

    def fid(abbr, season=None):
        """D3: raises on anything unknown. The old loader used dict.get() and a
        silent None, which is how an unmapped abbreviation becomes a NULL team."""
        return team_aliases.resolve(abbr, season)

    # ---- STEP 1: player dimension (B5) -------------------------------------
    # MUST BE FIRST. `game` FKs the QB ids, and every fact table FKs gsis_id.
    dimension = player_dimension.build_player_dimension(
        os.path.join(RAW, "players.csv"), os.path.join(RAW, "rosters.csv"))
    dimension = corrections.apply_player_corrections(dimension)
    # The depth-chart feed reaches rookies before players.csv does, under an
    # ESPN-style id rather than a real gsis. depth_chart FKs this table, so
    # without them the build dies on an IntegrityError long before any check.
    n_players_csv = sum(1 for _ in stream_csv(os.path.join(RAW, "players.csv")))
    counts["player_roster_derived"] = len(dimension) - n_players_csv
    dimension, feed_only = player_dimension.add_feed_identities(
        dimension,
        ({"gsis_id": pick(r, "gsis_id"),
          "display_name": pick(r, "player_name", "full_name"),
          "position": pick(r, "pos_abb", "position")}
         for r in stream_csv(os.path.join(RAW, "depth_charts.csv"))))
    counts["player_feed_only"] = len(feed_only)
    canonical = player_dimension.CANONICAL_GSIS
    known_players = {r["gsis_id"] for r in dimension}
    missing_canonical = {v for v in canonical.values()} - known_players
    if missing_canonical:
        raise RuntimeError(f"CANONICAL_GSIS targets absent from dimension: {missing_canonical}")
    conn.executemany(
        "INSERT INTO player VALUES (" + ",".join("?" * 22) + ")",
        [tuple(r[c] for c in player_dimension.PLAYER_COLUMNS) + (None,)
         for r in dimension])
    # canonical_gsis_id is a self-FK, so it has to be a second pass -- the
    # target row may not exist yet during the insert.
    conn.executemany("UPDATE player SET canonical_gsis_id=? WHERE gsis_id=?",
                     [(v, k) for k, v in canonical.items()])
    n_alias = conn.execute(
        "SELECT COUNT(*) FROM player WHERE canonical_gsis_id IS NOT NULL").fetchone()[0]
    if n_alias != len(canonical):
        raise RuntimeError(f"CANONICAL_GSIS: {n_alias} of {len(canonical)} applied")
    counts["player"] = len(dimension)
    counts["canonical_aliases"] = n_alias

    # ---- games (with corrections) ------------------------------------------
    venue_by_id = {v["venueId"]: v for v in venues}
    rows = corrections.apply_game_corrections(rows, venue_by_id)

    def qb(v):
        return v if v in known_players else None

    conn.executemany(
        "INSERT INTO game VALUES (" + ",".join("?" * 48) + ")",
        [(r["gameId"], r["espnEventId"], r["gsisId"], r["pfrId"], r["ftnId"], r["oldGameId"],
          r["dataSource"], r["season"], r["seasonType"], r["week"], r["playoffRound"],
          r["kickoffUtc"], r["gameday"], r["gametimeEt"], r["weekday"], int(r["timeValid"]),
          r["resultStatus"], r["awayFranchiseId"], r["homeFranchiseId"], r["awayAbbr"],
          r["homeAbbr"], r["awayScore"], r["homeScore"], r["result"], r["total"],
          r["overtime"], r["divGame"], r["location"], r["awayRest"], r["homeRest"],
          r["temp"], r["wind"], qb(r["awayQbId"]), qb(r["homeQbId"]),
          r["awayQbName"], r["homeQbName"], r["awayCoach"], r["homeCoach"], r["referee"],
          r["roof"], r["surface"], r["stadiumId"], r["stadium"], r["venueId"],
          r["broadcast"], r["note"],
          r.get("awayRestUpstream"), r.get("homeRestUpstream")) for r in rows])
    counts["game"] = len(rows)

    conn.executemany("INSERT INTO game_line VALUES (?,?,?,?,?,?,?,?,?,?)",
                     [(r["gameId"], r["spreadLine"], r["totalLine"], r["awayMoneyline"],
                       r["homeMoneyline"], r["awaySpreadOdds"], r["homeSpreadOdds"],
                       r["overOdds"], r["underOdds"], r["oddsSource"])
                      for r in rows if r["spreadLine"] is not None])
    counts["game_line"] = sum(1 for r in rows if r["spreadLine"] is not None)

    # ---- team_game (Tier 2 materialisation) --------------------------------
    tg = []
    for r in rows:
        if r["awayFranchiseId"] is None:
            continue
        for is_home in (1, 0):
            me = r["homeFranchiseId"] if is_home else r["awayFranchiseId"]
            opp = r["awayFranchiseId"] if is_home else r["homeFranchiseId"]
            pf = r["homeScore"] if is_home else r["awayScore"]
            pa = r["awayScore"] if is_home else r["homeScore"]
            margin = None if pf is None else pf - pa
            spread = None
            if r["spreadLine"] is not None:
                spread = r["spreadLine"] if is_home else -r["spreadLine"]
            ml = (r["homeMoneyline"] if is_home else r["awayMoneyline"])
            rest = r["homeRest"] if is_home else r["awayRest"]
            rest_up = (r.get("homeRestUpstream") if is_home else r.get("awayRestUpstream"))
            total_line = r["totalLine"]

            # Legacy booleans, retained verbatim for continuity.
            won = None if margin is None or margin == 0 else int(margin > 0)
            covered = None
            if margin is not None and spread is not None and margin != spread:
                covered = int(margin > spread)

            # D14. Explicit three-valued results. Each is NULL for exactly one
            # documented reason, never as a stand-in for push / tie / unplayed.
            su = None if margin is None else ("W" if margin > 0 else "L" if margin < 0 else "T")
            ats = None
            if margin is not None and spread is not None:
                ats = "W" if margin > spread else "L" if margin < spread else "P"
            ou = None
            if pf is not None and pa is not None and total_line is not None:
                pts = pf + pa
                ou = "O" if pts > total_line else "U" if pts < total_line else "P"

            tg.append((r["gameId"], me, opp, r["season"], r["seasonType"], r["week"],
                       r["playoffRound"], r["kickoffUtc"], is_home, pf, pa, margin,
                       spread, total_line, ml, rest, rest_up, won, covered,
                       su, ats, ou, None))
    # game_number: nth game of that team's season, in kickoff order
    order = defaultdict(list)
    for i, t in enumerate(tg):
        order[(t[1], t[3])].append((t[7], i))
    for key, lst in order.items():
        for n, (_, i) in enumerate(sorted(lst), start=1):
            tg[i] = tg[i][:22] + (n,)
    conn.executemany("INSERT INTO team_game VALUES (" + ",".join("?" * 23) + ")", tg)
    counts["team_game"] = len(tg)

    # ---- player_game_stats -------------------------------------------------
    # D1: game_id is carried. The source resolves it for 286,843/286,843 rows
    # and the old loader threw it away, which is the root cause of every POST
    # row in v_player_game having NULL game context, spread and total.
    game_ids = {r["gameId"] for r in rows}
    stat_fix = corrections.player_game_stat_corrections()
    stat_rekey = corrections.player_game_stat_rekeys()
    rekey_hits = Counter()
    seen_pk = set()
    ps_rows = []
    stat_hits = Counter()
    for r in stream_csv(os.path.join(RAW, "player_stats.csv")):
        gid = pick(r, "player_id", "gsis_id")
        if not gid or gid not in known_players:
            continue
        season, week = as_int(pick(r, "season")), as_int(pick(r, "week"))
        st = pick(r, "season_type") or "REG"
        if season is None or week is None:
            continue
        key = (gid, season, week, st)
        if key in seen_pk:
            continue
        seen_pk.add(key)
        game_id = pick(r, "game_id")
        if game_id not in game_ids:
            raise RuntimeError(f"player_stats row {key} has unresolvable game_id {game_id!r}")
        rec = {
            "completions": as_int(pick(r, "completions")),
            "attempts": as_int(pick(r, "attempts")),
            "passing_yards": as_int(pick(r, "passing_yards")),
            "passing_tds": as_int(pick(r, "passing_tds")),
            "interceptions": as_int(pick(r, "passing_interceptions", "interceptions")),
            "sacks_suffered": as_real(pick(r, "sacks_suffered", "sacks")),
            "passing_epa": as_real(pick(r, "passing_epa")),
            "carries": as_int(pick(r, "carries", "rushing_attempts")),
            "rushing_yards": as_int(pick(r, "rushing_yards")),
            "rushing_tds": as_int(pick(r, "rushing_tds")),
            "rushing_epa": as_real(pick(r, "rushing_epa")),
            "receptions": as_int(pick(r, "receptions")),
            "targets": as_int(pick(r, "targets")),
            "receiving_yards": as_int(pick(r, "receiving_yards")),
            "receiving_tds": as_int(pick(r, "receiving_tds")),
            "receiving_epa": as_real(pick(r, "receiving_epa")),
            "target_share": as_real(pick(r, "target_share")),
            "air_yards_share": as_real(pick(r, "air_yards_share")),
            "fantasy_points": as_real(pick(r, "fantasy_points")),
            "fantasy_points_ppr": as_real(pick(r, "fantasy_points_ppr")),
        }
        rec["position"] = pick(r, "position")
        rec["position_group"] = pick(r, "position_group")
        patch = stat_fix.get(key)
        if patch is not None:
            corrections.assert_and_apply(f"player_game_stats{key}", rec, patch)
            stat_hits[key] += 1
        # D19: re-key the 13 misattributed rows onto the right human. The old
        # gsis_id is preserved in data_correction and the move is reconciled
        # against rowloss in PASS 2b -- it is not waved through.
        if key in stat_rekey:
            new_gsis = stat_rekey[key]
            if (new_gsis, season, week, st) in seen_pk:
                raise RuntimeError(f"D19 re-key collision at {key}")
            corrections.d19_record(key, new_gsis)
            rekey_hits[key] += 1
            gid = new_gsis
            seen_pk.add((new_gsis, season, week, st))
        ps_rows.append((gid, season, week, st, game_id,
                        fid(pick(r, "team", "recent_team"), season),
                        fid(pick(r, "opponent_team", "opponent"), season),
                        rec["position"], rec["position_group"])
                       + tuple(rec[c] for c in (
                           "completions", "attempts", "passing_yards", "passing_tds",
                           "interceptions", "sacks_suffered", "passing_epa",
                           "carries", "rushing_yards", "rushing_tds", "rushing_epa",
                           "receptions", "targets", "receiving_yards", "receiving_tds",
                           "receiving_epa", "target_share", "air_yards_share",
                           "fantasy_points", "fantasy_points_ppr")))
    corrections.assert_all_applied("player_game_stats", stat_fix, stat_hits)
    corrections.assert_all_applied("player_game_stats(rekey)", stat_rekey, rekey_hits)
    conn.executemany("INSERT INTO player_game_stats VALUES (" + ",".join("?" * 29) + ")",
                     ps_rows)
    counts["player_game_stats"] = len(ps_rows)

    # ---- STEP 3: snap_count (B1 crosswalk) ---------------------------------
    # D4: build_pfr_to_gsis resolves all 30 previously-unmapped pfr ids. The
    # >=95% gate is gone; gsis_id is NOT NULL in the schema and PASS 2 asserts
    # zero NULLs against the BUILT DATABASE, not against this dict.
    pfr2gsis = snap_crosswalk.build_pfr_to_gsis(
        players_csv=os.path.join(RAW, "players.csv"),
        rosters_csv=os.path.join(RAW, "rosters.csv"),
        player_stats_csv=os.path.join(RAW, "player_stats.csv"),
        snap_counts_csv=os.path.join(RAW, "snap_counts.csv"))
    # D18: the two Jonah Williamses have their pfr ids swapped upstream. Correct
    # the crosswalk too, or `player` and `snap_count` disagree about which man
    # owns 146 snap rows.
    corrections.apply_snap_crosswalk_corrections(pfr2gsis)
    # D16: per-game franchise swap for the 4 transposed Super Bowls.
    snap_fix = corrections.snap_count_corrections()
    snap_hits = Counter()
    sc_rows = []
    # Unresolved ids are collected and reported together. Raising on the first one
    # made every upstream drift a one-id-per-run bisection: nflverse revising
    # players.csv can silently cost a name-inference match (it cost WillRo08
    # between 2026-07-27 and 2026-08-07), and the old behaviour surfaced that as a
    # traceback naming a single id, with no way to see how many more were behind
    # it. Still fail-closed -- gsis_id is NOT NULL and a partial snap table is not
    # a database -- just diagnosable in one run.
    unresolved_pfr = Counter()
    for r in stream_csv(os.path.join(RAW, "snap_counts.csv")):
        season = as_int(pick(r, "season"))
        if not season:
            continue
        pfr = pick(r, "pfr_player_id", "pfr_id")
        gsis = pfr2gsis.get(pfr)
        if gsis is None:
            unresolved_pfr[pfr] += 1
            continue
        nfl_game_id = pick(r, "game_id")
        if nfl_game_id not in game_ids:
            raise RuntimeError(f"snap_counts row has unresolvable game_id {nfl_game_id!r}")
        src_gt = pick(r, "game_type")
        src_wk = as_int(pick(r, "week"))
        season_type, week, rnd = encode_week(src_gt, src_wk)
        upstream_fid = fid(pick(r, "team"), season)
        franchise = upstream_fid
        swap = snap_fix.get(nfl_game_id)
        if swap is not None:
            if upstream_fid not in swap:
                raise RuntimeError(f"D16 {nfl_game_id}: unexpected franchise {upstream_fid}")
            franchise = swap[upstream_fid]
            corrections.d16_record(nfl_game_id, pfr, upstream_fid, franchise)
            snap_hits[nfl_game_id] += 1
        sc_rows.append((gsis, pfr, nfl_game_id,
                        pick(r, "pfr_game_id"),          # D7: PFR's own id, not nflverse's
                        season, season_type, week, rnd, src_gt, src_wk,
                        franchise, upstream_fid, pick(r, "position"),
                        as_int(pick(r, "offense_snaps")), as_real(pick(r, "offense_pct")),
                        as_int(pick(r, "defense_snaps")), as_real(pick(r, "defense_pct")),
                        as_int(pick(r, "st_snaps")), as_real(pick(r, "st_pct"))))
    if unresolved_pfr:
        listing = ", ".join(f"{p!r} ({n} rows)"
                            for p, n in sorted(unresolved_pfr.items()))
        raise RuntimeError(
            f"the crosswalk must cover every snap row (D4), but "
            f"{len(unresolved_pfr)} pfr_player_id(s) covering "
            f"{sum(unresolved_pfr.values())} rows are unresolved: {listing}. "
            f"Upstream player data drifts; add each to "
            f"lib/snap_crosswalk.MANUAL_PFR_TO_GSIS with cited evidence.")
    # D16's target is a GAME, so it matches once per row; the assertion is on
    # the per-game row count, which must reproduce B4/S2's 88/89/90/91 = 358.
    want_d16 = corrections.d16_expected_counts()
    if {g: snap_hits[g] for g in want_d16} != want_d16:
        raise RuntimeError(f"D16 row counts moved: got {dict(snap_hits)} want {want_d16}")
    conn.executemany("INSERT INTO snap_count VALUES (" + ",".join("?" * 19) + ")", sc_rows)
    counts["snap_count"] = len(sc_rows)

    # ---- roster_season -----------------------------------------------------
    # N8: week and game_type are kept. The old loader discarded both, which is
    # what made 4 upstream-duplicate rows indistinguishable.
    rs_rows = []
    ordinal = Counter()
    for r in stream_csv(os.path.join(RAW, "rosters.csv")):
        season = as_int(pick(r, "season"))
        if not season:
            continue
        gsis = pick(r, "gsis_id", "player_id")
        franchise = fid(pick(r, "team"), season)
        src_gt = pick(r, "game_type")
        src_wk = as_int(pick(r, "week"))
        season_type, week, rnd = encode_week(src_gt, src_wk)
        key = (gsis, season, franchise, src_wk, src_gt)
        ordinal[key] += 1
        rs_rows.append((None, gsis, season, franchise, season_type, week, rnd,
                        src_gt, src_wk, pick(r, "position"),
                        pick(r, "depth_chart_position"), as_int(pick(r, "jersey_number")),
                        pick(r, "status"), pick(r, "full_name", "player_name"),
                        as_int(pick(r, "years_exp")), ordinal[key]))
    conn.executemany("INSERT INTO roster_season VALUES (" + ",".join("?" * 16) + ")", rs_rows)
    counts["roster_season"] = len(rs_rows)

    # ---- STEP 4: depth_chart (B3) ------------------------------------------
    # D6: both nflverse shapes are loaded. The old loader dropped all 554,215
    # shape-B rows on the premise that they carry "no season or week column at
    # all" -- true of the columns, false of the data: `dt` is a full ISO-8601
    # instant and B3 recovers season and week from it against the game calendar.
    # D8: `week` is re-encoded to the schema's week/playoff_round convention;
    # nflverse's continuous 1..22 counter survives as `source_week`.
    calendar = depth_lib.GameCalendar(conn.execute(
        "SELECT season, season_type, week, playoff_round, kickoff_utc FROM game"))
    team_map = depth_lib.load_team_map(TEAMS)
    # T4's input. This file used to live at cache/b3/espn_identities.json, and
    # `scripts/data/nfl-db/cache/` is gitignored -- so it existed on exactly one
    # machine and NO clone ever had it. The loader skipped T4 silently when it was
    # missing (`if os.path.exists(...)` with no else), so a clean clone built
    # green while 316 audited depth-chart rows quietly lost their resolved
    # gsis_id. Verified by holding the extract constant and varying only this
    # file: 3,814 espn ids resolve with it, 3,809 without -- the 5 T4-only ids
    # 3043133, 4240033, 4244814, 4339830, 4362191 cover exactly those 316 rows.
    #
    # Same defect as #427's EXTRACT-NOTES.md, same fix: a negation cannot
    # re-include a file inside an excluded DIRECTORY, so it moved one level up to
    # scripts/data/nfl-db/espn-identities.json where nothing excludes it.
    #
    # ONE path authority: build_inputs.BUILD_INPUTS["espn_identities"]. The
    # gitignored cache/ copy is deliberately NOT a fallback. Letting untracked
    # developer residue stand in for a missing tracked input is precisely the
    # defect this contract exists to prevent, and it would let two clones of the
    # same revision build different databases. Its presence is REPORTED to help
    # the operator diagnose an incomplete checkout; it is never consumed.
    # ONE authority: lib/espn_identities validates and canonicalises T4. No
    # parsing happens here, so build and self-check cannot interpret a record
    # differently. Preflight has already run this; loading again is cheap and
    # keeps the call site honest about where the data comes from.
    t4 = espn_identities.load(root=ROOT)
    identities = t4.as_crosswalk_map()
    counts["espn_identities"] = len(t4)
    counts["espn_identities_capable"] = len(t4.t4_capable)
    espn_gsis = depth_lib.build_espn_gsis_crosswalk(RAW, espn_identities=identities)
    dc_rows = []
    dc_ordinal = Counter()
    dc_shapes = Counter()
    dc_src = 0                 # source rows streamed, for the conservation gate
    for raw in stream_csv(os.path.join(RAW, "depth_charts.csv")):
        dc_src += 1
        shape = depth_lib.classify_shape(raw)
        rec = depth_lib.normalize(raw, calendar=calendar, team_map=team_map,
                                  espn_gsis=espn_gsis, shape=shape)
        dc_shapes[shape] += 1
        if rec["franchise_id"] is None:
            raise RuntimeError(f"depth_chart row has unmapped team {rec['team_abbr']!r}")
        key = (rec["source_shape"], rec["snapshot_ts"], rec["season"], rec["source_week"],
               rec["source_game_type"], rec["franchise_id"], rec["gsis_id"],
               rec["depth_position"], rec["depth_order"], rec["pos_slot"], rec["scheme"])
        dc_ordinal[key] += 1
        dc_rows.append((None, rec["source_shape"], rec["snapshot_ts"], dc_ordinal[key],
                        rec["season"], rec["season_type"], rec["week"], rec["playoff_round"],
                        rec["bucket"], rec["source_game_type"], rec["source_week"],
                        rec["franchise_id"], rec["gsis_id"], rec["gsis_source"],
                        rec["espn_id"], rec["full_name"], rec["jersey_number"],
                        rec["position"], rec["depth_position"],
                        rec["depth_position_canonical"], rec["depth_order"],
                        rec["unit"], rec["scheme"], rec["pos_slot"], rec["elias_id"]))
    conn.executemany("INSERT INTO depth_chart VALUES (" + ",".join("?" * 25) + ")", dc_rows)
    counts["depth_chart"] = len(dc_rows)
    counts["depth_chart_src"] = dc_src
    counts["depth_shape_a"] = dc_shapes["A"]
    counts["depth_shape_b"] = dc_shapes["B"]

    # ---- the correction audit trail ----------------------------------------
    conn.executemany(
        "INSERT INTO data_correction (defect,target_table,target_key,column_name,"
        "upstream_value,corrected_value,source) VALUES (?,?,?,?,?,?,?)",
        corrections.applied_rows())

    conn.commit()
    counts["corrections_applied"] = corrections.applied_count()
    return counts


# =========================================================== PASS 1
def pass_structural(conn):
    print("\nPASS 1 - STRUCTURAL: does the database defend itself?")
    q = lambda s, *a: conn.execute(s, a).fetchone()
    check(1, "foreign_keys pragma ON", q("PRAGMA foreign_keys")[0] == 1)
    fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    check(1, "PRAGMA foreign_key_check returns zero rows", not fk, f"{fk[:3]}")
    check(1, "sqlite integrity_check clean", q("PRAGMA integrity_check")[0] == "ok")

    # D22 NEGATIVE CONTROL. `foreign_key_check` returning nothing proves nothing
    # unless enforcement is live AND something is actually declared. Both are
    # tested by writing rows that must be rejected.
    fk_probes = [
        ("FK enforcement is LIVE: orphan snap_count.gsis_id rejected",
         """INSERT INTO snap_count (gsis_id,pfr_player_id,game_id,pfr_game_id,season,
            season_type,week,source_game_type,source_week,franchise_id)
            SELECT '00-9999999',pfr_player_id||'X',game_id,pfr_game_id||'X',season,
            season_type,week,source_game_type,source_week,franchise_id
            FROM snap_count LIMIT 1"""),
        ("FK enforcement is LIVE: orphan roster_season.gsis_id rejected",
         """INSERT INTO roster_season (gsis_id,season,franchise_id,season_type,week,
            source_game_type,source_week,source_ordinal)
            VALUES ('00-9999999',2015,4,'REG',1,'REG',1,1)"""),
        ("FK enforcement is LIVE: orphan depth_chart.gsis_id rejected",
         """INSERT INTO depth_chart (source_shape,source_ordinal,season,bucket,
            franchise_id,gsis_id) VALUES ('A',1,2015,'regular',4,'00-9999999')"""),
        ("FK enforcement is LIVE: orphan player_game_stats.game_id rejected",
         """INSERT INTO player_game_stats (gsis_id,season,week,season_type,game_id)
            SELECT gsis_id,1999,1,'REG','no_such_game' FROM player LIMIT 1"""),
        ("FK enforcement is LIVE: orphan snap_count.game_id rejected",
         """INSERT INTO snap_count (gsis_id,pfr_player_id,game_id,pfr_game_id,season,
            season_type,week,source_game_type,source_week,franchise_id)
            SELECT gsis_id,pfr_player_id||'Y','no_such_game',pfr_game_id||'Y',season,
            season_type,week,source_game_type,source_week,franchise_id
            FROM snap_count LIMIT 1"""),
    ]
    for name, sql in fk_probes:
        try:
            conn.execute(sql)
            conn.rollback()
            check(1, name, False, "write ACCEPTED -- foreign keys are NOT enforced")
        except sqlite3.IntegrityError:
            conn.rollback()
            check(1, name, True)

    n_idx = q("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")[0]
    check(1, "all named indexes created", n_idx >= 46, f"found {n_idx}")

    views = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='view'")}
    want = {"v_game", "v_backtest", "v_team_game", "v_season_coverage", "v_player_game",
            "v_game_line_observed"}
    check(1, "all 6 views present and queryable", want <= views, f"missing {want - views}")
    for v in sorted(want):
        conn.execute(f"SELECT * FROM {v} LIMIT 1").fetchall()

    probes = [
        ("playoff game with a week number rejected",
         """INSERT INTO game (game_id,espn_event_id,data_source,season,season_type,week,
            playoff_round,kickoff_utc,time_valid,result_status,away_franchise_id,home_franchise_id,
            away_score,home_score,result,total) VALUES ('p1','x1','espn',2015,'POST',18,'WC',
            '2015-01-01T00:00:00Z',1,'final',2,4,10,20,10,30)"""),
        ("score inconsistent with result rejected",
         """INSERT INTO game (game_id,espn_event_id,data_source,season,season_type,week,
            kickoff_utc,time_valid,result_status,away_franchise_id,home_franchise_id,
            away_score,home_score,result,total) VALUES ('p2','x2','espn',2015,'REG',1,
            '2015-01-01T00:00:00Z',1,'final',2,4,10,20,999,30)"""),
        ("team playing itself rejected",
         """INSERT INTO game (game_id,espn_event_id,data_source,season,season_type,week,
            kickoff_utc,time_valid,result_status,away_franchise_id,home_franchise_id)
            VALUES ('p3','x3','espn',2015,'REG',1,'2015-01-01T00:00:00Z',1,'scheduled',7,7)"""),
        ("unknown franchise rejected by FK",
         """INSERT INTO game (game_id,espn_event_id,data_source,season,season_type,week,
            kickoff_utc,time_valid,result_status,away_franchise_id,home_franchise_id)
            VALUES ('p4','x4','espn',2015,'REG',1,'2015-01-01T00:00:00Z',1,'scheduled',999,4)"""),
        ("out-of-range season rejected",
         """INSERT INTO game (game_id,espn_event_id,data_source,season,season_type,week,
            kickoff_utc,time_valid,result_status,away_franchise_id,home_franchise_id)
            VALUES ('p5','x5','espn',1999,'REG',1,'1999-01-01T00:00:00Z',1,'scheduled',2,4)"""),
        # D9: the collision must now be structurally impossible.
        ("duplicate espn_event_id rejected by UNIQUE",
         """INSERT INTO game (game_id,espn_event_id,data_source,season,season_type,week,
            kickoff_utc,time_valid,result_status,away_franchise_id,home_franchise_id)
            SELECT 'p6',espn_event_id,'espn',2015,'REG',1,'2015-01-01T00:00:00Z',1,
            'scheduled',2,4 FROM game LIMIT 1"""),
        ("orphan line row rejected by FK",
         "INSERT INTO game_line VALUES ('nope',1,40,100,-120,-110,-110,-110,-110,'x')"),
        ("player_game_stats for unknown player rejected by FK",
         """INSERT INTO player_game_stats (gsis_id,season,week,season_type,game_id)
            SELECT '00-9999999',2015,1,'REG',game_id FROM game LIMIT 1"""),
        ("duplicate player-week rejected by PK",
         """INSERT INTO player_game_stats (gsis_id,season,week,season_type,game_id)
            SELECT gsis_id,season,week,season_type,game_id FROM player_game_stats LIMIT 1"""),
        # D23: three tables that previously had no primary key at all.
        ("duplicate snap_count row rejected by PK",
         "INSERT INTO snap_count SELECT * FROM snap_count LIMIT 1"),
        ("duplicate roster_season natural key rejected by UNIQUE",
         """INSERT INTO roster_season (gsis_id,season,franchise_id,season_type,week,
            playoff_round,source_game_type,source_week,source_ordinal)
            SELECT gsis_id,season,franchise_id,season_type,week,playoff_round,
            source_game_type,source_week,source_ordinal FROM roster_season
            WHERE gsis_id IS NOT NULL LIMIT 1"""),
        ("duplicate depth_chart snapshot slot rejected by UNIQUE",
         """INSERT INTO depth_chart (source_shape,snapshot_ts,source_ordinal,season,bucket,
            franchise_id,scheme,pos_slot,depth_order,espn_id)
            SELECT source_shape,snapshot_ts,source_ordinal,season,bucket,franchise_id,
            scheme,pos_slot,depth_order,espn_id FROM depth_chart
            WHERE snapshot_ts IS NOT NULL LIMIT 1"""),
        ("team_game with team as its own opponent rejected",
         """INSERT INTO team_game (game_id,franchise_id,opponent_id,season,season_type,
            week,kickoff_utc,is_home) SELECT game_id,2,2,2015,'REG',1,'x',1 FROM game LIMIT 1"""),
        # D14: the result columns cannot disagree with their own inputs.
        ("ats_result inconsistent with margin vs spread rejected",
         """INSERT INTO team_game (game_id,franchise_id,opponent_id,season,season_type,week,
            kickoff_utc,is_home,points_for,points_against,margin,spread,ats_result,su_result)
            SELECT 'p7',2,4,2015,'REG',1,'x',1,20,10,10,3.0,'L','W'"""),
        ("su_result set on an unplayed game rejected",
         """INSERT INTO team_game (game_id,franchise_id,opponent_id,season,season_type,week,
            kickoff_utc,is_home,su_result) SELECT 'p8',2,4,2015,'REG',1,'x',1,'W'"""),
        ("ats_result NULL where margin and spread both exist rejected",
         """INSERT INTO team_game (game_id,franchise_id,opponent_id,season,season_type,week,
            kickoff_utc,is_home,points_for,points_against,margin,spread,su_result)
            SELECT 'p9',2,4,2015,'REG',1,'x',1,20,10,10,3.0,'W'"""),
        ("snap_count postseason row with a week number rejected",
         """INSERT INTO snap_count (gsis_id,pfr_player_id,game_id,pfr_game_id,season,
            season_type,week,playoff_round,source_game_type,source_week,franchise_id)
            SELECT gsis_id,'ZZ00',game_id,'zz',season,'POST',5,'SB','SB',22,franchise_id
            FROM snap_count LIMIT 1"""),
    ]
    for name, sql in probes:
        try:
            conn.execute(sql)
            conn.rollback()
            check(1, name, False, "write ACCEPTED but should have been rejected")
        except sqlite3.IntegrityError:
            conn.rollback()
            check(1, name, True)

    dups = conn.execute("""SELECT espn_event_id FROM game GROUP BY espn_event_id
                           HAVING COUNT(*)>1""").fetchall()
    check(1, "zero espn_event_id collisions (D9 corrected + UNIQUE)", not dups, f"{dups}")

    # D1/D2 are STRUCTURAL claims about how v_player_game joins, and they are not
    # falsifiable from the data alone: once the stat row carries game_id and
    # snap_count has a primary key, (gsis_id, game_id) is already unique, so
    # dropping the franchise predicate no longer changes a single row. The
    # predicate is still the thing that makes the wrong-team attachment
    # impossible rather than merely absent, so it is asserted against the view's
    # own definition. Verified: 234,440 snap attachments with the predicate,
    # 234,440 without, 0 franchise disagreements in the corrected data.
    vsql = conn.execute("""SELECT sql FROM sqlite_master
                           WHERE type='view' AND name='v_player_game'""").fetchone()[0]
    vflat = " ".join(vsql.split())
    check(1, "v_player_game joins game on game_id, not (season, week) (D1)",
          "JOIN game g ON g.game_id = p.game_id" in vflat, vflat[:200])
    check(1, "v_player_game's snap join carries the franchise predicate (D2)",
          "s.franchise_id = p.franchise_id" in vflat, vflat[:200])
    check(1, "v_player_game's snap join carries the game predicate (D2)",
          "s.game_id = p.game_id" in vflat, vflat[:200])

    # Every table that carries fact rows must now have a primary key (D23).
    for tbl in ("game", "game_line", "team_game", "player", "player_game_stats",
                "snap_count", "roster_season", "depth_chart", "team", "team_alias"):
        pk = [r for r in conn.execute(f"PRAGMA table_info({tbl})") if r[5] > 0]
        check(1, f"{tbl} declares a primary key", bool(pk), "no pk columns")

    # Indexes must actually be chosen by the planner for the queries they exist for.
    plans = {
        "season+week lookup": "SELECT * FROM game WHERE season=2019 AND week=5",
        "team trend scan": "SELECT * FROM team_game WHERE franchise_id=13 AND season=2019",
        "player usage scan": "SELECT * FROM player_game_stats WHERE gsis_id='00-0033873' AND season=2023",
        "espn_id player lookup": "SELECT * FROM player WHERE espn_id='3139477'",
    }
    for label, sql in plans.items():
        plan = " ".join(r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql))
        check(1, f"planner uses an index for {label}",
              "USING INDEX" in plan or "USING COVERING" in plan, plan)


# =========================================================== PASS 2
def pass_reconciliation(conn, rows, hist, new, counts):
    print("\nPASS 2 - RECONCILIATION: does the database agree with its sources?")
    print("           (every gate below is an absolute assertion; no percentages)")
    q = lambda s, *a: conn.execute(s, a).fetchone()

    check(2, "game count equals merged JSON", q("SELECT COUNT(*) FROM game")[0] == len(rows))
    check(2, "game count equals both inputs summed",
          q("SELECT COUNT(*) FROM game")[0] == len(hist) + len(new))
    check(2, "game_line count equals games carrying a spread",
          q("SELECT COUNT(*) FROM game_line")[0] ==
          sum(1 for r in rows if r["spreadLine"] is not None))
    check(2, "team table holds 32 franchises", q("SELECT COUNT(*) FROM team")[0] == 32)
    check(2, "team_alias covers B2's full census plus the in-window era splits",
          q("SELECT COUNT(*) FROM team_alias")[0]
          == len(team_aliases.ALIASES) + len(ERA_ALIASES_IN_WINDOW),
          f"{q('SELECT COUNT(*) FROM team_alias')[0]}")

    unresolved = conn.execute("""
        SELECT DISTINCT away_abbr FROM game WHERE away_abbr IS NOT NULL
          AND away_abbr NOT IN (SELECT abbreviation FROM team_alias)
        UNION SELECT DISTINCT home_abbr FROM game WHERE home_abbr IS NOT NULL
          AND home_abbr NOT IN (SELECT abbreviation FROM team_alias)""").fetchall()
    check(2, "every published abbreviation resolves via team_alias", not unresolved, f"{unresolved}")

    mism = q("""SELECT COUNT(*) FROM game g JOIN team_alias a ON a.abbreviation=g.home_abbr
                WHERE g.home_franchise_id IS NOT NULL AND a.franchise_id<>g.home_franchise_id""")[0]
    check(2, "alias->franchise agrees with every stored home franchise id", mism == 0, f"{mism}")

    # ---- corrections: assert the corrected state, in the database ----------
    corrections.verify_in_database(conn, check)

    hidx = {r["gameId"]: r for r in hist}
    corrected_fields = corrections.corrected_game_fields()
    drift = []
    for gid, aw, hm, res, tot, kick, arest, hrest in conn.execute(
            """SELECT game_id,away_score,home_score,result,total,kickoff_utc,
                      away_rest_upstream,home_rest_upstream
               FROM game WHERE data_source='nflverse'"""):
        s = hidx.get(gid)
        if not s:
            drift.append(gid)
            continue
        want_kick = s["kickoffUtc"]
        if (gid, "kickoffUtc") in corrected_fields:
            want_kick = kick        # deliberately corrected; asserted separately
        if (aw, hm, res, tot, kick, arest, hrest) != (
                s["awayScore"], s["homeScore"], s["result"], s["total"],
                want_kick, s["awayRest"], s["homeRest"]):
            drift.append(gid)
    check(2, "zero unexplained drift on scores/kickoff/upstream-rest vs the input",
          not drift, f"{len(drift)} e.g. {drift[:3]}")

    ldrift = [gid for gid, sp, tl in conn.execute(
        "SELECT game_id,spread_line,total_line FROM game_line")
        if (sp, tl) != (hidx[gid]["spreadLine"], hidx[gid]["totalLine"])]
    check(2, "zero drift on lines vs the original input", not ldrift, f"{ldrift[:3]}")

    check(2, "every 2026 ESPN event id present",
          {r[0] for r in conn.execute("SELECT espn_event_id FROM game WHERE data_source='espn'")}
          == {str(r["eventId"]) for r in new})
    check(2, "per-season counts agree between SQL and JSON",
          dict(conn.execute("SELECT season,COUNT(*) FROM game GROUP BY season"))
          == dict(Counter(r["season"] for r in rows)))

    # ---- team_game must be a faithful doubling of resolved games -----------
    resolved = q("SELECT COUNT(*) FROM game WHERE home_franchise_id IS NOT NULL")[0]
    check(2, "team_game holds exactly two rows per resolved game",
          q("SELECT COUNT(*) FROM team_game")[0] == 2 * resolved)
    bad = q("""SELECT COUNT(*) FROM team_game tg JOIN game g ON g.game_id=tg.game_id
               WHERE (tg.is_home=1 AND (tg.franchise_id<>g.home_franchise_id
                                     OR tg.points_for IS NOT g.home_score))
                  OR (tg.is_home=0 AND (tg.franchise_id<>g.away_franchise_id
                                     OR tg.points_for IS NOT g.away_score))""")[0]
    check(2, "team_game points and side match the game row exactly", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM team_game
               WHERE margin IS NOT NULL AND margin <> points_for - points_against""")[0]
    check(2, "team_game margin is arithmetically correct", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM team_game a JOIN team_game b
               ON a.game_id=b.game_id AND a.franchise_id<>b.franchise_id
               WHERE a.margin IS NOT NULL AND a.margin <> -b.margin""")[0]
    check(2, "the two sides of every game have equal and opposite margins", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM team_game WHERE covered IS NOT NULL
               AND covered <> (margin > spread)""")[0]
    check(2, "team_game cover flag matches margin vs spread", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM (
                 SELECT franchise_id,season,COUNT(*) c,MAX(game_number) m,
                        COUNT(DISTINCT game_number) d
                 FROM team_game GROUP BY franchise_id,season) WHERE c<>m OR c<>d""")[0]
    check(2, "game_number is a gapless 1..n sequence per team-season", bad == 0, f"{bad}")

    # ---- D14: the explicit result columns -----------------------------------
    n_final = q("""SELECT COUNT(*) FROM team_game tg JOIN game g ON g.game_id=tg.game_id
                   WHERE g.result_status='final'""")[0]
    n_su = q("SELECT COUNT(*) FROM team_game WHERE su_result IS NOT NULL")[0]
    check(2, "su_result is populated on exactly the played team-games",
          n_su == n_final, f"su_result={n_su} final={n_final}")
    bad = q("""SELECT COUNT(*) FROM team_game tg JOIN game g ON g.game_id=tg.game_id
               WHERE g.result_status<>'final' AND (su_result IS NOT NULL
                     OR ats_result IS NOT NULL OR ou_result IS NOT NULL)""")[0]
    check(2, "no result column is set on an unplayed game", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM team_game
               WHERE ats_result IS NULL AND margin IS NOT NULL AND spread IS NOT NULL""")[0]
    check(2, "ats_result is NULL only where genuinely unpriced or unplayed", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM team_game
               WHERE ou_result IS NULL AND margin IS NOT NULL AND total_line IS NOT NULL""")[0]
    check(2, "ou_result is NULL only where genuinely unpriced or unplayed", bad == 0, f"{bad}")
    # The trap itself: pushes and unplayed rows must not read as losses.
    n_w, n_l, n_p = q("""SELECT SUM(ats_result='W'),SUM(ats_result='L'),SUM(ats_result='P')
                         FROM team_game""")
    check(2, "ATS W and L are exactly balanced across both sides of every game",
          n_w == n_l, f"W={n_w} L={n_l} P={n_p}")
    naive = q("SELECT ROUND(100.0*SUM(covered=1)/COUNT(*),2) FROM team_game")[0]
    honest = q("""SELECT ROUND(100.0*SUM(ats_result='W')/
                  SUM(ats_result IN ('W','L')),2) FROM team_game""")[0]
    check(2, "the explicit ATS rate is 50.00 where the naive boolean read 45.89",
          honest == 50.0, f"naive={naive} explicit={honest}")

    # ---- player layer ------------------------------------------------------
    # Row counts are asserted per SEASON FINALITY, not in aggregate. Settled
    # seasons (<= season_pins.FROZEN_THROUGH) are pinned exactly, so a rewrite
    # of closed history still fails the build. The in-progress season is
    # reported, because pinning it makes ordinary upstream growth -- rosters
    # churning through camp, depth charts publishing all season -- indistinguishable
    # from corruption. See lib/season_pins.py for why that distinction exists.
    n_ps = q("SELECT COUNT(*) FROM player_game_stats")[0]
    frozen_ok, frozen_detail = season_pins.frozen_verdict(
        "player_game_stats", per_season(conn, "player_game_stats"))
    check(2, "player_game_stats: settled seasons match the audited extract",
          frozen_ok, frozen_detail)
    orphan = q("""SELECT COUNT(*) FROM player_game_stats p
                  LEFT JOIN player pl ON pl.gsis_id=p.gsis_id WHERE pl.gsis_id IS NULL""")[0]
    check(2, "every player_game_stats row resolves to a known player", orphan == 0, f"{orphan}")
    # D1, asserted against the built database.
    bad = q("SELECT COUNT(*) FROM player_game_stats WHERE game_id IS NULL")[0]
    check(2, "every player_game_stats row carries a game_id", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM player_game_stats p
               LEFT JOIN game g ON g.game_id=p.game_id WHERE g.game_id IS NULL""")[0]
    check(2, "every player_game_stats game_id resolves to a real game", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM player_game_stats p JOIN game g ON g.game_id=p.game_id
               WHERE p.franchise_id IS NOT NULL
                 AND p.franchise_id NOT IN (g.home_franchise_id, g.away_franchise_id)""")[0]
    check(2, "every player_game_stats row's team actually played in that game", bad == 0, f"{bad}")

    unmapped = q("SELECT COUNT(*) FROM player_game_stats WHERE franchise_id IS NULL")[0]
    check(2, "no player_game_stats row has an unmapped team", unmapped == 0, f"{unmapped} rows")
    check(2, "player dimension is B5's complete union",
          q("SELECT COUNT(*) FROM player")[0] == counts["player"], f"{counts['player']}")

    # D5: zero orphans across every fact source, asserted in the database.
    for tbl, col in (("player_game_stats", "gsis_id"), ("snap_count", "gsis_id"),
                     ("roster_season", "gsis_id"), ("depth_chart", "gsis_id"),
                     ("game", "home_qb_id"), ("game", "away_qb_id")):
        n = q(f"""SELECT COUNT(*) FROM {tbl} f LEFT JOIN player p ON p.gsis_id=f.{col}
                  WHERE f.{col} IS NOT NULL AND p.gsis_id IS NULL""")[0]
        check(2, f"{tbl}.{col}: zero orphans against the player dimension", n == 0, f"{n}")

    # ---- D4/EX-1/EX-2: the snap NULL assertion nobody shipped ---------------
    frozen_ok, frozen_detail = season_pins.frozen_verdict(
        "snap_count", per_season(conn, "snap_count"))
    check(2, "snap_count: settled seasons match the audited extract",
          frozen_ok, frozen_detail)
    nulls = q("SELECT COUNT(*) FROM snap_count WHERE gsis_id IS NULL")[0]
    check(2, "snap_count.gsis_id IS NOT NULL on EVERY row (was 227 NULLs at 99.93%)",
          nulls == 0, f"{nulls} NULL gsis_id")
    orph = q("""SELECT COUNT(*) FROM snap_count s LEFT JOIN player p ON p.gsis_id=s.gsis_id
                WHERE p.gsis_id IS NULL""")[0]
    check(2, "every snap gsis_id is a real player", orph == 0, f"{orph}")
    # D7: the two game ids are genuinely different columns now.
    bad = q("SELECT COUNT(*) FROM snap_count WHERE game_id = pfr_game_id")[0]
    check(2, "snap_count.pfr_game_id no longer holds the nflverse game id (D7)",
          bad == 0, f"{bad} rows where the two ids are identical")
    bad = q("""SELECT COUNT(*) FROM snap_count s LEFT JOIN game g ON g.game_id=s.game_id
               WHERE g.game_id IS NULL""")[0]
    check(2, "every snap_count.game_id resolves to a real game", bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM snap_count s JOIN game g ON g.game_id=s.game_id
               WHERE s.season_type<>g.season_type
                  OR s.week IS NOT g.week OR s.playoff_round IS NOT g.playoff_round""")[0]
    check(2, "snap_count season_type/week/playoff_round agree with game (D20)", bad == 0, f"{bad}")
    bad = q("SELECT COUNT(*) FROM snap_count WHERE season_type NOT IN ('REG','POST')")[0]
    check(2, "snap_count.season_type uses the schema vocabulary, not SB/WC/DIV/CON",
          bad == 0, f"{bad}")

    # Team mapping must be complete across every player-level feed.
    for tbl in ("snap_count", "roster_season", "depth_chart"):
        miss = q(f"SELECT COUNT(*) FROM {tbl} WHERE franchise_id IS NULL")[0]
        check(2, f"{tbl}: every row maps to a franchise", miss == 0, f"{miss} unmapped")

    # 2026 rosters are the clearest case for the split: the 2026-07-27 R extract
    # requested 2010-2025 only, while fetch_raw.py (#427) fetches through 2026.
    # The 2,930 rows that appear are an entire in-progress season, not drift.
    frozen_ok, frozen_detail = season_pins.frozen_verdict(
        "roster_season", per_season(conn, "roster_season"))
    check(2, "roster_season: settled seasons match the audited extract",
          frozen_ok, frozen_detail)

    # ---- D6/D8: depth_chart holds BOTH shapes -------------------------------
    # D6 was never really about a number -- it was about the old loader silently
    # dropping all 554,215 shape-B rows. Conservation states that directly and
    # keeps stating it as the source grows; an aggregate pin only said it until
    # nflverse published the next season.
    n_dc = q("SELECT COUNT(*) FROM depth_chart")[0]
    live_ok, live_detail = season_pins.live_verdict(
        "depth_chart", n_dc, counts["depth_chart_src"])
    check(2, "depth_chart holds every source row, both shapes (D6)",
          live_ok, live_detail)
    # Partitioned on the SNAPSHOT INSTANT, never on season. depth_chart's season
    # is derived from `dt` against the game calendar's dead-zone rule, which files
    # a snapshot under season S until ~mid-May of S+1 -- so a season-keyed frozen
    # bucket keeps absorbing new rows long after the season ends, and the build
    # fails claiming closed history moved. season_pins.frozen_verdict() now
    # refuses this table outright to keep the mistake from being made twice.
    cutoff = season_pins.DEPTH_CHART_EXTRACT_CUTOFF
    _dcw = season_pins.window("depth_chart")
    dc_frozen = q(f"SELECT COUNT(*) FROM depth_chart WHERE {_dcw.predicate}")[0]
    dc_live = q(f"SELECT COUNT(*) FROM depth_chart WHERE {_dcw.live_predicate}")[0]
    frozen_ok, frozen_detail = season_pins.frozen_counts_verdict(
        "depth_chart", dc_frozen, dc_live, basis=f"snapshot <= {cutoff}")
    check(2, "depth_chart: the audited extract is present and unchanged",
          frozen_ok, frozen_detail)
    # Shape A closed when nflverse retired that release format; it can never grow
    # again. Shape B spans the audited window and everything published since, so
    # only the audited part is pinned.
    b_frozen = q(f"SELECT COUNT(*) FROM depth_chart "
                 f"WHERE source_shape='B' AND {_dcw.predicate}")[0]
    shape_ok, shape_detail = season_pins.frozen_shape_verdict(
        counts["depth_shape_a"], b_frozen)
    check(2, "depth_chart shape split across the audited window matches B3",
          shape_ok, shape_detail)

    # The in-progress season, stated rather than asserted. Its correctness is
    # carried by the row-level invariants below -- every row resolves a real
    # season, a real franchise and a real player -- which hold at any volume.
    for tbl in ("player_game_stats", "snap_count", "roster_season"):
        _, live = season_pins.split(per_season(conn, tbl))
        if live:
            report(f"{tbl}: in-progress seasons (>{season_pins.FROZEN_THROUGH})",
                   f"{live:,} rows, not pinned")
    if dc_live:
        report(f"depth_chart: snapshots after {cutoff}", f"{dc_live:,} rows, not pinned")

    # CONTENT, not just count. Every frozen check above compares row COUNTS, and a
    # count cannot see a value change: on 2026-08-07 a clean-clone rebuild had
    # 5,655 settled player_game_stats rows and 331 audited depth_chart rows with
    # different content -- 316 of them silently missing a gsis_id -- while every
    # count matched and all 154 checks passed. These digests close that gap.
    # Excluded columns are documented per table in season_pins.CONTENT_DIGEST_EXCLUDE.
    #
    # The frozen population comes from season_pins.FROZEN_WINDOWS -- the ONE
    # authority. It used to be written out here AND again in content_digest.py,
    # so the enforcer and the generator each carried their own WHERE clause and
    # column list for the same contract. Two independent definitions of one
    # contract eventually disagree, and a correct hash over the wrong population
    # is still wrong.
    for tbl in season_pins.governed_tables():
        spec = season_pins.window(tbl)
        dg, nrows, _ = season_pins.content_digest(conn, tbl, spec.predicate)
        ok, detail = season_pins.content_verdict(tbl, dg)
        if ok is None:
            report(f"{tbl}: frozen-window content digest", f"{detail}, {nrows:,} rows")
        else:
            check(2, f"{tbl}: frozen-window CONTENT is unchanged, not just its count",
                  ok, detail)
    # ---- LAYERS A and B: depth_chart historical facts and source identity ----
    # These replace the retired monolithic depth_chart digest (Phase 8). A holds
    # immutable row facts; B binds source-owned identity TO its row, so swapping
    # two identities fails even though the multiset of identifiers is unchanged.
    for layer, ok, detail in identity_layers.verdicts(conn):
        check(2, f"Layer {layer}: depth_chart "
                 f"{'historical facts are unchanged' if layer == 'A' else 'source-owned identity is unchanged'}",
              ok, detail)
    cons = identity_layers.conservation(conn)
    check(2, "every frozen depth_chart row is governed by exactly one identity mechanism",
          cons["ungoverned"] == 0,
          f"B {cons['layer_b_source_owned']:,} + C resolved {cons['layer_c_resolved']:,} "
          f"+ C unresolved {cons['layer_c_unresolved']:,} = {cons['governed']:,} "
          f"of {cons['frozen_rows']:,}")

    # ---- LAYER C: accepted derived identity (Phase 7) --------------------
    # The percentage gate below can only see how MANY identities are filled. It
    # cannot see WHICH, so it is blind to the two defects that actually matter:
    # a previously known person disappearing, and a row being reassigned to a
    # different person at identical coverage. This compares against reviewed
    # acceptance instead, and reports the three outcomes separately -- a
    # regression and a legitimate new resolution need different people.
    id_verdict, id_findings, id_stats = identity_baseline.check(conn, root=ROOT)
    report("Layer C: accepted identity baseline",
           f"{id_stats['accepted']} accepted "
           f"({id_stats['resolved']} resolved / {id_stats['unresolved']} unresolved), "
           f"verdict {id_verdict}")
    check(2, "Layer C: no accepted identity was lost or reassigned",
          not any(f["verdict"] == identity_baseline.FAIL for f in id_findings),
          "; ".join(f"{f['case']} {f['espn_id']}: {f['why']}"
                    for f in id_findings
                    if f["verdict"] == identity_baseline.FAIL)[:300])
    # REVIEW_REQUIRED is deliberately NOT a check() failure and deliberately NOT
    # silent: a legitimate new resolution must not fail a build, but it must also
    # be impossible to call the identity check green while it sits unaccepted.
    pending = [f for f in id_findings
               if f["verdict"] == identity_baseline.REVIEW_REQUIRED]
    if pending:
        report("Layer C: REVIEW_REQUIRED -- unaccepted identity changes",
               "; ".join(f"{f['case']} {f['espn_id']} -> {f['observed']}"
                         for f in pending[:10])
               + (f" (+{len(pending) - 10} more)" if len(pending) > 10 else ""))

    check(2, "depth_chart holds only rows that carry a real season",
          q("SELECT COUNT(*) FROM depth_chart WHERE season IS NULL")[0] == 0)
    bad = q("SELECT COUNT(*) FROM depth_chart WHERE week IS NOT NULL AND week > 18")[0]
    check(2, "depth_chart.week is a regular-season week, never the 1..22 counter (D8)",
          bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM depth_chart
               WHERE season_type NOT IN ('REG','POST') AND season_type IS NOT NULL""")[0]
    check(2, "depth_chart.season_type uses the schema vocabulary, never SBBYE",
          bad == 0, f"{bad}")
    bad = q("""SELECT COUNT(*) FROM depth_chart d JOIN game g
               ON g.season=d.season AND g.week=d.week AND g.season_type='REG'
                  AND g.home_franchise_id=d.franchise_id
               WHERE d.season_type='REG'""")[0]
    check(2, "depth_chart REG rows join to a real game on (season, week, team)",
          bad > 0, f"{bad} joined -- expected a large positive number")
    check(2, "2025 depth-chart rows are present (was the whole missing season)",
          q("SELECT COUNT(*) FROM depth_chart WHERE season=2025")[0] > 500000,
          f"{q('SELECT COUNT(*) FROM depth_chart WHERE season=2025')[0]}")

    # ---- views ------------------------------------------------------------
    check(2, "v_game returns one row per game", q("SELECT COUNT(*) FROM v_game")[0] == len(rows))
    check(2, "v_backtest covers every final game with a line",
          q("SELECT COUNT(*) FROM v_backtest")[0] == q("SELECT COUNT(*) FROM game_line")[0])
    bad = q("""SELECT COUNT(*) FROM v_backtest WHERE home_ats_margin<>result-spread_line
               OR total_margin<>total-total_line""")[0]
    check(2, "v_backtest derived margins are arithmetically correct", bad == 0, f"{bad}")

    # D1 + D2, asserted against the built view.
    n_view = q("SELECT COUNT(*) FROM v_player_game")[0]
    check(2, "v_player_game does not fan out (D2)", n_view == n_ps,
          f"view={n_view} base={n_ps}")
    post_null = q("""SELECT COUNT(*) FROM v_player_game
                     WHERE season_type<>'REG' AND game_id IS NULL""")[0]
    check(2, "v_player_game has zero NULL game_id on postseason rows (D1)",
          post_null == 0, f"{post_null}")
    post_unpriced = q("""SELECT COUNT(*) FROM v_player_game p JOIN game_line l
                         ON l.game_id=p.game_id
                         WHERE p.season_type<>'REG' AND p.spread_line IS NULL""")[0]
    check(2, "every postseason player row with a priced game carries its spread (D1)",
          post_unpriced == 0, f"{post_unpriced}")
    bad = q("""SELECT COUNT(*) FROM player_game_stats p JOIN snap_count s
               ON s.gsis_id=p.gsis_id AND s.game_id=p.game_id
               WHERE s.franchise_id<>p.franchise_id""")[0]
    check(2, "no player's snap row disagrees with their stat row on team (D2/D16)",
          bad == 0, f"{bad}")
    n_attached = q("SELECT COUNT(*) FROM v_player_game WHERE offense_snaps IS NOT NULL")[0]
    n_pairs = q("""SELECT COUNT(*) FROM player_game_stats p JOIN snap_count s
                   ON s.gsis_id=p.gsis_id AND s.game_id=p.game_id
                      AND s.franchise_id=p.franchise_id
                   WHERE s.offense_snaps IS NOT NULL""")[0]
    check(2, "v_player_game attaches exactly the franchise-matched snap rows (D2)",
          n_attached == n_pairs, f"view={n_attached} pairs={n_pairs}")


# =========================================================== PASS 2b
def pass_rowloss(db_path, counts):
    """B4's harness, wired in as a gate (the mandated fifth module).

    rowloss.py is used AS SHIPPED and is not modified. Its replay_* functions
    reproduce the PREVIOUS loader, so three of its eight comparisons no longer
    address the tables they name, and saying which is part of the job:

      game / game_line / team_game  -- fully valid. Keys reconcile exactly;
          values too where the column list is unchanged.
      player                        -- keys valid. The dimension is DELIBERATELY
          larger than players.csv (D5: B5's 1,482 additions), so the gate is
          "zero missing, and every extra is one of the 1,482".
      player_game_stats             -- keys valid. D19 deliberately moves 13 of
          them; the gate is "the ONLY movement is those 13".
      snap_count                    -- rowloss keys on (pfr_player_id,
          pfr_game_id), and D7 changed what pfr_game_id holds, so its key
          comparison is stale BY DESIGN OF THE FIX. Row-count identity is
          asserted instead, which is what row loss actually means.
      roster_season / depth_chart   -- rowloss's key is "<whole row>" via
          SELECT *, so any added column breaks it. Same treatment. For
          depth_chart the manifest is also superseded in the direction of the
          fix: it expects 554,215 EXCLUDED rows and D6 loads all of them, so
          `loaded == source_rows` is strictly stronger than the manifest.

    Note that `Recon.extra_keys` is a 25-row SAMPLE while `missing_keys` is
    exact, so extra counts are derived arithmetically, never from len().
    """
    print("\nPASS 2b - ROW LOSS: is every source row loaded or explained?")
    values_comparable = {"game_line"}
    count_only = {"snap_count", "roster_season", "depth_chart"}

    rekeys = corrections.player_game_stat_rekeys()
    expect_missing = set(rekeys)

    for name in rowloss.TABLES:
        recs = rowloss.reconcile_all(db_path, [name],
                                     want_values=name in values_comparable)
        rec = recs[name]
        missing = {tuple(k) for k, _n in rec.missing_keys}
        n_missing = sum(n for _k, n in rec.missing_keys)
        n_extra = rec.loaded - (rec.expected - n_missing)

        if name in count_only:
            ok = rec.loaded == rec.source_rows
            check(2, f"rowloss[{name}]: every one of the {rec.source_rows} source "
                     f"rows is in the database (key comparison superseded)",
                  ok, f"loaded={rec.loaded} source={rec.source_rows}")
        elif name == "player":
            # The extras were pinned at 1,482 -- a snapshot of the 2026-07-27
            # extract. players.csv and rosters.csv both grow, so that number is
            # wrong the moment upstream moves (1,518 on 2026-08-07). What D5
            # actually asserts is that every extra is ACCOUNTED FOR, so compare
            # against the two sources that produce extras rather than a constant.
            want_extra = counts["player_roster_derived"] + counts["player_feed_only"]
            ok = (n_missing == 0 and n_extra == rec.loaded - rec.source_rows
                  and n_extra == want_extra and not rec.manifest_errors)
            check(2, "rowloss[player]: zero missing; every extra is a "
                     "roster-derived or feed-only addition (D5)", ok,
                  f"missing={n_missing} extra={n_extra} want={want_extra} "
                  f"(roster={counts['player_roster_derived']} "
                  f"feed={counts['player_feed_only']}) loaded={rec.loaded}")
        elif name == "player_game_stats":
            ok = (missing == expect_missing and n_extra == len(expect_missing)
                  and not rec.duplicate_keys and not rec.manifest_errors)
            check(2, "rowloss[player_game_stats]: the ONLY key movement is D19's "
                     "13 documented re-keys", ok,
                  f"missing={n_missing} extra={n_extra} "
                  f"unexpected={sorted(missing - expect_missing)[:2]}")
        elif name in values_comparable:
            check(2, f"rowloss[{name}]: keys AND values reconcile", rec.clean,
                  "; ".join(rec.manifest_errors[:2]) or f"loaded={rec.loaded}")
        else:
            ok = (n_missing == 0 and n_extra == 0 and not rec.duplicate_keys
                  and not rec.manifest_errors)
            check(2, f"rowloss[{name}]: every source key is loaded or manifested",
                  ok, "; ".join(rec.manifest_errors[:2])
                      or f"missing={n_missing} extra={n_extra}")


# =========================================================== PASS 3
def pass_external(conn):
    print("\nPASS 3 - EXTERNAL: does the database agree with upstream nflverse?")
    r_script = r'''
    suppressMessages(library(nflreadr))
    a <- commandArgs(TRUE)
    s <- load_schedules(TRUE)
    s <- s[s$season>=2010 & s$season<=2025 & !is.na(s$result),
           c("game_id","season","week","game_type","away_score","home_score","result","total",
             "spread_line","total_line","home_moneyline","away_rest","home_rest","home_qb_id")]
    write.csv(s, a[1], row.names=FALSE, na="")
    p <- load_player_stats(2023, summary_level="week")
    p <- p[, c("player_id","season","week","season_type","passing_yards","rushing_yards",
               "receiving_yards","targets","receptions")]
    write.csv(p, a[2], row.names=FALSE, na="")
    cat(nrow(s), nrow(p), "\n")
    '''
    t1 = os.path.join(tempfile.gettempdir(), "nfl_reverify_games.csv")
    t2 = os.path.join(tempfile.gettempdir(), "nfl_reverify_players.csv")
    try:
        out = subprocess.run(["Rscript", "--vanilla", "-e", r_script, t1, t2],
                             capture_output=True, text=True, timeout=900)
        if out.returncode != 0 or not os.path.exists(t1):
            check(3, "re-fetch upstream nflverse", False, (out.stderr or "")[-200:])
            return
    except Exception as exc:                                     # noqa: BLE001
        check(3, "re-fetch upstream nflverse", False, str(exc))
        return

    up = {r["game_id"]: r for r in read_csv(t1)}
    check(3, "upstream returned the full historical set", len(up) >= 4300, f"{len(up)}")

    corrected = corrections.corrected_game_fields()
    db = {r[0]: r for r in conn.execute(
        """SELECT g.game_id,g.season,g.week,g.playoff_round,g.season_type,g.away_score,
                  g.home_score,g.result,g.total,l.spread_line,l.total_line,
                  g.away_rest_upstream,g.home_rest_upstream,g.home_qb_id
           FROM game g LEFT JOIN game_line l ON l.game_id=g.game_id
           WHERE g.data_source='nflverse'""")}
    check(3, "database and upstream hold the same game ids", set(db) == set(up),
          f"db-only {list(set(db)-set(up))[:2]} up-only {list(set(up)-set(db))[:2]}")

    bad = {"score": [], "week": [], "line": [], "rest": [], "qb": []}
    for gid, row in db.items():
        u = up.get(gid)
        if not u:
            continue
        if (int(u["away_score"]), int(u["home_score"]), int(float(u["result"])),
                int(float(u["total"]))) != (row[5], row[6], row[7], row[8]):
            bad["score"].append(gid)
        if u["game_type"] == "REG":
            if row[2] != int(u["week"]) or row[4] != "REG":
                bad["week"].append(gid)
        elif row[2] is not None or row[3] != u["game_type"]:
            bad["week"].append(gid)
        if u["spread_line"] and abs(float(u["spread_line"]) - (row[9] or 0)) > 1e-9:
            bad["line"].append(gid)
        # away_rest_upstream is the value nflverse publishes; `away_rest` is the
        # actual-kickoff recomputation (D15). Comparing the preserved column is
        # what keeps this an external check rather than a tautology.
        if u["away_rest"] and int(u["away_rest"]) != row[11]:
            bad["rest"].append(gid)
        if u["home_qb_id"] and row[13] and u["home_qb_id"] != row[13]:
            bad["qb"].append(gid)

    check(3, "every score matches upstream", not bad["score"], f"{len(bad['score'])}")
    check(3, "week/playoff_round conform to upstream game_type", not bad["week"], f"{len(bad['week'])}")
    check(3, "every spread matches upstream", not bad["line"], f"{len(bad['line'])}")
    check(3, "every PRESERVED upstream rest-day value still matches upstream",
          not bad["rest"], f"{len(bad['rest'])}")
    check(3, "every starting-QB id matches upstream", not bad["qb"], f"{len(bad['qb'])}")
    # D15 the other way round: the CORRECTED column must differ from upstream on
    # exactly the 34 rows the correction touches, and agree everywhere else. If
    # the correction silently stopped applying, this is what notices.
    diverge = set()
    want = {(g, f) for g, f in corrections.D15_REST}
    for gid, franchise, rest, rest_up in conn.execute(
            """SELECT game_id, franchise_id, rest_days, rest_days_upstream
               FROM team_game"""):
        if rest is None or rest_up is None:
            continue
        if rest != rest_up:
            diverge.add((gid, franchise))
    check(3, "the corrected rest_days diverges from upstream on exactly D15's 34 rows",
          diverge == want, f"{len(diverge)} diverge, symmetric_difference="
                           f"{sorted(diverge ^ want)[:3]}")

    row = conn.execute("""SELECT spread_line,total_line,home_moneyline,odds_source
                          FROM game_line WHERE game_id='2017_04_CHI_GB'""").fetchone()
    u = up.get("2017_04_CHI_GB")
    check(3, "the odds-patched row matches upstream on spread and total",
          row and u and abs(row[0] - float(u["spread_line"])) < 1e-9
          and abs(row[1] - float(u["total_line"])) < 1e-9, f"db={row} up={u and u['spread_line']}")
    check(3, "the odds-patched row supplies only prices upstream lacks",
          row and row[2] == -357 and row[3] == "manual-2026-07-27" and u and not u["home_moneyline"])

    if os.path.exists(t2):
        upp = {}
        for r in read_csv(t2):
            upp[(r["player_id"], as_int(r["season"]), as_int(r["week"]),
                 r["season_type"] or "REG")] = r
        dbp = {(r[0], r[1], r[2], r[3]): r for r in conn.execute(
            """SELECT gsis_id,season,week,season_type,passing_yards,rushing_yards,
                      receiving_yards,targets,receptions
               FROM player_game_stats WHERE season=2023""")}
        common = set(upp) & set(dbp)
        check(3, "2023 player-week keys overlap upstream substantially",
              len(common) > 10000, f"{len(common)} common of {len(dbp)} db / {len(upp)} upstream")
        mismatch = [k for k in common
                    if (as_int(upp[k]["passing_yards"]), as_int(upp[k]["rushing_yards"]),
                        as_int(upp[k]["receiving_yards"]), as_int(upp[k]["targets"]),
                        as_int(upp[k]["receptions"]))
                    != (dbp[k][4], dbp[k][5], dbp[k][6], dbp[k][7], dbp[k][8])]
        check(3, "every 2023 player-week stat line matches upstream exactly",
              not mismatch, f"{len(mismatch)} of {len(common)} e.g. {mismatch[:2]}")
        os.unlink(t2)
    os.unlink(t1)


#: The five nflverse extracts this build reads, with the row floor each must
#: clear. raw/ is gitignored -- it is 316 MB of regenerable CSV -- so a fresh
#: clone has none of it. Fail here with the command that fixes it rather than
#: 40 lines into build() with a FileNotFoundError traceback.
REQUIRED_RAW = [
    ("players.csv", 25_000),
    ("rosters.csv", 43_000),
    ("snap_counts.csv", 324_000),
    ("player_stats.csv", 287_000),
    ("depth_charts.csv", 1_100_000),
]


def preflight_raw():
    """Verify the raw extracts exist and are not truncated.

    The row floors are not decoration. nflverse serves empty-but-well-formed
    files when a season has no data, and a header-only file parses perfectly --
    that is exactly how this database silently carried zero 2012 snap counts.
    A short extract is a corruption risk, so it stops the build.
    """
    # PRESENCE of every declared mandatory input -- upstream extracts AND the
    # repository-owned semantic inputs -- comes from the canonical contract, so a
    # second static list can never drift from it. An audit-hook trace of a real
    # build opens 12 data files; the old list here named 5.
    ok, failures = build_inputs.preflight(root=ROOT, raw_dir=RAW)
    if ok:
        # Presence is not validity. Malformed T4 is knowable at startup, so it must
        # not surface minutes later after the database has been built.
        espn_identities.load(root=ROOT)
        # Same reasoning for the accepted identity baseline: whether the reviewed
        # evidence is WELL-FORMED is knowable before a database exists, and is a
        # separate question from whether this build AGREES with it (that needs the
        # derived identities, so it runs in pass 2).
        identity_baseline.load_baseline(root=ROOT)
    if not ok:
        print("\n" + "=" * 68, file=sys.stderr)
        for spec, resolved in failures:
            print(build_inputs.format_failure(spec, resolved), file=sys.stderr)
            print("", file=sys.stderr)
        print("=" * 68, file=sys.stderr)
        sys.exit(1)

    missing, short = [], []
    for name, floor in REQUIRED_RAW:
        path = os.path.join(RAW, name)
        if not os.path.exists(path):
            missing.append(name)
            continue
        with open(path, newline="", encoding="utf-8", errors="replace") as fh:
            n = sum(1 for _ in csv.reader(fh)) - 1
        if n < floor:
            short.append(f"{name}: {n:,} rows, below the {floor:,} floor")

    if not missing and not short:
        return

    print("\n" + "=" * 68, file=sys.stderr)
    if missing:
        print(f"Cannot build: {len(missing)} of {len(REQUIRED_RAW)} raw extracts "
              f"are missing from\n  {RAW}\n", file=sys.stderr)
        for name in missing:
            print(f"  missing  {name}", file=sys.stderr)
        print("\nThis directory is gitignored (316 MB of regenerable CSV), so a "
              "fresh clone\nnever has it. Fetch the extracts, then re-run this "
              "build:\n\n  python3 scripts/data/nfl-db/fetch_raw.py\n\n"
              "Provenance and column-level notes for each extract are in\n"
              "  scripts/data/nfl-db/EXTRACT-NOTES.md", file=sys.stderr)
    if short:
        print("\nTruncated extracts -- these parse cleanly but are short, which is "
              "how an\nempty upstream release silently becomes a missing season:\n",
              file=sys.stderr)
        for s in short:
            print(f"  {s}", file=sys.stderr)
        print("\n  python3 scripts/data/nfl-db/fetch_raw.py --force", file=sys.stderr)
    print("=" * 68 + "\n", file=sys.stderr)
    sys.exit(2)


def main():
    skip_external = "--no-external" in sys.argv
    preflight_raw()
    # Hash every declared input BEFORE anything reads one. Hashing only at the
    # end cannot tell a stable input from one that was rewritten mid-build, and
    # a database assembled from two different versions of a file is not the
    # product of either.
    pre_inputs = build_provenance.semantic_inputs()
    rows, hist, new, teams, venues = (load_json(UNIFIED), load_json(HIST),
                                      load_json(NEW), load_json(TEAMS), load_json(VENUES))
    tmp = DB_PATH + ".tmp"
    for p in (tmp, tmp + "-journal"):
        if os.path.exists(p):
            os.unlink(p)
    conn = connect(tmp)
    print("loading...")
    counts = build(conn, rows, teams, venues)
    print("  " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    print(corrections.summary())

    pass_structural(conn)
    pass_reconciliation(conn, rows, hist, new, counts)
    conn.commit()
    pass_rowloss(tmp, counts)
    if skip_external:
        print("\nPASS 3 - EXTERNAL: skipped (--no-external)")
    else:
        pass_external(conn)

    failed = [(p, n) for p, n, ok, _ in results if not ok]
    print("\n" + "=" * 68)
    for p in (1, 2, 3):
        sub = [r for r in results if r[0] == p]
        if sub:
            print(f"  PASS {p}: {sum(1 for r in sub if r[2])}/{len(sub)} checks passed")
    print(f"  TOTAL: {len(results)-len(failed)}/{len(results)}")
    if failed:
        print("  FAILED:", failed)
        conn.close()
        os.unlink(tmp)
        sys.exit(1)

    conn.execute("ANALYZE")
    conn.commit()

    # Provenance is computed BEFORE the database is published, and a failure
    # here fails the build. A database nobody can tie to the bytes that made it
    # is not a deliverable: every downstream reconciliation would be comparing
    # it against whatever happened to be sitting in raw/ at the time.
    print("\nprovenance...")
    try:
        doc = build_provenance.build_manifest(
            conn, require_clean=False, pre_inputs=pre_inputs)
    except build_provenance.ProvenanceError as exc:
        print(f"  BUILD REJECTED: {exc}")
        conn.close()
        os.unlink(tmp)
        sys.exit(1)
    canon = doc["canonical"]
    print(f"  input  {canon['input_fingerprint']}")
    print(f"  build  {canon['build_fingerprint']}")
    print(f"  output {canon['output_fingerprint']}")
    if canon["dirty"]:
        print("  NOTE: built from a dirty worktree -- this database is usable "
              "but is NOT accepted reproducibility evidence")

    conn.close()
    os.replace(tmp, DB_PATH)
    with open(build_provenance.manifest_path(DB_PATH), "w") as fh:
        json.dump(doc, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"\n  wrote {DB_PATH} ({os.path.getsize(DB_PATH)/1e6:.1f} MB)")
    print(f"  wrote {build_provenance.manifest_path(DB_PATH)}")


if __name__ == "__main__":
    main()
