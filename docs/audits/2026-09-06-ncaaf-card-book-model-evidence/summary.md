# NCAAF card Book/Model readout

**Continuation:** the subsequent requested backend/provider audit and wiring are recorded in [provider-wiring.md](provider-wiring.md) and [backend-audit.json](backend-audit.json). The rendering-only scope and counts below describe the preceding PR542 revision, not the expanded candidate. Release remains held.

Base: `b061d836417859ab0de65849a604682425a2138d` (includes merged PR541). Scope: rendering only. No database changes, provider refresh, model execution, new dependencies or deployment.

Lead: Impeccable; advisors: Ponytail reuse-first and Unlazy evidence gates. [Brief](brief.yaml).

## Root cause and repair

The shared card entered its existing unranked comparison carousel only when a published model had an explicitly incomparable pricing basis. This missed owner-supplied point projections without fair prices and games with book prices but no model. Live DOM for Washington incorrectly claimed every market was efficiently priced; the other two September 6 games had no Book/Model readout.

Reuse the existing comparison carousel whenever structured line-market data exists but no scored insight exists. Carry model publication state through the carousel. Keep unpublished model values hidden and label them “Model unavailable.” Supplied point projections remain “Model line / Projection only”; missing fair prices are never computed from point projections. MLB ranked edges, no-vig ROI, full projection tables and pricing-basis protections are unchanged.

## Verification

- Regression-first: both new tests failed before implementation (no comparison slides). Existing 12 NCAAF pricing-basis tests passed then. After repair, 107 card/pricing tests passed; 35 adjacent adapter/table tests passed. No skipped tests in those six files.
- Node 22.22.0 typecheck and production build exited 0. Preview-activation scanner passed. The existing Unlazy ledger retains exact operation, environment, exit status and successful-output fingerprints; raw full build output was not persisted locally.
- Built-app browser proof: 8/8 passed at 375/768/1024/1440, both themes, reduced motion. Three NCAAF cards, 16 comparison slides, keyboard focus/wrap, 44px controls, no page overflow; existing MLB priced summary still present. API/auth fixtures are explicitly local, not live provider or authentication certification.
- First browser attempt failed before execution because bundled Chromium was missing; failure traces retained in `.unlazy/ncaaf-card-book-model/attempt1-missing-browser`. Rerun used installed Google Chrome, without installing dependencies or changing browser framework.
- Bundled offline detector returned `[]` for changed runtime components. No CSS/motion changes. [Checklist](checklist.md).
- Chat critical-path bundle: 216,831 gzip bytes / 222,538 ceiling; 5,707 bytes under. No vendor-motion chunks in that path.
- Rendered proof boots `dist/index.js` with background jobs disabled and no database. Separate broad `smoke-deploy.mjs` was not run; production auth/provider/DB health is not claimed.

## Unavailable data is not a UI defect

At the recorded September 6 publication, Washington had model spreads ±21.1 and model total 52.1, plus book total 51.5; Action Network did not supply its spread/ML. No model fair prices were supplied. Wisconsin/Notre Dame and Louisville/Mississippi had DK book quotes but no published model. These gaps remain explicit, not fabricated. Tests use recorded data shapes, not fresh prices.

## Release gate

Unlazy: three met, one unmet, zero abandoned. Owner authorization for the exact PR/commit and deployed rendered readback remain required. Merge to main auto-deploys Railway; no merge or deployment performed here. Known-good code rollback target before this change: `b061d836417859ab0de65849a604682425a2138d`; any rollback needs authorization and changes code only.
