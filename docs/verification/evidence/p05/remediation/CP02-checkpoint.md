# P05.CP02 — re-checkpoint after DEF-023 remediation

**Supersedes `P05.CP01` for progression purposes.** CP01 is preserved
byte-for-byte at `docs/verification/evidence/p05/CP01-checkpoint.md`, with its
recorded decision (`DO NOT PROCEED · Blocking IDs: DEF-023`) unchanged.

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Execution-start HEAD | `8946b13bcebd155d7b6da73511e2778dae4b5e4d` (unchanged; nothing committed) |
| `origin/main` (freshly fetched) | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| zizmor | 1.29.0 (unchanged, pinned in the workflow env) |
| Workflow hash BEFORE | `c40e7194b599f0491cff79f052750d1fb395ba136e56275b0488bd0bc81567bb` |
| Workflow hash AFTER | `7bf7f454f7fa9bb1c91b7d05e27d123cfec1027d232efbd685e517fc383b3091` |
| Contract SHA BEFORE | `58087d2a8262064658cac283703777dce60e414f323fbb5f8b54fb6885e172d5` |
| Contract SHA AFTER | `9e1296b6ee44ddf90c9382c2b0cc5bfd3b8a8a78ade1629914397c81b57d3dba` |
| Blueprint sha256 | `8200d81f2645…` (AMD-007) |

## Selected remediation mechanism

**Option A — second plain-format enforcement run.** Rationale and the
rejected alternative: `DEC-mechanism-selection.md`. In short: plain mode's
exit status IS zizmor's severity semantics, so nothing can drift; Option B
would have reimplemented blocking policy in YAML as a second source of truth.

## The workflow change

SARIF generation is retained for the security tab but explicitly demoted to
reporting; upload runs next; a new final step runs the same scan, same scope,
same threshold in plain format as **the verdict**. Its status is captured
directly — no pipe, no `continue-on-error`, no `|| true`. The comment that
falsely claimed fail-closed behaviour is corrected. Job name
(`05-workflow-security`), permissions, and every SHA pin are unchanged.

## Measured behaviour (exit codes captured directly, never through a pipe)

| Command, identical input and flags | Exit |
| --- | --- |
| `zizmor --min-severity high --format plain .github/workflows/` | **14** |
| `zizmor --min-severity high --format sarif .github/workflows/` | **0** (with `zizmor/bot-conditions`, `level: error`, present in `results`) |

That is DEF-023 demonstrated on the **real repository**, not a fixture: the
required check has been green in production while carrying a live High
finding.

## Contract reconciliation (the derive → freeze → conform chain)

1. Conformance run BEFORE regeneration **failed as designed** —
   `CONTRACT_DRIFT: 05-workflow-security.yml changed without contract
   regeneration (contract c40e7194b599, actual 7bf7f454f7fa)`. Preserved as
   negative evidence in `DRIFT-before-regeneration.txt`.
2. Regenerated via the P02 extractor (`contract-extract.mjs emit`). No hand
   editing. Byte-stable: emitting twice produced the identical SHA.
3. `CONTRACT.md` re-rendered through `contract-conformance.mjs render`; `doc`
   conformance PASS.
4. Invariants after regeneration: check identity `…#zizmor` unchanged ·
   `status_context: 05-workflow-security` unchanged · runnability `LOCAL+TOOL`
   unchanged · `required_tools: ["zizmor"]` still represented · 40 workflows /
   51 checks / 9 required contexts unchanged · PARITY registry reloads to
   **47 entries, 9 required, 5 graduating, runnability 17/10/20 — all
   unchanged**; only `step_count` moved 4 → 5, which is the new step.

## The corrected gate, run through the P05 framework

| Leg | Result |
| --- | --- |
| Poison (template injection) | **FAIL exit 14**; both declared signatures matched: `error[template-injection]` and `p05-poison-template-injection.yml` |
| Restoration | byte-identical; declared artifact `zizmor.sarif` removed |
| Control (clean tree) | **FAIL exit 14** |
| Verdict | `BROKEN_GATE(CONTROL_RED)` |

**The gate now genuinely rejects.** It cannot be PROVEN because its control
leg fails — on a clean tree, for a reason unrelated to the poison.

## The blocker: DEF-027

`zizmor/bot-conditions` at `.github/workflows/auto-merge-dependabot.yml:27` —
a spoofable `github.actor` check — is the repository's single pre-existing
HIGH finding. Once `05-workflow-security` is honest, it fails on it.

Consequences, stated plainly:

- the ASSURANCE fixture cannot become a fourth PROVEN gate (`CONTROL_RED`);
- DEF-023's closure criterion ("rejects the known poison **and** passes its
  restored control") is unsatisfiable;
- **landing this fix as-is would turn a required check red on every pull
  request and block all merges** — worse than the false-green it replaces.

Fixing it means editing an unrelated workflow job, which this authorization
explicitly forbids. Suppressing it was rejected as a cover-up. Full analysis
and the recommended one-line fix: `DEF-027.md`.

## Regression — direct exit codes

`scripts/` **630/630 exit 0** (36 files) · `tsc --noEmit` 0 · prettier 0 ·
ledger verify 0 · contract conformance verify/doc/audit 0 · registry fidelity
0 · P01 provenance 0 · P03 audits 0 · P04 audits 0 · P05 audits 0 ·
**check-github-actions-security 0** (40 workflows, 120 action refs, 25
production secret refs, 0 failures — every `uses:` still SHA-pinned, no new
secret-reference violation, permissions unchanged) · federation docs 0 ·
frozen install (established `--ignore-scripts` mode) 0.

## Coverage

Unchanged from CP01: **3 gates PROVEN** (typecheck, format-check,
data-integrity). The zizmor gate remains **UNPROVEN** — now for a different
and better-understood reason: not "cannot reject" (fixed) but "cannot pass its
control" (DEF-027). No proof count was inflated.

## Ledger

Units 25 of 26 closed (CP02 closes with this record). Amendments
AMD-001..AMD-007. Defects: **27 total, 25 closed, 2 OPEN — DEF-023 (HIGH),
DEF-027 (HIGH)**. Zero flaky · zero missing evidence · zero contract drift
remaining · zero infrastructure failures · zero inconclusive.

## Residue and unrelated work

Zero poison in the developer tree · zero marked processes · zero lane locks ·
zero orphaned candidates (startup sweep) · `.ci-verify/runs` holds only the
two pre-existing registered worktrees, which the sweep refused. Unrelated
working tree: 25 entries, fingerprints byte-identical.

## Files modified in this remediation

`.github/workflows/05-workflow-security.yml` (the authorized fix) ·
`scripts/ci/contract.frozen.json` + `contract.sha256` (legally regenerated) ·
`docs/verification/CONTRACT.md` (re-rendered) · `scripts/ci/blueprint.mjs`
(AMD-007, additive) · `scripts/ci/selftest/fixtures/workflow-template-injection/expect.json`
(finding → seed) · `scripts/ci/selftest/assurance.mjs` (evidence enrichment) ·
the ledger triplet · `docs/verification/evidence/p05/remediation/`.

## ACCEPT(P05) — term by term

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true (with CP02 closed by this record) |
| `all_gates_pass` | true |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | true |
| `zero_blocking_open_defects` | **false — DEF-023 and DEF-027 both OPEN (HIGH)** |
| `evidence_complete` | true |
| `zero_flaky_mandatory` | true |

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-023, DEF-027**

The DEF-023 enforcement fix is implemented, measured, and proven to reject —
but its closure and P05's acceptance are gated on DEF-027, a pre-existing HIGH
finding in a workflow this authorization fences off. Per §14, nothing was
committed.

One decision unblocks everything: authorize the one-line `auto-merge-dependabot.yml`
fix (drop the redundant, spoofable `github.actor` clause; the non-spoofable
`pull_request.user.login` check it is ANDed with already does the work). Then
the control leg passes, the fixture becomes the fourth PROVEN gate, DEF-023
and DEF-027 both close, and P05 accepts.
