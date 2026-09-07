# Integrated review — local football candidate

Candidate: baseline `9fe59f13235d77df98e560e6df1929aec4613ec2` plus the exact content hashes in `candidate-manifest.json`. Review is local, not a production certification or an independent human approval.

## Boundaries reviewed

- Existing `games` and `odds_history` retain ownership of current markets and history. Football observations contain no model fields. No new dependency, queue, service, Admin-editor workflow, or history store was added.
- Action Network current prices require full-game, pregame DraftKings identity. VSiN split thresholds remain source context, never substitute Action Network prices. Football percentages do not synthesize a missing opposite side.
- Provider identity, source fingerprints, watermarks and replay keys are checked by the existing transactional updater. Mocked regressions exercise failures and unchanged model fields; real transaction isolation and deployed overlap remain unverified.
- NFL routes, names and helmets resolve through the football registry. Feed/Splits navigation preserves game/date/league, including Back. Cursor history uses `(scrapedAt, id)` and 200-row pages; the browser fixture exercises 451 observations.
- Helmet generation reused existing files first. All 32 NFL assets are distinct and present. September 7–13 has 30 scheduled NFL teams, plus 173 NCAAF teams: 124 existing and 49 newly generated illustrations. The unknown-team NCAAF logo fallback was removed. Generated images are not certified game-day uniform depictions.

## Findings resolved during this execution

- Fixed full-season schedule handling to accept exact, validated ESPN identities outside the old fixed NCAAF catalog; contradictory known IDs/abbreviations remain rejected.
- Fixed VSiN team-path validation and contradictory percentages; corrected an obsolete `/cfb/teams/` test fixture to the actual `/college-football/teams/` contract.
- Fixed standalone Splits canonicalization during Back navigation so stale route parameters cannot redirect to the departing URL and discard the game query.
- Fixed the NFL Splits heading/freshness label and narrow-screen filter overflow. No card redesign or authored motion added.
- Corrected one rejected Wagner generation using a verified team-mark reference. All generated files and mappings were visually inspected; the rejected image was not packaged.

## Verification limitations

- Synthetic browser prices and users are test inputs, not provider observations or authenticated production evidence.
- The existing Impeccable detector returned an empty finding array. Rendered browser evidence is recorded separately; it is not proof of production routing or access control.
- Final browser matrix: 8/8 passed in existing Chrome at 375, 768, 1024 and 1440 pixels, both themes, both pilots per case. Inspected model and Splits screenshots in light/dark and mobile/tablet, plus earlier expanded-history views. Helmet assets load, all 451 observations remain reachable, Back retains context and no page overflow/uncaught error was reported. Cold Vite readiness uses a bounded 30-second initial assertion; this is not a production latency measurement.
- Non-blocking visual limitation retained: the 768px Splits heading/freshness line is crowded. Provider-specific freshness remains readable again on each card. No unrelated visual redesign was made.
- Action Network remains unavailable locally (403). The final repository access preflight exits 1 because independent root-owned executable provenance is unavailable. No credential-bearing fallback was attempted.
- Additive migration, real database rollback/replay, authorized runtime ingestion, reviewed PR/merge, Railway activation, three scheduled pilot cycles and 24-hour expanded observation remain blocked/unperformed. No production data or configuration was changed.
