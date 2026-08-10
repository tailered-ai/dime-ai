# OPEN BLOCKER — Layer C identity regression on a fresh build

Found 2026-08-09 by the first full build run after provenance was wired
(Phase 11 §29). Session 2 terminal closeout.

## The failure

```
PASS 1: 45/45     PASS 2: 115/116     PASS 3: 12/12     TOTAL 172/173

[PASS] Layer A: depth_chart historical facts are unchanged
[PASS] Layer B: depth_chart source-owned identity is unchanged
[PASS] every frozen depth_chart row is governed by exactly one identity mechanism
[INFO] Layer C: 204 accepted (171 resolved / 33 unresolved), verdict FAIL
[FAIL] Layer C: no accepted identity was lost or reassigned --
       B 4578937: previously resolved identity became unresolved
       (the T4-regression class); no fill-rate percentage excuses it
```

Case B. One accepted identity regressed from resolved to unresolved. The build
exited non-zero and deleted its output, so nothing shipped.

## What it is not

- **Not data loss.** Row-loss reconciled on all eight tables in the same run.
- **Not a wrong-person mapping.** No row was reassigned to a different person;
  Case C did not fire.
- **Not frozen-history corruption.** Layer A passed — the immutable facts of the
  frozen window are byte-identical to their pin.
- **Not source-identity movement.** Layer B passed.

Exactly one thing moved: the DERIVED identity for one source key.

## The identity

```
espn_id                     4578937
accepted gsis_id            CON687807
name                        Nik Constantinou   (P)
evidence_tier_at_admission  T0
evidence_rows_at_admission  126
```

One of only two accepted mappings whose gsis_id is not in `00-\d+` form (the
other is 5278715 / BAR591037, Dante Barnett — also T0).

## What the inputs actually contain

| fact | value |
| --- | --- |
| `players.csv` contains `CON687807` | yes (1 row) |
| `players.csv` contains "Constantinou" | yes |
| `rosters.csv` contains either | no |
| `depth_charts.csv` rows for espn 4578937 | 126 — matches `evidence_rows_at_admission` exactly |
| accepted build `player` row | `CON687807 | Nik Constantinou | P` |
| accepted build depth_chart rows | 126 at `gsis_source='T0'` + 280 at `'feed'` |

So the player exists in the current input, the depth-chart rows exist in the
current input, and the frozen rows are provably unchanged. The crosswalk simply
no longer reaches the identity it previously reached.

## Attribution is currently impossible, and that is the point

The regression is either input-caused or code-caused. It cannot be decided from
evidence, because **the accepted database has no provenance manifest** — it was
built before Phase 11 existed. There is no record of which bytes or which code
revision produced it, so "did the inputs change" has no answer.

This is the exact gap Phases 10–11 close going forward, demonstrated by the
first build run after wiring them. Every build from here carries an input
fingerprint, a build fingerprint and a code revision; this one question would
have been a one-line diff.

## Next step

Isolate by holding one variable fixed:

1. Build at the code revision that produced the accepted database, using the
   current inputs. Resolves → the code changed the derivation. Regresses → the
   inputs changed.
2. That revision must itself be established by search (build date 2026-08-08,
   predating the Phase 8 merges), since no manifest records it.

Do not re-accept the identity into `accepted-identities.json` to make the build
green. Acceptance is reviewed evidence and may not be generated from the state
it polices; a regression that is accepted away is a regression that shipped.

## Status

```
PHASE 11        COMPLETE  (§29 trace: 13 semantic reads = 13 declared, undeclared = 0)
PHASE 9         BLOCKED   (unchanged)
THIS FINDING    OPEN      blocks Phases 14, 15, 16, 21 and 28 --
                          every one of them requires a build that completes
```
