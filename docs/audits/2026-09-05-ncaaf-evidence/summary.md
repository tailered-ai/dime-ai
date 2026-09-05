# September 5 NCAAF publication

Owner scope: 68 games in the supplied Book vs Model attachment, including its added Fordham–North Dakota State matchup. The subsequent UCLA–California correction supersedes that table alone.

Baseline: main 53b9dfd51eff5fea7feb32cd18d596b7260339d8; the authenticated September 5 feed displayed MLB and zero NCAAF cards. The existing NCAAF registry excluded 38 participating FCS teams.

The release uses the existing model feed and Betting Splits / Odds History tools. All 68 games receive supplied model spreads, totals and four model prices. Model moneylines and scores were not provided and remain unavailable. No new model fitting or price estimation occurs. Each model price retains its supplied Book threshold; comparisons are suppressed when the AN Book threshold differs or the model-price binding cannot be verified. UCLA uses the owner's corrected four -110 Book prices only in the model comparison; the API Book prices remain intact in the odds tools.

Primary Book data is the Action Network public API's DraftKings NJ book 68, pregame event period, excluding live and alternate outcomes. All 68 totals and 64 two-sided spreads are available; 42 moneylines have both sides and four have only the away quote. No Open, consensus or other-book fallback fills missing data. Capture time is 2026-09-05T16:27:07.498Z; the provider supplies no observation timestamp.

VSiN's DK section supplies spread and total splits for all 68 and moneyline splits for 49. The other 19 source ML markets are unposted. Current capture: 2026-09-05T16:26:26.891Z. Historical source coverage is the opening/first-full/last-25-change window, not complete lifetime history: 1,817 distinct VSiN observations plus 68 AN API captures. Independent source percentages, including 37 rounded pairs totaling 101%, are preserved. VSiN does not supply spread/total juice; history leaves those prices blank rather than borrowing a different observation's prices.

The bounded SQL publisher validates the complete slate before any write, rejects duplicate/cross-event identities and conflicting history, changes only whitelisted schedule/Book/split/model/publication fields, preserves existing live state and other rows, appends missing history, and verifies preserved fields before commit. The workflow performs a fresh readback after publication. No schema or authentication change.

Source provenance and input hashes are recorded in source-provenance.json. Model source metadata stays server-side; anonymous model fields remain stripped by the existing gate. The compact verified ESPN team registry is separate from the FBS training registry.

Local verification: source replays reconcile 68 events/136 team IDs without collisions; all times match the owner slate, Mercyhurst is 9 PM ET and Baylor–Auburn is neutral. Initial focused run: 191 tests passed. Full sandbox run: 5,199 passed, 94 failed, 89 pending of 5,383; failures require missing DB/provider credentials or blocked local sockets/IPC, and the environment gate correctly remained red. Required GitHub CI with its isolated DB is the release gate. Final focused/browser/build evidence and exact remote results are recorded in the PR.

Visual scope: existing cards, navigation, typography, colors, keyboard controls and layout reused. Additional model pricing thresholds occupy the existing Model cells; current spread/total tool headings include prices. Targeted observations cover 375px dark and 1440px dark/light. No motion added. Screenshots are authenticated fixtures built from the exact source records, not production readback.

Deployment: merging main auto-deploys Railway. Publish only after required checks and independent latest-head approval, then run the bounded workflow and verify the live feed and tools. Rollback: revert the release to baseline 53b9dfd51eff5fea7feb32cd18d596b7260339d8; retain immutable source/history observations. Do not delete unrelated rows or rewrite observations to roll back UI.
