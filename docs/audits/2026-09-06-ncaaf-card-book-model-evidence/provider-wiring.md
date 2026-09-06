# NCAAF provider / card / history audit

Observed September 6, 2026, 19:38–20:03 UTC. **Implemented locally; not deployed.**
Structured per-game values, exact identities and limitations: [backend-audit.json](backend-audit.json).

## What is missing, and why

The production JSON and authenticated UI contain **three**, not four, NCAAF games. The fourth matchup was requested from the owner; no extra game was invented.

| Game | DraftKings book data | Model data | History |
| --- | --- | --- | --- |
| WSU / Washington (4350069, AN288813) | Total 51.5, Over -112 / Under -108. AN68 supplied no spread or moneyline at 19:59:21Z. | Owner's WSU +21.1 / Washington -21.1 / total 52.1. No fair prices/probabilities supplied; a percentage edge cannot be justified. | Initial total observation only. Missing spread/ML is a source gap, not a hidden available quote. |
| Wisconsin / Notre Dame (4350070, AN287973) | Spread +21 -105 / -21 -115; total 46.5 -108/-112; ML +1000/-1800. | No published model. | Initial spread/total/ML observation. |
| Louisville / Ole Miss (4350071, AN287972) | Spread +6.5 -105 / -6.5 -115; total 55.5 -105/-115; ML +210/-258. | No published model. | Initial spread/total/ML observation. |

Anonymous `games.list` deliberately redacts model fields. Model findings above use the authenticated owner UI and recorded publication, not anonymous nulls.

Four implementation causes were reproduced:

1. The deployed summary excludes unscored or unpublished model comparisons. Existing PR542 repairs this but is still open; Railway runs main `b061d836417859ab0de65849a604682425a2138d`, deployment `f9da4914-afe5-4a72-886d-0c43ccbb9e88` (SUCCESS).
2. The recurring market job and manual refresh enum omit NCAAF. Provider reads work; current VSiN percentages differ from the stored initial snapshot. All three live history panels show just the 2:54 PM ET publication capture.
3. Reusing `updateAnOdds` or `updateBookOdds` unchanged would overwrite the owner's **52.1 model total** with the **51.5 book total**. NCAAF must preserve these as different facts.
4. The splits page claims freshness using the global refresh time (including other sports). Its history empty state also promises a ten-minute refresh without evidence. These labels are misleading.

## Wiring implemented

Reuse the existing Action Network parser, VSiN `CFB` parser, publisher's verified crosswalk, scheduled/manual refresh orchestration, `games`/`odds_history` tables, tRPC endpoints and existing panels. No dependency, schema change, new scheduler, model engine or history system.

- Shared crosswalk preserves the exact three published AN event/team IDs, VSiN gamecodes/slugs, dates and kickoffs. Unknown, duplicate, reversed or changed identities are reported, never fuzzy-matched.
- AN68 full-game, non-live, non-alternate quotes only. No opening/Consensus/FanDuel substitution. Missing markets remain null; zero and exact decimal thresholds survive.
- One parent-locked transaction records book/split fields and the history snapshot together. Failure propagates; stale/replayed captures cannot overwrite newer observations. Model/publication fields are untouched. Started/non-upcoming games freeze pregame observations.
- The existing automatic job includes NCAAF today/tomorrow; owner-only `games.triggerRefresh({sport:"NCAAF"})` targets NCAAF and reports incomplete mapping/provider results. Other sports' market refresh behavior is preserved.
- Retrieval and persistence times use existing provenance columns, not fabricated provider timestamps or model-run times. The NCAAF page uses its own records' oldest capture, or explicitly says capture time unavailable.
- Existing history routes/panels remain gated. Empty states no longer promise an unsupported next-refresh interval; timestamps say ET rather than incorrectly implying standard time in September.

## Verification and concrete limitations

- Regression-first failures observed: strict AN selection (3 failures), NCAAF manual routing (failure), missing transactional helper (3 failures), and misleading freshness (built-browser failure). The original failed browser attempt is retained in `.unlazy/ncaaf-provider-wiring/browser-red/`.
- Final focused check: **189 passed, 0 failed, 0 skipped** across 14 files. Machine-readable runner evidence: `.unlazy/ncaaf-provider-wiring/focused-tests.json`. DB transaction tests use an isolated driver double; they are not production transaction receipts.
- Built browser: **9 passed**, using installed Chrome, 375/768/1024/1440 widths, both themes, reduced motion, keyboard/carousel behavior, truthful NCAAF capture label and all three history disclosures. API/auth fixtures are local. Gstack's bundled Chromium was unavailable; no browser/package installation or framework conversion was done.
- Node 22.22.0 typecheck and production build pass; server build repeated after final backend repairs. Preview-activation scanner passes. Bundle budget: 216,813 gzip bytes / 222,538 ceiling. Full repository/environment-dependent suite and post-deploy checks are not claimed.
- Real source-only check: existing `publishNcaafSeptember6.mts --check` returned `NCAAF_SEPTEMBER6_SOURCE_CHECK_PASS` at **19:59:21.328Z**; no database write.
- Real authenticated browser: existing `/betting-splits/ncaaf-09-06-2026` opens and all three histories expand. Anonymous `oddsHistory.listForGame` returns **401 UNAUTHORIZED**, no history.
- Latest inspected GitHub cron run `34051895445` was pending with no started jobs. This is not proof the separate background interval stopped; no workflow was approved or triggered.
- The shared crosswalk covers these three approved September 6 events only. Future slates require verified mappings. Existing history API still caps reads at 200; this change does not add unlimited pagination or recover unobserved past odds. Existing six away/over split columns and complementary opposite-side rendering remain unchanged.
- `agent:context` fails with independent root-owned provenance unavailable. No broker bypass, credential dump, source mutation, refresh trigger, merge or deployment occurred.

## Release hold

CI repair (September 6, 2026): run `34056870711` flagged formatting in `BettingSplits.tsx`, `actionNetworkScraper.ts`, and `vsinAutoRefresh.ts`; only those shipped files were reformatted. Run `34056867913` also exposed six Firefox assertion failures: transformed 44px controls measured 43.9999847px or 43.9999695px. The test now asserts exact 44px computed CSS width/height and permits only 0.0001px rendered-width roundoff; application geometry is unchanged. Current local verification: tracked-file Prettier check exit 0 (excluding the separately governed gitlink), 7 focused provider tests pass, and all 9 NCAAF Firefox browser cases pass with zero retries. The whole-working-directory formatter also inspected untracked historical evidence; those records were preserved rather than reformatted or added to Git. Required CI must rerun on the repair commit; no deployment claim.

Owner approval for the exact updated PR542 revision is required before merge (which auto-deploys Railway). After an approved release: verify deployed SHA, run the authorized NCAAF refresh while games are pregame, read back matching `games` and `odds_history` observations, verify models remain 52.1/±21.1, and repeat authenticated/anonymous UI/API checks. Do not fabricate missed pregame captures after kickoff. Code containment target remains main `b061d836417859ab0de65849a604682425a2138d`; retained historical data must not be rewound.
