# Feed controls and consistent cards

The owner screenshot reproduced a normal CSS grid reserving the tallest row height while adjacent cards rendered different content: a full fallback table beside a compact summary. The backend, tRPC/cache keys, Docker build, Express asset serving and Railway configuration were inspected; none creates the card gap. `architecture.md` records the trace.

This change uses compact fallback comparisons and stretches every lifecycle card naturally within its ordered row. Detailed pricing remains in the existing portalled market panel, which does not change card height. EDGE becomes a quiet value. Team names use actual available text width, switching to canonical abbreviations while preserving full accessible names. No prices, lines, source data or model math changed.

The new toolbar adds status, sport/league, source-backed conference and searchable game filters. Filters persist in the URL; upstream changes reset dependent selections. Date navigation clears selected game, uses Gregorian date-only arithmetic and Eastern Today, and removes previous-date query placeholders. Narrow/short screens let the toolbar scroll away so it does not cover the feed.

Lead: Impeccable. Advisors: UI UX Pro Max, Apple Design, Emil Design Engineering and ECC. Ponytail constrained implementation to existing platform/dependencies. Three Unlazy agents owned navigation/architecture, toolbar and cards; parent independently reverified all six leaf gates and released exact leases. Brief and owner amendment define scope.

## Verification

- Navigation/conference: 11 tests passed; card-owned suites: 140 passed; toolbar: five real-browser tests passed; page/shell: 78 passed.
- New integration matrix: nine tests passed, including filters/back navigation, date replacement, calendar focus and full-projections geometry at 320–1920px, light/dark and reduced motion. Screenshots remain untracked by repository policy in `screenshots/`.
- TypeScript, production client/server build, production-preview exclusion and bundle budget passed (216,812 gzip bytes / 222,538 ceiling).
- Initial broad Vitest run: 5,341 passed, 66 failed, 40 pending, one todo. Of the failures, 64 require unavailable database/provider credentials. Two local UI-test failures (open-calendar loading state and superseded shell source assertion) were corrected and passed focused reruns. CI must supply the independent final suite result.
- Impeccable final detector results were empty for each owned UI scope. Motion verdict: Approve.
- Initial browser pass caught the oversized calendar and cmdk search label; both repaired and confirmed. The original integration overflow assertion counted intentionally hidden measurement text; it now measures visible labels and page boundaries.
- Existing responsive suite initially could not create pages because local Playwright ffmpeg is absent. Local rerun disables optional video only; CI configuration retains its installed recorder.
- Local production smoke: 10/11 passed. Build identity is absent in a local process without Railway commit metadata; live commit proof remains a deployment gate.

## Known limits and release

Conference metadata is the exact 2026 FBS seed snapshot, covering 138 programs. Unknown FCS affiliations are not guessed; MLB/WC have no conference options from this source. Backend lifecycle exclusions remain in force. The site broker preflight is unavailable because independent root-owned provenance is missing; GitHub read-only CLI preflight verified the repository and baseline instead. No credential retrieval or Railway mutation was performed.

The update is not live until the new PR receives latest-head independent approval, passes checks, merges and deploys. Baseline/rollback target: `b2170b6382ac157e91cbc822a33ef00eb3066d1e`.
