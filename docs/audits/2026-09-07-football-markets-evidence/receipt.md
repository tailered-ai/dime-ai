# Football markets and helmet execution receipt

Status: **local implementation; not deployed; production gates incomplete.**

## Candidate and scope

- Repository worktree: `/Users/danielwalker/Documents/ChatGPT/Migration/football-market-automation`.
- Branch: `codex/shipyard/football-market-automation`; baseline HEAD `9fe59f13235d77df98e560e6df1929aec4613ec2`. Changes remain uncommitted. `candidate-manifest.json` binds the implementation, tests and assets to exact SHA-256 hashes.
- Original `ncaaf-september5/site` worktree, dirty files and private overlays were preserved. No new agent team, dependency, service, queue, Admin editor or parallel history system was used.
- Commands use Node 22.22.0 and pnpm 10.33.0 with existing dependencies. No GitHub, database or Railway mutation occurred.

## Helmets

**32 NFL teams; 32 distinct existing helmet files verified and reused.** Thirty NFL teams play within September 7–13, 2026. Denver and Kansas City are outside that window, not missing from the registry.

The same seven-day source inventory contains 87 NCAAF games and 173 distinct teams. All 173 have helmet files: 124 reused and 49 generated. The two leagues have zero unresolved participants or missing helmets in this captured window. Unknown NCAAF teams no longer fall back to team logos.

- `helmets-window-complete.json`: exact dates, source URLs, retrieval times, response fingerprints, ESPN identities, game keys, asset paths and hashes.
- `candidate-manifest.json`: all 32 NFL identities, asset paths and distinct hashes, including teams outside the window.
- `helmet-generation.json`: generation prompts, original output paths, packaged paths and rejected/replaced Wagner image provenance. Original files were retained. These are team helmet illustrations, not certified game-day uniform depictions.
- `scripts/checkFootballHelmets.mts` reuses the existing football schedule and rolling seven-day helper; it reports missing assets without synthesizing a logo fallback. Example: `pnpm exec tsx scripts/checkFootballHelmets.mts --date 2026-09-07`. Omit the date for today's Eastern window. This inventory is not a background image-generation service.

## Five-phase implementation status

| Phase | Implemented locally | Unverified/blocked |
| --- | --- | --- |
| 1 — Source capture | Existing MLB flow traced; both pilots have real VSiN DK captures and schedule identities | Action Network capture returns 403; no authenticated runtime observation |
| 2 — Persistence | Shared football validation, identity bindings, provider-specific provenance/replay, atomic updater and additive migration | Real persisted pilot equality and real transaction interruption/rollback |
| 3 — Automation | Seven-day AN windows, per-sport VSiN refresh, shared single-flight execution, writer gate, season seed/reconciliation, kickoff freeze and NFL scores | Deployed cycles, restart/overlap/outage proof; unresolved season fixtures remain excluded |
| 4 — Surfaces | NFL routes/names/helmets, persisted market presentation, independent freshness, date/game navigation and cursor history | Authenticated production comparison and complete source-backed pilot prices |
| 5 — Release | Focused checks, local suite, browser checks, build review and evidence collection | Guarded schema application, reviewed PR/merge, Railway activation, three pilot cycles and 24-hour expanded observation |

VSiN capture files retain both provider responses and parsed records. SMU–FSU is bound to VSiN `20260907CFB00153`; Patriots–Seahawks to `20260909NFL00061`. VSiN line values remain split context, not Action Network book prices. Browser fixtures are explicitly synthetic and never published. Model fields and original model pricing thresholds are not replaced by bookmaker values or invented probabilities.

## Verification

All evidence paths below are relative to this directory unless stated otherwise. The commands' logs retain failed attempts, warnings and skipped checks.

| Command / operation | Expected and observed | Exit / evidence |
| --- | --- | --- |
| Seven-day helmet inventory, `--date 2026-09-07 --out .../helmets-window-complete.json` | Every source-bound window team resolves to a local helmet; 173 NCAAF + 30 scheduled NFL, no missing/unresolved | 0; `helmets-window-complete.log/json` |
| `pnpm exec vitest run server/ncaafFeedGate.test.ts client/src/pages/dime-shell/DimeAppShell.test.ts shared/ncaafHelmets.test.ts --maxWorkers=2` | Correct provider fixture, query-preserving route contract and all 32 NFL assets; 19/19 passed | 0; `final-focused-recheck.log` |
| `pnpm exec vitest run --maxWorkers=2 --reporter=default --reporter=json --outputFile=vitest-verified-results.json`, then existing local environment gate | 5424 passed, 66 failed, 40 skipped, 1 todo. 64 failures are existing environment-bound checks; two authentication-closure tests timed out. Gate did not pass; allowlist unchanged | 1; `full-suite-verified.log`; repository-root `vitest-verified-results.json`, `env-verified-gate-report.json` |
| Impeccable detector on freshness/history/Splits components | Empty finding array; not a substitute for rendered review | 0; `design-detector.json/log`, `integrated-review.md` |
| Offline Drizzle schema generation | No additional schema drift; no database apply | 0; `schema-generation.log` |
| `pnpm agent:context` | Trusted runtime required; node execution blocked because independent root-owned provenance is unavailable | 1; `runtime-preflight-final.log` |

Final browser check: `PW_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec playwright test e2e/football-market-automation.spec.ts` exited **0**, **8/8 passed**. Both pilot games were exercised at 375/768/1024/1440 pixels in both themes with synthetic inputs, 451-row history, actual local helmet assets, Back navigation and no page overflow/uncaught errors. See `browser-readiness-final.log` and `screenshots/`. Earlier missing-browser and cold-start failures/interrupted runs are retained. No browser package was installed; the existing Chrome executable was reused. The final spec has a bounded 30-second initial cold-Vite readiness assertion.

Final `pnpm check` and `pnpm build` both exited **0**; see `types-verified.log` and `build-verified.log`. Production-preview exclusion passed. The built public directory contains all **205 distinct helmets** required by the 173-team college window plus the complete 32-team NFL registry, with **zero hash mismatches**. `git diff --check` exited 0. `verification-results.json` records source hashes, log fingerprints and timestamps. Candidate content fingerprint: `1da5c45e9d9c55c06eb10fe0a2f9a50d5988e36bb99b6b1bf04df5fc8b425c64`.

The two authentication-closure timeouts were rerun in isolation using the unchanged tests: `pnpm exec vitest run scripts/dime-authentication-closure.test.ts --maxWorkers=1 -t 'authentication bundle generation is deterministic|authentication candidate can be rebuilt'` exited **0**, **2 passed / 12 intentionally unselected** in 4.07 seconds (`closure-isolated-recheck.log`). The earlier full-suite gate remains recorded as failed; this targeted pass does not rewrite that result. Only the browser's initial cold-readiness assertion changed after the full suite; application/server code did not change.

## Release blocker

Credential-bearing execution requires the existing broker/executable chain to match independently administered trust roots. `runtime-preflight-final.log` is the current failed check. An administrator must restore that trusted runtime and provide a successful operation-specific preflight before authenticated AN collection or production actions can proceed. No SSH/credential verification bypass, same-user substitute attestation or fabricated source receipt was used.

The Unlazy ledger remains authoritative at `.unlazy/football-market-automation/GATES.md`. No production monitor or soak is running. A local asset or mocked test pass is not a live publication claim.
