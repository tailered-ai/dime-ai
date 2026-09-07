# Football card cleanup — 2026-09-07

Status: implemented locally; not deployed. Owner visual approval and required CI remain release gates.

Baseline: `2e9ecea7558015383629b177325ebdf25883ceb3`, branch `codex/shipyard/football-card-cleanup`.
Lead: Impeccable (single implementation/review pass). Advisor: verification-before-completion. Scope: [brief.yaml](brief.yaml).

## Changes

- Deleted the shared football freshness/split-threshold commentary and its callers.
- Removed provider labels beneath history timestamps and provider explanatory paragraphs. Stored provenance, independent source timestamps, zero/100% handling, book prices and model fields are unchanged.
- Reused the CFP football outline/laces from the existing SVG; removed the wordmark and backing. Static SVG lighting/shadow gives shallow 3D depth with real alpha transparency. No dependency or animation added.
- Two generated raster attempts had opaque checkerboards and were rejected, not shipped. The native SVG preview was inspected and reported `srgba`, four channels, `opaque=False`.

## Verification

| Check | Observed result |
| --- | --- |
| Before-fix regression | 2 failed / 7 passed: source note and Action Network label still rendered (terminal output, not a saved raw log) |
| TypeScript and focused tests | PASS, 180 tests in 4 files; [verbatim output](typecheck-tests.txt) |
| Football integration browser suite | 8 passed across 375/768/1024/1440, dark/light and reduced motion; source copy absent, 451 history rows reachable; [output](browser.txt) |
| Build | PASS; [output](build.txt); critical-path gzip 217,091 bytes / 222,538 budget |
| Full local gate | Exit 0: 5,461 passed, 64 failed, 40 skipped, 1 todo. All 64 failures classified environment-bound by the existing gate; no allowlist edits. Not an all-tests-green claim. Raw log: `.unlazy/football-market-automation/card-cleanup-suite.log` |
| Local built-server smoke | 10/11 passed; build identity fails because the local dirty build has no Railway commit variable. DB schema unknown with the intentional dummy local DB. [Output](smoke.txt). Not deployment proof. |
| Older September 5 browser suites | Three scenarios failed before reaching history: obsolete `Model: MSU` versus current `Michigan State`, and `.matchup__line` selecting both responsive copies. [Output](legacy-browser.txt). Team-name/line rendering was not changed by this patch; unrelated repairs deferred. |
| Impeccable detector | Two warnings on unchanged GameCard side borders; [output](impeccable-detect.json). No new finding repaired outside scope. |
| Motion review | N/A: static SVG filter, no motion changes |
| WebKit/Firefox | Not run; Chromium/installed Chrome only |

Browser checks use deterministic fixtures, not production-provider evidence. Screenshots remain local under `screenshots/` per repository PNG policy. Spot-inspected NCAAF 375px light card and 1440px dark history; all viewport cases have automated overflow and visibility assertions.

## Live NCAAF splits

Public `games.list` capture at 2026-09-07T16:37:50Z: [live-ncaaf-splits.json](live-ncaaf-splits.json). SMU–FSU game `4410001` maps to VSiN `20260907CFB00153`.

| Market | Tickets (away/over, home/under) | Handle (away/over, home/under) |
| --- | --- | --- |
| Spread | 76 / 24 | 77 / 23 |
| Total | 74 / 26 | 64 / 36 |
| Moneyline | 59 / 41 | 55 / 45 |

These match the independently fetched existing backend scraper result from `https://data.vsin.com/betting-splits/?source=DK&sport=CFB`, receivedAt `1788798684530`, response SHA-256 `24aa2bcb281dd2888257dab15a72c1b0d575493cf0cc85675c2b0f4497dc7e42`. That scrape parsed 54 posted CFB games. This verifies the SMU pilot, not publication of every posted fixture. No provider writes or model changes were needed.

## Release

Reviewed PR/Railway path only. No schema change. Request `prez-tailered-ai` visual review; do not impersonate approval. After approved merge, verify the exact merged SHA at `/health`, run the existing public smoke check, and inspect authenticated football cards/history. Revert this code patch on regression; retain source observations and history. Baseline rollback target is the SHA above.
