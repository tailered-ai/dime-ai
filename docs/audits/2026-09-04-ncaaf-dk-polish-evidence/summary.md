# September 4 NCAAF DK splits and feed polish

The five owner-selected games use VSiN's DraftKings section on Betting Splits, with actual source history and a separately labelled Action Network DraftKings NJ odds observation. The model feed keeps the selected Circa Book comparison and the already-published Michigan State favorite correction (MSU −7.36/−241; Toledo +7.36/+241).

## Sources and publication

`shared/ncaafSeptember4Dk.json` contains exactly five identities and 134 observed VSiN history rows: 27 for SJSU, Toledo, Fresno and Miami; 26 for UTEP. Current data was retrieved September 4 at 8:03 PM ET. History dates/times come from the source rows, converted with America/New_York. `provenance.json` records URLs and SHA-256 hashes; the normalized dataset matches its recorded hash. Original responses and normalization inputs are retained in the local task evidence at `/private/tmp/ncaaf-five-publish/evidence/sources/dk-update/`.

VSiN exposes Opening Split, First Full Split when present, and Last 25 Changes. These are all available observations from those sections, not a complete lifetime timeline. No interpolated history. Spread/total juice is absent from this source and remains null. UTEP moneyline remains unavailable.

The existing publisher's `--source=vsin-dk` mode requires all five existing games and updates only their six split percentages. It validates every identity/observation before writing, checks all non-split fields unchanged, bulk-inserts missing history in one transaction, verifies every row and preserves earlier history. Replays reuse the same observation keys. No schema change or new dependency.

DK current-line overrides are attached only to exact date/event/team rows with matching published DK percentages, and consumed only by Betting Splits. The model feed retains its Circa fields. History DTOs identify VSiN DK and AN DK separately. The old AN Open snapshot yields to the actual DK opening; its stored record is preserved. Old Circa percentages attached to the AN snapshot are omitted from display, not rewritten.

## Interface

Impeccable leads; UI UX Pro Max advises. See `brief.yaml`.

Card metadata is simply NCAAF. Pricing methodology remains documented; detailed market notes call calculated prices estimated. The full-projections label is centered independently of the trailing icon. Desktop sidebar width is bounded at 17–19rem, with navigation type adapting from 0.875–1rem; rail, tablet drawer, themes, focus and reduced-motion behavior use the existing controls.

## Verification

- Exact publisher checks: DK 134 observations and original five-game payload PASS.
- Independent pricing replay PASS. Independent transactional review found no defects. A separate source/render review found that real 0%/100% opening splits were displayed as pending. Verified VSiN DK zeros now render as percentages, with an opening-row browser assertion; unavailable markets retain their guard.
- Focused Vitest: 194 passed, 0 failed, 0 skipped. TypeScript exit 0.
- Rendered matrix: 375/768/1024/1440, dark/light, plus reduced motion; market tabs, keyboard focus return, rail/drawer and account-menu bounds covered. Final output in `browser.txt`.
- Client/server production builds, preview activation guard and bundle budget pass; final output in `build.txt`.
- Detector returned four warnings, all on unchanged declarations: two existing market signal stripes and two existing height/width transitions. They were reviewed against the owner-approved existing UI and retained. No new motion declaration or new detector finding; motion redesign not part of this refinement.
- The first matrix exposed test assumptions (phone market tabs, rem-based sizing) and a narrow-label/source-stamp layout concern. One batched correction and final confirmation were performed. No production failure was inferred from a test-fixture mismatch.
- Required GitHub checks and exact-head production dry-run are recorded in the PR before merge. Post-merge serving revision, fresh database readback and live rendered validation close publication.

## Access and release

The local access capsule failed because independently root-owned broker provenance is unavailable. No broker, credential, login-state or production-origin bypass was attempted. Read-only GitHub identity/repository and public health preflight identify tailered-ai/dime-ai and serving baseline `2ec6c8ae6c56062dc08972d2bd7650e661ee550f`. Database work uses the existing Production GitHub Actions secret path.

Rollback: revert the code commit to the baseline. A failed data transaction rolls back automatically. Any later data containment must target only the five event IDs and exact source observation keys; do not bulk-delete other history.
