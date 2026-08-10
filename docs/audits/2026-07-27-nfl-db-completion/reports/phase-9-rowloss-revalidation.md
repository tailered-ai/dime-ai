# Phase 9 — semantic rowloss revalidation

Session 2 terminal closeout, 2026-08-09. Re-runs the B4 row-loss reconciliation
against the current build and reports what it actually establishes.

**Outcome: the reconciliation tool cannot currently produce valid row-loss
evidence.** Three defects in `scripts/data/nfl-db/lib/rowloss.py` are recorded
below. None of them is evidence of data loss, and this report does not claim
any. It claims the opposite: the control that would detect loss is not
currently able to.

## What was run

```
db   nfl-phase3.db          the accepted build (Layer A/B/C all PASS)
raw  scripts/data/nfl-db/raw
     depth_charts.csv  player_stats.csv  snap_counts.csv   2026-07-27
     players.csv       rosters.csv                         2026-08-07
```

| table | source rows | expected | loaded | excluded | unexplained | missing | clean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :--: |
| player | 25,038 | 25,038 | 26,570 | 0 | −1,532 | 0 | no |
| game | 4,648 | 4,648 | 4,648 | 0 | 0 | 0 | **yes** |
| game_line | 4,648 | 4,363 | 4,363 | 285 | 0 | 0 | **yes** |
| team_game | 9,296 | 9,270 | 9,270 | 26 | 0 | 0 | **yes** |
| player_game_stats | 287,184 | 286,843 | 286,843 | 341 | 0 | 13 | no |
| snap_count | 324,611 | 324,611 | 324,611 | 0 | 0 | 324,611 | no |
| roster_season | 43,856 | 43,856 | 46,786 | 0 | −2,930 | 43,852 | no |
| depth_chart | 1,106,729 | 552,514 | 1,517,160 | 554,215 | −964,646 | 550,735 | no |

Every declared exclusion still reconciles exactly — 285 / 26 / 341 / 554,215 all
MATCH their manifest entries, and no undeclared exclusion reason appeared. That
part of the mechanism works.

## F9-1 — snap_count compares two different identifier vocabularies

Counts agree **exactly** (324,611 source, 324,611 loaded) and **not one key
matches**. That combination cannot be row loss: losing 324,611 rows and gaining
324,611 others is not a failure mode any loader has.

```
DB     ('AaitIs00', '201310200mia')      PFR boxscore id
replay ('WillCh03', '2013_01_ARI_STL')   nflverse game_id
```

The database stores PFR-style game ids; the replay emits nflverse-style ones.
`rowloss.PFR_STYLE_ALIASES` exists, so the conversion was once understood —
`snap_crosswalk.py` was introduced afterwards and the replay was never updated
to match. Two authorities on one identifier, drifting apart, exactly as the
unresolved-espn-id list did before Phase 8.

Consequence: the snap_count row-loss control has been reporting
`missing = everything, extra = everything` — a signal nobody can act on, and one
that has been failing continuously rather than catching anything.

## F9-2 — no input-provenance binding

`rowloss.py` contains no reference to `build_inputs`, to a checksum, or to a
digest. It reconciles whatever happens to be in `raw/` against whatever happens
to be in `nfl.db`, with nothing asserting the two correspond.

That is how this run produced **negative** `unexplained` values (player −1,532,
roster_season −2,930, depth_chart −964,646). A negative unexplained count means
the database holds more rows than the source could have produced, which is only
possible when the source is not the source. The extracts here predate the build.

Until a build records the digest of every input it consumed, and the
reconciliation refuses to run against inputs whose digests do not match, no
number this tool prints about loss can be interpreted. This is the work of
Phase 10 (reproducibility contract) and Phase 11 (input provenance manifest).

## F9-3 — depth_chart is reconciled without frozen-window scoping

```
raw depth_charts.csv       1,106,729 rows
frozen window in the DB    1,106,729 rows      exact match
full depth_chart table     1,517,160 rows
```

The replay covers the frozen-era extract; the comparison query is
`SELECT * FROM depth_chart` with no window predicate, so 410,431 rows of
legitimate live 2026 growth are counted against a source that could not contain
them. Phase 3 established the frozen/live split precisely so that in-season
growth would stop fail-closing the build; the reconciliation never adopted it.

## What this does and does not say

- It does **not** show missing, lost, or corrupted rows. No such finding is made.
- It does show that three of the eight tables' loss controls are structurally
  incapable of detecting loss right now, and that a fourth
  (`player_game_stats`, 13 missing / 13 extra) needs the same input-binding
  question answered before its residue can be read.
- `game`, `game_line` and `team_game` reconcile clean, and the exclusion
  manifest reconciles exactly on every table — including the bidirectional
  check that rejects an undeclared exclusion reason.

## Phase 9 status

**BLOCKED on Phase 10/11.** Valid row-loss evidence requires inputs provably
identical to those the database was built from. Attempting to close Phase 9
against unbound inputs would produce either a false alarm or false confidence;
this report chooses neither.

The accounting invariants themselves are now covered by
`scripts/data/nfl-db/test_rowloss.py`, including a guard that rejects the
F9-1 signature — a table reporting simultaneous total-missing and total-extra is
classified as a vocabulary mismatch, not as loss.
