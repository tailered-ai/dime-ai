#!/usr/bin/env python3
"""Unified normaliser for `raw/depth_charts.csv`, which ships TWO row shapes.

The file is a union of two different nflverse depth-chart releases:

  Shape A (552,514 rows, seasons 2010-2024) - the historical NFL/Elias feed.
      Populates: season, club_code, week, game_type, depth_team, last_name,
      first_name, football_name, formation, gsis_id, jersey_number, position,
      elias_id, depth_position, full_name.

  Shape B (554,215 rows, 2025-08-03 .. 2026-03-14) - a near-daily ESPN scrape.
      Populates: dt, team, player_name, espn_id, pos_grp_id, pos_grp, pos_id,
      pos_name, pos_abb, pos_slot, pos_rank, gsis_id (98.94%).
      season and week are EMPTY - but `dt` is a full ISO-8601 instant, so the
      season and the week the snapshot forecasts are both derivable.

The previous loader dropped every shape-B row on the grounds that they "have no
season or week column at all". That is true of the columns and false of the
data: this module recovers all 554,215 rows.

Import-time side effects: none. Nothing is read from disk or the network until
a function is called.

Self-check (processes the whole CSV, exits non-zero if any row fails):

    python3 scripts/data/nfl-db/lib/depth_charts.py
"""

from __future__ import annotations

import csv
import datetime as _dt
import json
import os
import re
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict

__all__ = [
    "classify_shape",
    "derive_season_week",
    "normalize",
    "POSITION_CROSSWALK",
    "GameCalendar",
    "build_espn_gsis_crosswalk",
    "load_team_map",
    "UNRESOLVED_NOTES",
    "unresolved_baseline_ids",
    "SHAPE_A_COLUMNS",
    "SHAPE_B_COLUMNS",
    "BUCKETS",
]

# --------------------------------------------------------------------------
# shape classification
# --------------------------------------------------------------------------

# Columns that only ever carry a value in one of the two shapes. `gsis_id` is
# deliberately excluded - it is the one column both shapes populate.
SHAPE_A_COLUMNS = (
    "season", "club_code", "week", "game_type", "depth_team", "last_name",
    "first_name", "football_name", "formation", "jersey_number", "position",
    "elias_id", "depth_position", "full_name",
)
SHAPE_B_COLUMNS = (
    "dt", "team", "player_name", "espn_id", "pos_grp_id", "pos_grp", "pos_id",
    "pos_name", "pos_abb", "pos_slot", "pos_rank",
)


def _v(row, name):
    """Value of `name`, or None when absent/empty/NA."""
    x = row.get(name)
    if x is None:
        return None
    x = x.strip() if isinstance(x, str) else x
    return None if x in ("", "NA", "NULL") else x


def classify_shape(row) -> str:
    """Return 'A' or 'B' for one CSV row (a mapping of column -> string).

    Raises ValueError when the row populates columns from both shapes or from
    neither. Verified over the full file: 552,514 pure-A, 554,215 pure-B, zero
    ambiguous, zero empty.
    """
    a = any(_v(row, c) is not None for c in SHAPE_A_COLUMNS)
    b = any(_v(row, c) is not None for c in SHAPE_B_COLUMNS)
    if a and not b:
        return "A"
    if b and not a:
        return "B"
    if a and b:
        raise ValueError("row populates both shape-A and shape-B columns")
    raise ValueError("row populates neither shape-A nor shape-B columns")


# --------------------------------------------------------------------------
# season / week derivation
# --------------------------------------------------------------------------

BUCKETS = ("preseason", "regular", "postseason", "offseason")
PLAYOFF_ROUNDS = ("WC", "DIV", "CON", "SB")

#: Week stamped on snapshots captured before the season's first regular-season
#: kickoff. They forecast week 1 and cannot leak (they precede every week-1
#: game), so week 1 is kept and `bucket='preseason'` marks them. Set to None to
#: null them out instead - the only line that needs changing.
PRESEASON_WEEK = "next"          # "next" -> week 1 ; None -> NULL


def _parse_ts(value):
    """Parse an ISO-8601 instant into a tz-aware UTC datetime."""
    if isinstance(value, _dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    s = str(value).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = _dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)


class GameCalendar:
    """Season/week boundaries derived from the `game` table.

    Two things are read off the schedule and nothing else:

      * ``open(S)``  = MIN(kickoff_utc) for season S - the week-1 opener.
      * ``close(S)`` = MAX(kickoff_utc) for season S - the Super Bowl.
      * ``last_reg(S)`` = MAX(kickoff_utc) for season S REG games.
      * the ordered list of *event openings*: the first kickoff of each
        regular-season week and of each playoff round, ascending.

    SEASON RULE.  Season S owns the half-open interval
    ``[boundary(S-1), boundary(S))`` where
    ``boundary(S) = close(S) + (open(S+1) - close(S)) / 2`` - the midpoint of
    the football-free dead zone between the Super Bowl and the next opener.
    Calendar year is NOT used: a 2026-03-14 snapshot is in the offseason that
    FOLLOWS the 2025 season, so it is season 2025, not season 2026.

    WEEK RULE.  A depth chart is a forecast. A snapshot is stamped with the
    first event (regular-season week or playoff round) whose *earliest* kickoff
    is strictly later than the snapshot instant. Strictly later is what makes
    the column leakage-free: every row labelled week W was captured before any
    week-W game started. Once the Super Bowl has kicked off there is no next
    event, so week and playoff_round are both NULL and bucket='offseason'.
    """

    def __init__(self, rows):
        """rows: iterable of (season, season_type, week, playoff_round, kickoff_utc)."""
        opens = defaultdict(list)          # season -> [(kickoff, week, round)]
        span = {}                          # season -> [min, max]
        last_reg = {}                      # season -> max REG kickoff
        first_post = {}                    # season -> min POST kickoff
        reg_weeks = defaultdict(int)       # season -> max REG week
        seen = {}
        for season, stype, week, rnd, kick in rows:
            season = int(season)
            k = _parse_ts(kick)
            key = (season, week, rnd)
            if key not in seen or k < seen[key]:
                seen[key] = k
            lo, hi = span.get(season, (k, k))
            span[season] = (min(lo, k), max(hi, k))
            if stype == "REG":
                last_reg[season] = max(last_reg.get(season, k), k)
                if week is not None:
                    reg_weeks[season] = max(reg_weeks[season], int(week))
            else:
                first_post[season] = min(first_post.get(season, k), k)
        for (season, week, rnd), k in seen.items():
            opens[season].append((k, int(week) if week is not None else None, rnd))
        self.opens = {s: sorted(v) for s, v in opens.items()}
        self.span = span
        self.last_reg = last_reg
        self.first_post = first_post
        self.reg_weeks = dict(reg_weeks)
        self.seasons = sorted(span)
        self.boundaries = []               # [(season, boundary_instant)]
        for i, s in enumerate(self.seasons[:-1]):
            close = span[s][1]
            nxt = span[self.seasons[i + 1]][0]
            self.boundaries.append((s, close + (nxt - close) / 2))

    # -- constructors ------------------------------------------------------
    @classmethod
    def from_sqlite(cls, conn):
        return cls(conn.execute(
            "SELECT season, season_type, week, playoff_round, kickoff_utc "
            "FROM game WHERE kickoff_utc IS NOT NULL"))

    @classmethod
    def from_db_path(cls, path):
        conn = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
        try:
            return cls.from_sqlite(conn)
        finally:
            conn.close()

    # -- lookups -----------------------------------------------------------
    def season_of(self, instant):
        s = self.seasons[0]
        for season, boundary in self.boundaries:
            if instant >= boundary:
                s = season + 1
        return s

    def next_event(self, season, instant):
        for kick, week, rnd in self.opens.get(season, ()):
            if kick > instant:
                return week, rnd
        return None, None

    def bucket_of(self, season, instant):
        open_, close = self.span[season]
        if instant < open_:
            return "preseason"
        if instant <= self.last_reg.get(season, open_):
            return "regular"
        if instant <= close:
            return "postseason"
        return "offseason"

    def reg_week_count(self, season):
        return self.reg_weeks.get(season)


def derive_season_week(dt, game_calendar):
    """Map an ISO-8601 snapshot instant to (season, week, playoff_round, bucket).

    `dt`   - ISO-8601 string ('2026-03-14T07:32:09Z') or a datetime.
    `game_calendar` - a GameCalendar, or any iterable of
        (season, season_type, week, playoff_round, kickoff_utc) tuples.

    Exactly one of `week` / `playoff_round` is non-NULL, except in the
    `offseason` bucket where both are NULL because season S has no games left.

    >>> # 2026-03-14 is the offseason AFTER the 2025 season, not season 2026.
    >>> # -> (2025, None, None, 'offseason')
    """
    cal = game_calendar if isinstance(game_calendar, GameCalendar) else GameCalendar(game_calendar)
    t = _parse_ts(dt)
    season = cal.season_of(t)
    bucket = cal.bucket_of(season, t)
    week, rnd = cal.next_event(season, t)
    if bucket == "offseason":
        return season, None, None, bucket
    if bucket == "preseason" and PRESEASON_WEEK is None:
        return season, None, None, bucket
    return season, week, rnd, bucket


# --------------------------------------------------------------------------
# position vocabulary
# --------------------------------------------------------------------------

#: Depth-chart SLOT label -> canonical side-agnostic slot.
#:
#: This crosswalks the one thing the two shapes genuinely share: the slot a
#: player is listed at on the chart (shape A `depth_position`, shape B
#: `pos_abb`). It does NOT produce a player's position - see below.
#:
#: Keys cover all 31 distinct shape-B `pos_abb` values (complete - every
#: shape-B row crosswalks) plus the shape-A `depth_position` labels that are
#: unambiguous (97.5% of shape-A rows).
#:
#: WHERE THE TWO HALVES ARE NOT EQUIVALENT - all four verified, see the report:
#:
#:   1. SLOT IS NOT POSITION. Shape A publishes both: `position` (the player's
#:      listed position) and `depth_position` (the slot). They disagree on
#:      157,804 of 538,440 crosswalkable shape-A rows (29.3%) - a WR listed at
#:      PR, a punter listed at H, a guard starting at RT, a 3-4 DE listed at
#:      DT. Shape B publishes ONLY the slot. So the unified record leaves
#:      `position` NULL for shape B rather than passing a slot off as a
#:      position; join `player.position` on gsis_id to get the real one.
#:   2. KR / PR / H are roles, not positions, and exist as first-class slots in
#:      both shapes. They say nothing about what the player plays.
#:   3. Shape A's `depth_position` is free text - 151 distinct values including
#:      team-authored scheme names ('LEO', 'JACK', 'OTTO', '$LB') and outright
#:      junk ('WR\\8', 'RB86', 'K222', '19'). Those stay unmapped, never guessed.
#:   4. `depth_order` scales differ: shape A `depth_team` is 1/2/3 (1st/2nd/3rd
#:      team); shape B `pos_rank` is 1..15 within a position. Not comparable.
POSITION_CROSSWALK = {
    # ---- offense (shape-B pos_abb, group '3WR 1TE')
    "QB": "QB",
    "RB": "RB",
    "FB": "FB",
    "WR": "WR",
    "TE": "TE",
    "LT": "T",
    "RT": "T",
    "LG": "G",
    "RG": "G",
    "C": "C",
    # ---- defense (shape-B pos_abb, groups 'Base 3-4 D' / 'Base 4-3 D')
    "LDE": "DE",
    "RDE": "DE",
    "LDT": "DT",
    "RDT": "DT",
    "NT": "NT",
    "LILB": "ILB",
    "RILB": "ILB",
    "MLB": "MLB",
    "SLB": "OLB",
    "WLB": "OLB",
    "LCB": "CB",
    "RCB": "CB",
    "NB": "CB",
    "FS": "FS",
    "SS": "SS",
    # ---- special teams (shape-B pos_abb, group 'Special Teams')
    "PK": "K",
    "P": "P",
    "LS": "LS",
    "KR": "KR",
    "PR": "PR",
    "H": "H",
    # ---- extra shape-A depth_position labels, unambiguous only
    "T": "T",
    "G": "G",
    "DE": "DE",
    "DT": "DT",
    "OLB": "OLB",
    "ILB": "ILB",
    "LB": "LB",
    "CB": "CB",
    "DB": "DB",
    "S": "S",
    "K": "K",
    "HB": "RB",
    "LE": "DE",
    "RE": "DE",
    "END": "DE",
    "NOSE": "NT",
    "N": "NT",
    "DL": "DT",
    "LOT": "T",
    "ROT": "T",
    "LOLB": "OLB",
    "ROLB": "OLB",
    "MILB": "ILB",
    "MOLB": "OLB",
    "SAM": "OLB",
    "WILL": "OLB",
    "WIL": "OLB",
    "MIKE": "MLB",
    "MIL": "MLB",
    "NCB": "CB",
    "NICK": "CB",
    "NICKE": "CB",
    "NKL": "CB",
    "MCB": "CB",
    "KOR": "KR",
    "KO": "K",
    "PK/K": "K",
    "FG": "K",
    "LWR": "WR",
    "RWR": "WR",
    "WR1": "WR",
    "WR2": "WR",
    "LTE": "TE",
    "RTE": "TE",
    "OC": "C",
}

#: Shape-B `pos_grp` -> shape-A `formation` (the unit the chart belongs to).
UNIT_BY_POS_GRP = {
    "3WR 1TE": "Offense",
    "Base 3-4 D": "Defense",
    "Base 4-3 D": "Defense",
    "Special Teams": "Special Teams",
}

#: nflverse/PFR-style abbreviations that appear in the player-level feeds but
#: never in the schedule feed. Mirrors build_db.py so a caller that supplies a
#: plain abbreviation->franchise map still resolves every row.
EXTRA_TEAM_ALIASES = {
    "OAK": 13, "STL": 14, "LA": 14, "SD": 24, "WAS": 28,
    "ARZ": 22, "BLT": 33, "CLV": 5, "HST": 34, "JAC": 30, "SL": 14,
}


def load_team_map(teams_json_path):
    """abbreviation -> ESPN franchise id, including the era/style aliases."""
    with open(teams_json_path) as fh:
        teams = json.load(fh)
    m = {t["abbreviation"]: t["espnId"] for t in teams}
    for a, fid in EXTRA_TEAM_ALIASES.items():
        m.setdefault(a, fid)
    return m


# --------------------------------------------------------------------------
# espn_id -> gsis_id crosswalk
# --------------------------------------------------------------------------

#: The 34 ESPN athlete ids (363 shape-B rows) that carry NO gsis_id and cannot
#: be resolved: nflverse's player universe (players.csv, 25,035 rows;
#: rosters.csv, 16 seasons) contains no player with that name AND that college.
#: Every one is a 2025 camp/practice-squad body who never reached a roster
#: nflverse publishes, so no GSIS id was ever minted. Absent, not missing.
#: Regenerate with build_espn_gsis_crosswalk(..., report_unresolved=True).
#:
#: DESCRIPTIVE ONLY since Phase 8. This is a human-readable note for each id that
#: was unresolved when the set was itemised; it is NOT the authority on which ids
#: are currently accepted as unresolved. That is accepted-identities.json, read
#: through unresolved_baseline_ids() below.
#:
#: Keeping it as an authority was already wrong: it still names 4431597 (Roc
#: Taylor) unresolved, which Phase 0R reviewed and accepted as RESOLVED to
#: 00-0040531, so it carried 34 ids against the accepted baseline's 33. The
#: entry is left in place deliberately -- it is true history of what was once
#: unresolved, and deleting it would erase the evidence that the two drifted.
UNRESOLVED_NOTES = {
    "4605489": "Damien Alford (Utah, WR, NO)",
    "4749258": "Boog Smith (South Carolina State, LB, NYJ)",
    "4361444": "Toa Taua (Nevada, RB, CLE)",
    "4578857": "Bruce Harmon (Stephen F. Austin, CB, DAL)",
    "4610703": "Jalen White (Georgia Southern, RB, GB)",
    "4570688": "Caden Davis (Ole Miss, PK, BUF)",
    "4695679": "JB Brown (Kansas, LB, DEN)",
    "4427569": "Giles Jackson (Washington, WR, PHI)",
    "5082289": "Kelly Akharaiyi (Mississippi State, WR, ARI/BUF)",
    "4572544": "Eli Mostaert (North Dakota State, DT, JAX)",
    "4574571": "Brent Matiscik (TCU, LS, CLE)",
    "4431597": "Roc Taylor (Memphis, WR, PIT)",
    "5278091": "Jordan Petaia (no college on ESPN, TE, LAC)",
    "4587977": "Sam Brown Jr. (Miami, WR, GB)",
    "4426484": "Marcus Major Jr. (Minnesota, RB, BAL)",
    "4429932": "Christian Johnstone (App State, LS, PHI)",
    "4578233": "Ryan Coe (California, PK, TB)",
    "4568671": "Jonathan Kim (Michigan State, PK, CHI)",
    "4430804": "Chris Tyree (Virginia, WR, NO)",
    "4426398": "David Gbenda (Texas, LB, TEN)",
    "4362248": "Anthony Torres (Toledo, TE, LA)",
    "4708127": "Monaray Baldwin (Baylor, WR, MIA)",
    "4690170": "DJ Thomas-Jones (South Alabama, FB, PIT)",
    "4686338": "Josh Minkins (Cincinnati, S, NE)",
    "4427389": "Hayden Harris (Montana, DE, BUF)",
    "4578080": "Ozzie Hutchinson (UAlbany, OT, BAL)",
    "4428132": "Tuasivi Nomura (Fresno State, LB, CAR)",
    "4569452": "Winston Wright (East Carolina, WR, CLE)",
    "4596596": "J.J. Jones (North Carolina, WR, JAX)",
    "4569496": "Tank Booker (SMU, DT, LV)",
    "4579667": "Pat Conroy (Old Dominion, TE, LV)",
    "4427243": "Brett Gabbert (Miami (OH), QB, MIA)",
    "4565535": "DK Kaufman (Northern Illinois, RB, SEA)",
    "4429488": "Fentrell Cypress II (Florida State, CB, WAS)",
}

def unresolved_baseline_ids():
    """THE authority on which source identities are accepted as unresolved.

    Derived from accepted-identities.json on every call rather than duplicated
    here. A second hand-maintained list is exactly how UNRESOLVED_NOTES came to
    disagree with reviewed acceptance about Roc Taylor without anyone noticing:
    it carried 34 ids where the accepted baseline carried 33.
    """
    import identity_baseline
    accepted, _ = identity_baseline.load_baseline()
    return identity_baseline.accepted_unresolved(accepted)


_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
_COLLEGE_ALIASES = {
    "ole miss": "mississippi", "usc": "southern california",
    "app state": "appalachian state", "ualbany": "albany",
    "miami (oh)": "miami (ohio)", "pitt": "pittsburgh",
    "uconn": "connecticut", "smu": "southern methodist",
    "ucf": "central florida", "utsa": "texas san antonio",
}


def _norm_name(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower().replace(".", "").replace("'", "").replace("`", "").replace("-", " ")
    s = " ".join(p for p in s.split() if p not in _SUFFIXES)
    return re.sub(r"\s+", " ", s).strip()


def _norm_college(s):
    s = unicodedata.normalize("NFKD", (s or "").replace("&amp;", "&"))
    s = s.encode("ascii", "ignore").decode().lower().strip()
    return _COLLEGE_ALIASES.get(s, s)


def _colleges(s):
    return {c for c in (_norm_college(p) for p in re.split(r"[;/]", s or "")) if c}


def _clean_espn(v):
    v = (v or "").strip()
    if v.endswith(".0"):
        v = v[:-2]
    return v or None


def build_espn_gsis_crosswalk(raw_dir, season=2025, espn_identities=None):
    """Build {espn_id: (gsis_id, tier)} for shape-B rows that lack a gsis_id.

    Five tiers, strongest first. Each is deterministic and re-runnable; none
    guesses. A row that no tier resolves is left NULL, never invented.

      T0  the same espn_id carries a gsis_id on another row of this same file
      T1  players.csv maps that espn_id to a gsis_id
      T2  rosters.csv maps that espn_id to a gsis_id
      T3  unique (normalised name, team, `season` roster) match in rosters.csv
      T4  unique (normalised name, college) match in players.csv / rosters.csv,
          using ESPN athlete records for the name+college (`espn_identities`)

    `espn_identities` - optional {espn_id: {"fullName":.., "college":..}} from
    https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/{id}
    Needed only for T4; without it T4 is skipped and those ids stay unresolved.
    """
    dc = os.path.join(raw_dir, "depth_charts.csv")
    have, need = {}, {}
    with open(dc, newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            eid = _clean_espn(row.get("espn_id"))
            if not eid:
                continue
            gid = _v(row, "gsis_id")
            if gid:
                have.setdefault(eid, gid)
            else:
                e = need.setdefault(eid, {"names": Counter(), "teams": Counter(), "rows": 0})
                e["rows"] += 1
                e["teams"][_v(row, "team")] += 1
                if _v(row, "player_name"):
                    e["names"][_v(row, "player_name")] += 1

    def _id_map(path):
        m = {}
        with open(path, newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                eid, gid = _clean_espn(row.get("espn_id")), _v(row, "gsis_id")
                if eid and gid:
                    m.setdefault(eid, gid)
        return m

    players_ids = _id_map(os.path.join(raw_dir, "players.csv"))
    roster_ids = _id_map(os.path.join(raw_dir, "rosters.csv"))

    by_name_team, by_name_college = defaultdict(set), defaultdict(set)
    with open(os.path.join(raw_dir, "rosters.csv"), newline="", encoding="utf-8",
              errors="replace") as fh:
        for row in csv.DictReader(fh):
            gid = _v(row, "gsis_id")
            if not gid:
                continue
            n = _norm_name(row.get("full_name"))
            if str(row.get("season")) == str(season):
                by_name_team[(n, _v(row, "team"))].add(gid)
            for c in _colleges(row.get("college")):
                by_name_college[(n, c)].add(gid)
    with open(os.path.join(raw_dir, "players.csv"), newline="", encoding="utf-8",
              errors="replace") as fh:
        for row in csv.DictReader(fh):
            gid = _v(row, "gsis_id")
            if not gid:
                continue
            n = _norm_name(row.get("display_name"))
            for c in _colleges(row.get("college_name")):
                by_name_college[(n, c)].add(gid)

    out = {}
    for eid, meta in need.items():
        if eid in have:
            out[eid] = (have[eid], "T0")
            continue
        if eid in players_ids:
            out[eid] = (players_ids[eid], "T1")
            continue
        if eid in roster_ids:
            out[eid] = (roster_ids[eid], "T2")
            continue
        names = [n for n, _ in meta["names"].most_common()]
        n = _norm_name(names[0]) if names else ""
        cands = set()
        if n:
            for team in meta["teams"]:
                cands |= by_name_team.get((n, team), set())
        if len(cands) == 1:
            out[eid] = (cands.pop(), "T3")
            continue
        ident = (espn_identities or {}).get(eid) or {}
        en, ec = _norm_name(ident.get("fullName")), _norm_college(ident.get("college"))
        if en and ec:
            c4 = by_name_college.get((en, ec), set())
            if len(c4) == 1:
                out[eid] = (c4.pop(), "T4")
                continue
    # espn_ids that already carry a gsis_id everywhere they appear
    for eid, gid in have.items():
        out.setdefault(eid, (gid, "feed"))
    return out


# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------

_UNIFIED_FIELDS = (
    "source_shape", "snapshot_ts", "season", "week", "playoff_round", "bucket",
    "season_type", "source_game_type", "source_week", "team_abbr",
    "franchise_id", "gsis_id", "gsis_source", "espn_id", "full_name",
    "jersey_number", "position", "depth_position", "depth_position_canonical",
    "depth_order", "unit", "scheme", "pos_slot", "elias_id",
)


def _as_int(v):
    if v in (None, "", "NA"):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _normalize_a(row, calendar):
    season = _as_int(_v(row, "season"))
    gt = _v(row, "game_type")
    src_week = _as_int(_v(row, "week"))
    week = rnd = None
    if gt == "REG":
        cap = calendar.reg_week_count(season) if calendar else None
        if cap is None or (src_week is not None and src_week <= cap):
            week, bucket, stype = src_week, "regular", "REG"
        else:
            # nflverse keeps counting weeks past the end of the regular season
            # and files the wild-card-weekend chart for ALL 32 teams under
            # game_type='REG'. There is no such game week, so no week is
            # invented: the period is recorded, the raw week is preserved in
            # source_week. Neither week nor playoff_round applies, so
            # season_type is NULL too - the row is neither REG nor POST.
            week, bucket, stype = None, "postseason", None
    elif gt in PLAYOFF_ROUNDS:
        rnd, bucket, stype = gt, "postseason", "POST"
    elif gt == "SBBYE":
        # the bye week between the conference championships and the Super Bowl
        rnd, bucket, stype = "SB", "postseason", "POST"
    else:
        raise ValueError("shape-A row has unknown game_type %r" % (gt,))
    depth_pos = _v(row, "depth_position")
    return {
        "source_shape": "A",
        "snapshot_ts": None,
        "season": season,
        "week": week,
        "playoff_round": rnd,
        "bucket": bucket,
        "season_type": stype,
        "source_game_type": gt,
        "source_week": src_week,
        "team_abbr": _v(row, "club_code"),
        "franchise_id": None,
        "gsis_id": _v(row, "gsis_id"),
        "gsis_source": "feed" if _v(row, "gsis_id") else None,
        "espn_id": None,
        "full_name": _v(row, "full_name") or _v(row, "football_name"),
        "jersey_number": _as_int(_v(row, "jersey_number")),
        "position": _v(row, "position"),
        "depth_position": depth_pos,
        "depth_position_canonical": POSITION_CROSSWALK.get(depth_pos),
        "depth_order": _as_int(_v(row, "depth_team")),
        "unit": _v(row, "formation"),
        "scheme": None,
        "pos_slot": None,
        "elias_id": _v(row, "elias_id"),
    }


def _normalize_b(row, calendar, espn_gsis):
    ts = _v(row, "dt")
    if ts is None:
        raise ValueError("shape-B row has no dt")
    if calendar is None:
        raise ValueError("shape-B rows need a game calendar to derive season/week")
    season, week, rnd, bucket = derive_season_week(ts, calendar)
    pos_abb = _v(row, "pos_abb")
    if pos_abb not in POSITION_CROSSWALK:
        raise ValueError("pos_abb %r missing from POSITION_CROSSWALK" % (pos_abb,))
    pos_grp = _v(row, "pos_grp")
    if pos_grp not in UNIT_BY_POS_GRP:
        raise ValueError("pos_grp %r missing from UNIT_BY_POS_GRP" % (pos_grp,))
    espn_id = _clean_espn(row.get("espn_id"))
    gsis, src = _v(row, "gsis_id"), "feed"
    if not gsis and espn_gsis:
        hit = espn_gsis.get(espn_id)
        if hit:
            gsis, src = (hit if isinstance(hit, tuple) else (hit, "crosswalk"))
    if not gsis:
        src = None
    return {
        "source_shape": "B",
        "snapshot_ts": ts,
        "season": season,
        "week": week,
        "playoff_round": rnd,
        "bucket": bucket,
        "season_type": "REG" if week is not None else ("POST" if rnd else None),
        "source_game_type": None,
        "source_week": None,
        "team_abbr": _v(row, "team"),
        "franchise_id": None,
        "gsis_id": gsis,
        "gsis_source": src,
        "espn_id": espn_id,
        "full_name": _v(row, "player_name"),
        "jersey_number": None,
        # Shape B never publishes the player's position, only the slot. Left
        # NULL on purpose: join player.position on gsis_id for the real one.
        "position": None,
        "depth_position": pos_abb,
        "depth_position_canonical": POSITION_CROSSWALK[pos_abb],
        "depth_order": _as_int(_v(row, "pos_rank")),
        "unit": UNIT_BY_POS_GRP[pos_grp],
        "scheme": pos_grp,
        "pos_slot": _as_int(_v(row, "pos_slot")),
        "elias_id": None,
    }


def normalize(row, calendar=None, team_map=None, espn_gsis=None, shape=None):
    """Turn one raw CSV row of either shape into the unified record.

    `calendar`  - GameCalendar (required for shape-B rows and for shape-A's
                  regular-season week cap; see GameCalendar).
    `team_map`  - {abbreviation: franchise_id}; when given, `franchise_id` is
                  filled. Alias coverage comes from EXTRA_TEAM_ALIASES.
    `espn_gsis` - {espn_id: gsis_id} or {espn_id: (gsis_id, tier)} from
                  build_espn_gsis_crosswalk(); fills gsis_id on the 5,577
                  shape-B rows the feed left blank.
    `shape`     - skip re-classification when the caller already knows it.

    Raises ValueError on anything it cannot place. Nothing is guessed.

    Field notes that matter when querying both halves together:
      * `depth_order` is 1..3 for shape A (1st/2nd/3rd team) and 1..15 for
        shape B (rank within the position). NOT the same scale.
      * `week` / `playoff_round` follow the repo convention (exactly one set),
        except in the `offseason` bucket and for shape-A rows whose
        `source_week` runs past the end of the regular season, where both are
        NULL and `bucket` carries the meaning.
      * `snapshot_ts` is NULL for shape A and is the honest key for shape B:
        it is the only field that says when the chart was actually captured.
    """
    if isinstance(calendar, (list, tuple)) or (calendar is not None
                                               and not isinstance(calendar, GameCalendar)):
        calendar = GameCalendar(calendar)
    s = shape or classify_shape(row)
    rec = _normalize_a(row, calendar) if s == "A" else _normalize_b(row, calendar, espn_gsis)
    if team_map:
        abbr = rec["team_abbr"]
        rec["franchise_id"] = team_map.get(abbr) or EXTRA_TEAM_ALIASES.get(abbr)
    return rec


# --------------------------------------------------------------------------
# self-check
# --------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_NFLDB = os.path.dirname(_HERE)
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_NFLDB)))

#: Re-exported from season_pins so there is ONE place these numbers live. They
#: describe SETTLED seasons only (<= season_pins.FROZEN_THROUGH); the 2026 season
#: publishes shape-B rows daily and is checked by conservation, not by a pin.
from season_pins import (  # noqa: E402
    DEPTH_CHART_EXTRACT_CUTOFF,
    FROZEN_THROUGH,
    FROZEN_SHAPE_A as EXPECTED_A,
    FROZEN_SHAPE_B as EXPECTED_B,
)

EXPECTED_FROZEN_TOTAL = EXPECTED_A + EXPECTED_B

#: The CHECK constraints proposed for the rebuilt `depth_chart` table, as
#: predicates over a normalised record. The self-check evaluates every one of
#: them against all 1,106,729 rows, so the DDL in the report is proven to hold
#: before anyone runs it.
DDL_CONSTRAINTS = (
    ("season in 2010..2026", lambda r: 2010 <= r["season"] <= 2026),
    ("source_shape in (A,B)", lambda r: r["source_shape"] in ("A", "B")),
    ("bucket in BUCKETS", lambda r: r["bucket"] in BUCKETS),
    ("week is null or 1..18",
     lambda r: r["week"] is None or 1 <= r["week"] <= 18),
    ("playoff_round in (WC,DIV,CON,SB) or null",
     lambda r: r["playoff_round"] in (None,) + PLAYOFF_ROUNDS),
    ("week and playoff_round are never both set",
     lambda r: r["week"] is None or r["playoff_round"] is None),
    ("season_type agrees with week/playoff_round",
     lambda r: ((r["week"] is not None and r["season_type"] == "REG")
                or (r["playoff_round"] is not None and r["season_type"] == "POST")
                or (r["week"] is None and r["playoff_round"] is None
                    and r["season_type"] is None))),
    ("neither week nor round only in postseason/offseason",
     lambda r: (r["week"] is not None or r["playoff_round"] is not None
                or r["bucket"] in ("postseason", "offseason"))),
    ("snapshot_ts is present exactly for shape B",
     lambda r: (r["source_shape"] == "B") == (r["snapshot_ts"] is not None)),
    ("every row carries gsis_id or espn_id",
     lambda r: r["gsis_id"] is not None or r["espn_id"] is not None),
    ("depth_order >= 1 or null",
     lambda r: r["depth_order"] is None or r["depth_order"] >= 1),
    ("pos_slot 1..12 or null",
     lambda r: r["pos_slot"] is None or 1 <= r["pos_slot"] <= 12),
    ("unit in (Offense,Defense,Special Teams) or null",
     lambda r: r["unit"] in (None, "Offense", "Defense", "Special Teams")),
    ("scheme in the four pos_grp values or null",
     lambda r: r["scheme"] in (None,) + tuple(UNIT_BY_POS_GRP)),
    ("source_week 1..22 or null",
     lambda r: r["source_week"] is None or 1 <= r["source_week"] <= 22),
    ("source_game_type in the six nflverse labels or null",
     lambda r: r["source_game_type"] in (None, "REG", "WC", "DIV", "CON", "SB", "SBBYE")),
)


def _self_check(raw_dir=None, db_path=None, teams_json=None, identities=None):
    raw_dir = raw_dir or os.path.join(_NFLDB, "raw")
    db_path = db_path or os.path.join(_NFLDB, "nfl.db")
    teams_json = teams_json or os.path.join(_ROOT, "scripts/data/nfl-2026/teams.json")
    # Path and parsing both come from lib/espn_identities -- the one T4 authority.
    # This used to resolve its own path AND fall back to the gitignored cache copy,
    # which is how build and self-check could disagree about the same file.

    fail = []

    def expect(name, ok, detail=""):
        print("    [%s] %s%s" % ("PASS" if ok else "FAIL", name,
                                 "" if ok else "  -- " + str(detail)))
        if not ok:
            fail.append(name)

    print("depth_charts.py self-check")
    if not os.path.exists(db_path):
        print("    [FAIL] nfl.db not found at %s" % db_path)
        return 1
    cal = GameCalendar.from_db_path(db_path)
    team_map = load_team_map(teams_json) if os.path.exists(teams_json) else None

    # Loud, not silent: without valid evidence T4 does not fire and 316 audited
    # rows lose their gsis_id, which used to look like upstream drift.
    import espn_identities as _t4
    try:
        _validated = _t4.load(path=identities) if identities else _t4.load()
    except _t4.T4InputError as exc:
        print("    [FAIL] T4 identity evidence unusable:%s" % exc)
        return 1
    ident = _validated.as_crosswalk_map()
    xwalk = build_espn_gsis_crosswalk(raw_dir, season=2025, espn_identities=ident)

    shapes, buckets, weeks = Counter(), Counter(), Counter()
    b_seasons, a_seasons = Counter(), Counter()
    total = errors = no_franchise = no_gsis = 0
    b_audited = no_gsis_audited = b_blank_source = 0
    unresolved = Counter()
    unresolved_audited = Counter()
    ddl_violations = Counter()
    keys = set()
    key_dupes = 0
    a_position_agree = a_position_check = slot_ne_position = 0
    b_pos_abb = Counter()
    path = os.path.join(raw_dir, "depth_charts.csv")
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            total += 1
            try:
                s = classify_shape(row)
                rec = normalize(row, cal, team_map, xwalk, shape=s)
            except Exception as exc:                        # noqa: BLE001
                errors += 1
                if errors <= 10:
                    print("    row %d: %s" % (total, exc))
                continue
            shapes[rec["source_shape"]] += 1
            buckets[rec["bucket"]] += 1
            if rec["source_shape"] == "B":
                weeks[(rec["week"], rec["playoff_round"])] += 1
                b_seasons[rec["season"]] += 1
                b_pos_abb[rec["depth_position"]] += 1
                k = (rec["snapshot_ts"], rec["team_abbr"], rec["scheme"],
                     rec["pos_slot"], rec["depth_order"])
                if k in keys:
                    key_dupes += 1
                keys.add(k)
                audited = rec["snapshot_ts"] <= DEPTH_CHART_EXTRACT_CUTOFF
                if audited:
                    b_audited += 1
                    # gsis_source is "feed" when the file supplied a gsis; any
                    # other value (a tier, or None) means the crosswalk had to
                    # try. That set is the fill rate's denominator.
                    if rec["gsis_source"] != "feed":
                        b_blank_source += 1
                if not rec["gsis_id"]:
                    no_gsis += 1
                    unresolved[rec["espn_id"]] += 1
                    if audited:
                        no_gsis_audited += 1
                        unresolved_audited[rec["espn_id"]] += 1
            else:
                a_seasons[rec["season"]] += 1
                a_position_check += 1
                if rec["depth_position_canonical"] is not None:
                    a_position_agree += 1
                    if rec["position"] and rec["depth_position_canonical"] != rec["position"]:
                        slot_ne_position += 1
            if team_map and rec["franchise_id"] is None:
                no_franchise += 1
            for name, pred in DDL_CONSTRAINTS:
                if not pred(rec):
                    ddl_violations[name] += 1

    # Pinned on the SNAPSHOT INSTANT, never on season. Shape-B rows have no
    # season column; it is derived from `dt` against the dead-zone rule, which
    # keeps filing snapshots under season S for ~3.5 months after S ends. A
    # season-keyed window therefore absorbs new rows and reports settled history
    # as rewritten -- see season_pins.DEPTH_CHART_EXTRACT_CUTOFF.
    b_frozen = b_audited
    b_live = shapes["B"] - b_audited
    expect("every row normalises", errors == 0, "%d failures" % errors)
    # Conservation, which holds at any volume: every streamed row got a shape.
    # This is what "row count is N" was really asserting before the source grew.
    expect("every source row is classified into a shape",
           total == shapes["A"] + shapes["B"],
           "%d streamed vs %d classified" % (total, shapes["A"] + shapes["B"]))
    expect("settled row count is %d" % EXPECTED_FROZEN_TOTAL,
           shapes["A"] + b_frozen == EXPECTED_FROZEN_TOTAL, shapes["A"] + b_frozen)
    expect("shape A = %d" % EXPECTED_A, shapes["A"] == EXPECTED_A, shapes["A"])
    expect("settled shape B = %d (was dropped entirely)" % EXPECTED_B,
           b_frozen == EXPECTED_B, b_frozen)
    expect("every row resolves a franchise_id", no_franchise == 0, no_franchise)
    expect("shape-B natural key (ts, team, scheme, slot, rank) is unique",
           key_dupes == 0, key_dupes)
    # Shape B began at 2025 and continues forward. Pinning it to {2025} broke the
    # moment 2026 published; asserting the FLOOR keeps both halves of the claim --
    # 2025 is present, and nothing earlier ever appears in shape B.
    expect("shape-B rows start at season 2025 and never precede it",
           bool(b_seasons) and min(b_seasons) == 2025, dict(b_seasons))
    expect("shape-A rows span 2010-2024", set(a_seasons) == set(range(2010, 2025)),
           sorted(a_seasons))
    # Both of these were whole-file aggregates measured over the 2026-07-27
    # extract, so every new snapshot moved them (the 2026 file alone adds 4,134
    # blank-gsis rows). Scoped to the audited window they mean what they were
    # written to mean; the newer rows are reported instead.
    # These two were exact pins on a DERIVED, DRIFT-SENSITIVE measurement: how
    # much of the ESPN->gsis crosswalk resolves depends on nflverse's players.csv
    # and rosters.csv, which are revised continuously. Scoping them to the
    # audited window is necessary but not sufficient -- a revision between
    # 2026-07-27 and 2026-08-07 alone cost 301 resolutions INSIDE that window
    # (363 -> 664 blank) and added 6 unresolvable espn ids. The same drift
    # silenced the name tier that resolved snap-count pfr id WillRo08.
    #
    # An exact count therefore cannot hold, and raising it to today's number just
    # re-arms the same trap. Gate on the fill RATE with a floor -- the pattern the
    # shape-A coverage check below already uses -- and report the movement, which
    # is the part a human should actually look at.
    # COVERAGE IS TELEMETRY, NOT AN AUTHORITY (Phase 8).
    #
    # This was `expect(... fill_rate >= 0.85 ...)`. A percentage can only see how
    # MANY identities are filled, never WHICH, so it is structurally blind to the
    # two defects that actually matter:
    #
    #   * a previously known person disappears -- 5 lost T4 mappings move the rate
    #     by a fraction of a point and sail over any floor;
    #   * a row is reassigned to a DIFFERENT person -- the rate does not move at
    #     all, because the count of filled identities is identical.
    #
    # Both now fail through the accepted identity baseline (Layer C), which
    # compares WHICH person each source identity resolves to against reviewed
    # acceptance. The rate is still worth looking at, so it is still reported --
    # it just no longer decides anything.
    fill_rate = 1.0 - (no_gsis_audited / b_blank_source) if b_blank_source else 1.0
    print("    [INFO] crosswalk fills %.1f%% of the audited window's blank-gsis "
          "rows (%d of %d still blank) -- telemetry; identity correctness is "
          "decided by the accepted baseline, not by this rate"
          % (fill_rate * 100, no_gsis_audited, b_blank_source))
    # The unresolved set is DERIVED from the accepted baseline. It used to be a
    # second, independently maintained list -- and the two had already drifted:
    # the list still named espn_id 4431597 (Roc Taylor) unresolved after Phase 0R
    # reviewed and accepted his resolution, so it carried 34 ids against the
    # baseline's 33. Two authorities for one fact eventually disagree; this one
    # already had.
    accepted_unresolved = unresolved_baseline_ids()
    added = sorted(set(unresolved_audited) - accepted_unresolved)
    gone = sorted(accepted_unresolved - set(unresolved_audited))
    if added or gone:
        print("    [INFO] unresolved espn_id set moved vs the %d accepted: "
              "%d new %s, %d now resolved %s"
              % (len(accepted_unresolved), len(added), added[:6],
                 len(gone), gone[:6]))
    if shapes["B"] > b_audited:
        print("    [INFO] %d shape-B rows newer than %s (%d still blank-gsis) -- "
              "reported, not pinned"
              % (shapes["B"] - b_audited, DEPTH_CHART_EXTRACT_CUTOFF,
                 no_gsis - no_gsis_audited))
    # Crosswalk invariants. Every shape-B slot label must map (enforced inside
    # normalize, which raises on an unknown pos_abb, so reaching here proves
    # it). The crosswalk must be idempotent and closed over its own values.
    expect("all %d proposed DDL constraints hold on all %d rows"
           % (len(DDL_CONSTRAINTS), total),
           not ddl_violations, dict(ddl_violations))
    expect("POSITION_CROSSWALK is idempotent",
           all(POSITION_CROSSWALK.get(v, v) == v for v in POSITION_CROSSWALK.values()),
           [v for v in set(POSITION_CROSSWALK.values())
            if POSITION_CROSSWALK.get(v, v) != v])
    # Asserted against the values this run actually observed, not against the
    # literal True. `_normalize_b` does raise on an unknown pos_abb, so the old
    # form was true -- but it INHERITED its truth from another function and
    # would have kept printing PASS if that guard were ever removed. An empty
    # observation also fails, so the check cannot pass by seeing nothing.
    unmapped = sorted(p for p in b_pos_abb if p not in POSITION_CROSSWALK)
    expect("all %d observed shape-B pos_abb values are mapped" % len(b_pos_abb),
           bool(b_pos_abb) and not unmapped, unmapped)
    expect("crosswalk covers >=97% of shape-A depth_position rows",
           a_position_check and a_position_agree / a_position_check >= 0.97,
           "%d/%d" % (a_position_agree, a_position_check))

    print("\n    shape-A slot label vs published position: %d of %d crosswalkable "
          "rows disagree (%.1f%%) - slot is not position, by construction"
          % (slot_ne_position, a_position_agree,
             100.0 * slot_ne_position / max(a_position_agree, 1)))
    print("    buckets: %s" % dict(buckets))
    print("    shape-B week/round histogram:")
    for k in sorted(weeks, key=lambda x: (x[0] is None, x[0] or 0,
                                          PLAYOFF_ROUNDS.index(x[1]) if x[1] else -1)):
        print("       week=%-4s round=%-4s %d" % (k[0], k[1], weeks[k]))
    print("\n%s" % ("SELF-CHECK PASSED" if not fail else "SELF-CHECK FAILED: " + ", ".join(fail)))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(_self_check())
