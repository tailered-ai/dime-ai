# PB.T05 — evidence record (immutable observation)

| Field | Value |
| --- | --- |
| Rendered view | `docs/verification/CI-VERIFY-EXECUTION-LEDGER.md` |
| SHA-256 at seed time | `085f669949d193bd79c898ddde5bccb14e6ea712c49619e28a06326d2b3d1474` |
| Generated exclusively from | `docs/verification/ci-verify-ledger.json` |

`renderMarkdown()` is a pure function of ledger state — it reads no clock and
no environment — which is what allows byte-for-byte conformance to be asserted.
Proven by `scripts/ci/ledger.test.ts`:
- "regenerates the on-disk markdown byte-for-byte from the on-disk JSON"
- "renders as a pure function of state — no clock, no environment"

RENDER_DRIFT is reported by `ledger.mjs verify` whenever the on-disk markdown
diverges from a fresh render.
