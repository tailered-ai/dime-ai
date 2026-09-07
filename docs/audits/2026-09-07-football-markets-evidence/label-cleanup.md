# Owner-requested label cleanup and publication handoff

2026-09-07. Owner requested removal of the visible “VSiN DK” notation, then a commit/PR from `tailered-ai` with review by `prez-tailered-ai`.

The history timestamp no longer renders that label. The football freshness line says “Splits”; the Splits header says “Updated” rather than the provider label. Internal source identifiers, source captures, prices, split percentages, timestamps and the legitimate-zero handling are unchanged. Other history source labels are preserved. No provider data was republished.

Verification on this cleanup:

- Existing React server-rendered regression failed before the fix because the label appeared in all three history tables (`label-cleanup-red.log`, exit 1).
- 78 affected Vitest tests passed (`label-cleanup-tests.log`, exit 0).
- Existing 375px/light browser case passed for both pilots, including the absence of the unwanted label after loading all 451 history observations (`label-cleanup-browser.log`, exit 0). The resulting NFL history screenshot was visually inspected.
- Production build and preview exclusion passed (`label-cleanup-build.log`, exit 0).
- Bundle budget passed at 217,106 gzip bytes, 5,432 bytes under the ceiling (`label-cleanup-bundle.log`, exit 0). Staged text secret scan found no leaks (`label-cleanup-secret-scan.log`, exit 0); no scanner allowlist was widened.
- Earlier full-suite results in `receipt.md` remain historical, including failures and their isolated rechecks; no new full-suite or remote CI pass is asserted here.

The approved implementation and helmet assets are included with this cleanup. The earlier candidate/verification manifests remain historical evidence of the prior candidate, not a checksum claim for this commit. Local logs/screenshots and the Unlazy ledger remain outside Git under the repository's existing ignore rules. No dependency or credential configuration changed.

The two original VSiN HTML captures remain local and byte-preserved rather than being committed with Git's line-ending normalization. Their parsed public observations and source fingerprints are included. No raw capture was edited or deleted.

Remote publication is blocked: the fresh `pnpm agent:context` invocation exited 1 with `node execution is blocked: independent root-owned provenance is unavailable`. Restore the independently administered executable trust chain before credential-bearing GitHub execution. No alternate credential path was used, no PR was pushed, and no reviewer request or approval is claimed. `prez-tailered-ai` must independently review/approve after the PR can be submitted. The schema migration remains unapplied; merging main would auto-deploy Railway and must not precede the guarded migration and release gates.
