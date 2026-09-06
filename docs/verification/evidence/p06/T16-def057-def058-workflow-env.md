# T16 — DEF-057 retest (closed) and DEF-058 discovery (workflow-level env fidelity)

Base: `43a33c84` · candidate merge `e7701efd` · serial roster run
`2026-08-11T09-05-20-043Z-50974-0` (no concurrent suites).

## DEF-057 — submodule materialization gap: FIXED, retested, closed

`provisionCandidate` now runs `git submodule update --init --recursive` inside
any candidate whose tree carries `.gitmodules`. Retest evidence, from the gate's
own step journal (`step-1.stdout` of `tailered-os.yml#test`):

```
::error::cloudflare-os submodule is at b2a51b5426398c8353d9d4dd984bd525121ab5f2, expected  — see platform/tailered-os/docs/UPSTREAM.md update contract
```

The detector **read the correct pin `b2a51b54…` from an initialized submodule
inside the candidate worktree** — the exact operation that failed with an empty
gitlink before the fix. The materialization gap is gone. An exact-geometry
manual reproduction (worktree nested under `.ci-verify/runs/`, provisioned via
`provisionCandidate`) confirmed `submodules: {present: true, initialized: true}`
and `git -C cloudflare-os rev-parse HEAD` → `b2a51b54…`, exit 0.

## DEF-058 — the gate still FAILs, for a different, verifier-owned reason

The step compares `$actual` against `$EXPECTED_CLOUDFLARE_OS_PIN`, defined in a
**workflow-level `env:` block** (`.github/workflows/tailered-os.yml` line 28).
The error message prints `expected ` — empty — because the variable never
reached the step.

Chain of custody:

1. **Extractor** (`scripts/ci/contract-extract.mjs`): records
   `env: job?.env ?? null` per check — job-level only. Workflow-level `env:` is
   declared SUPPORTED in the construct census but never folded into any check.
   The frozen contract's `tailered-os.yml#test` entry has `env: null`.
2. **Runner** (`run-gates.mjs` gate-spec builder): already merges
   `check.env` under `step.env` into every step record — correct, but starved
   by (1).
3. **Driver** (`step-driver.mjs`): applies `step.env` — correct.

So the single defect is extraction fidelity: GHA's env cascade is
workflow ∪ job ∪ step (later wins); the contract captures job ∪ step only.

## Blast radius — bounded, and the PASSing gates stand

Exactly three workflows carry workflow-level `env:`:

| Workflow | Variable | Consumed by | Verdict impact |
| --- | --- | --- | --- |
| `03-semgrep.yml` | `SEMGREP_VERSION` | `pipx install` steps only — PROVISIONING, satisfied by governed semgrep 1.172.0 (whose identity is *derived from this very value*) | none — detector steps never reference it |
| `05-workflow-security.yml` | `ZIZMOR_VERSION` | `pipx install` only — PROVISIONING, governed zizmor 1.29.0 | none |
| `tailered-os.yml` | `EXPECTED_CLOUDFLARE_OS_PIN` | a **DETECTOR** step | false FAIL — the only affected gate |

No other check in the 53-check contract references these variables.

## Classification

DEF-058 is a **verifier fidelity defect** (the DEF-039 shell-fidelity family):
the false verdict class the execution-boundary model exists to prevent — a
verifier limitation reported as a candidate FAIL. The candidate's submodule pin
is in fact **correct** (`b2a51b54…` == the workflow's expected pin).

Remediation: fold workflow-level env under job-level env at extraction
(`{...workflow.env, ...job.env}`), prove CONTRACT_DRIFT detection fires before
regenerating, re-derive + commit provenance, rebind all P06/P07 evidence at the
new contract hash via a full serial rerun.
