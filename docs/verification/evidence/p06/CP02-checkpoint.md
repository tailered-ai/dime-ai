# P06.CP02 — execution-boundary remediation checkpoint

**Supersedes CP01 for progression.** CP01 preserved byte-unchanged.

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` · HEAD `705c9898…` (unchanged) |
| `origin/main` | `7fa4b3fe…` — re-fetched, unmoved |
| Contract | `400cc039…` · registry 47 entries · ledger verifies |
| Docker daemon | **still unreachable** (re-measured, not assumed) · trivy absent |

## The correction that mattered most

CP01 recorded DEF-033 as "secret-bound jobs misclassified". **That diagnosis
was wrong**, and the ledger now says so with the original retained in history.

Measured against the contract:

- `01-pr-proof-contract#proof` and `ci.yml#test` contain **zero** `secrets.*`
  references;
- `ci.yml`'s own header states pull-request CI is *"intentionally
  secretless… provider credential probes stay skipped and are enforced by the
  checked-in environment-failure allowlist"*;
- that allowlist has **64 entries — exactly the `environmentBound=64`** the
  gate reported.

So CI passes secretlessly *by design*. The 80 local failures were not secret
starvation and not repository defects: the runner skipped each job's own
provisioning (`pnpm install --frozen-lockfile`, `playwright install`) inside a
disposable candidate, so the detector never validly executed — and its output
was then reported as `FAIL`.

Only `gitleaks.yml#gitleaks` is genuinely `SECRET_BOUND`
(`${{ secrets.GITHUB_TOKEN }}`).

## The boundary model (`scripts/ci/p06/boundary.mjs`)

Three distinctions the verifier previously blurred:

1. **Provisioning vs detector.** Tool install, `sudo`, `curl`, package
   bootstrap, dependency install are not the check. Their failure yields
   `BLOCKED(PROVISIONING_REQUIRES_PRIVILEGE)` or `INFRA_FAIL`, never a
   detector `FAIL`.
2. **Contract cwd.** `defaults.run.working-directory` and step-level
   `working-directory` are now computed per step. `dime-llm-validation`
   carries `ml/dime-1.0` — its earlier "No pyproject.toml" failure was the
   runner's, not the candidate's.
3. **Faithful vs partial.** Provisioning satisfaction must be **proven**, not
   assumed in either direction. Measured here: `node-deps` satisfied (frozen
   install exit 0 ⇒ lockfile-consistent tree reachable by upward resolution
   from the nested candidate), `playwright` satisfied (4 cached chromium
   builds), `uv` present.

An earlier iteration of this model over-blocked — it called `typecheck` and
`contracts` unreproducible when P05 has *proven* them locally. Assuming
unavailability is as wrong as assuming availability; both are now measured.

## Classification (all 16 P06 gates)

| Class | Count |
| --- | --- |
| `LOCAL` | 7 |
| `LOCAL+TOOL` | 5 |
| `NOT_LOCALLY_EXECUTABLE(RUNTIME_UNAVAILABLE)` | 2 |
| `NOT_LOCALLY_EXECUTABLE(ACTION_SEMANTICS_UNREPRODUCED)` | 1 |
| `NOT_LOCALLY_EXECUTABLE(SECRET_BOUND)` | 1 |

**Required: 7 — locally executable 6, nonlocal 1** (`gitleaks`).
Reason codes are kept distinct; `CI_ONLY` is not used as a synonym for
`NOT_LOCALLY_EXECUTABLE`.

## What is done, and what is not

Done: reality re-established; both candidates fresh; the wrong diagnosis
corrected in the ledger; the boundary model built and applied; provisioning
satisfaction measured; contract cwd recovered; DEF-031/032/033 fix paths
proven at classification level.

**Not done — and none of it may be assumed:**

- the model is **not yet wired into the executing runner**, so the 12
  executable gates have not been re-run under correct cwd/provisioning
  semantics;
- governed tool-identity bootstrap (versions/pins/checksums) is not built;
- a gitleaks adapter does not exist (the gate stays truthfully nonlocal);
- **ASSURANCE proofs are missing** for the newly-classified required local
  gates that lack them — `#proof`, `security-audit`, `semgrep-blocking`,
  `ai-eval-critical`;
- the 18-case P06 negative suite is not written;
- the CI-only/nonlocal audit artifact is not produced;
- full cross-phase regression under the corrected runner has not run.

DEF-031, DEF-032, DEF-033 therefore remain **OPEN**: their corrections are
diagnosed and modelled, not yet executed and proven. Closing them now would
be exactly the "greener, so close it" failure the defect discipline forbids.

## ACCEPT(P06)

`all_mandatory_closed` false · `all_gates_pass` false ·
`zero_blocking_open_defects` false · `evidence_complete` false.

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-031, DEF-032, DEF-033**
