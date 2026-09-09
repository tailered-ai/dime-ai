# P05.CP01 — ASSURANCE Self-Test Framework checkpoint

Recorded 2026-08-10. Sole ledger writer used throughout; no manual edits.

## Identity and provenance

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Execution-start HEAD | `8946b13bcebd155d7b6da73511e2778dae4b5e4d` (tree `f5cbb144…`, parent `1fa8e215…`) |
| `origin/main` (freshly fetched) | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` |
| Fresh P05 candidate | `head 8946b13b…` · `base 4d644cf4…` · `merge_tree f5cbb144…` · `merge_commit 40855c3d…` |
| Identity digest | `411fdf5a58d85a63856170ea18e786da831e78c3a24a8cec8d7765242604ef8f` |
| Contract sha256 | `58087d2a8262064658cac283703777dce60e414f323fbb5f8b54fb6885e172d5` (disk == pin) |
| Registry | 47 PARITY entries; identity carried in `assurance.json` |
| Executor identity | `1e2d51e01d931464d21fa183e06c566eea3d5beb7ceae4d7e069e2465c3380f2` |
| Blueprint sha256 | entry `fb18bfad…`; after AMD-006 `a1b9cbdaf682a5277519ad3489da4a4fd0a5f34b409eee2db4b0b58b471bd77e` |
| Fixture schema | 1.0.0 · Assurance artifact schema | 1.0.0 |
| Toolchain | Node v22.22.0 · pnpm 10.33.0 · git 2.55.0 · zizmor 1.29.0 · **container runtime ABSENT** (docker/podman re-checked, still unavailable) |
| Prior phases | PB/P00/P01/P02/P03/P04 all re-verified ACCEPTED from committed state (exit 0 each) |

Hermeticity remains truthfully `HERMETIC:UNENFORCED`. No seed gate depends on
container isolation; no container-required gate is marked PROVEN.

## Framework (P05.T01–T07) — all closed

Five modules under `scripts/ci/selftest/`: `fixture.mjs`, `placement.mjs`,
`assurance.mjs`, `coverage.mjs`, `p05-audit.mjs`, plus `fixtures-driver.mjs`
and a 43-test suite. Full substance table: `T01-T07-implementation.md`.

## Real-gate proofs — 3 PROVEN across 3 different mechanisms

| Fixture | Contract ID | Poison result | Reason matched | Control | Changed paths | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| `typecheck-ts2322` | `ci.yml#typecheck` | FAIL exit 2 | stdout `p05-poison-typecheck.ts(N,N): error TS2322` | PASS exit 0 | exactly `server/p05-poison-typecheck.ts` | disposed, byte-identical restore |
| `format-check-violation` | `01-pr-proof-contract.yml#format-check` | FAIL exit 1 | stderr `[warn] server/p05-poison-format.ts` + `Code style issues found` | PASS exit 0 | exactly `server/p05-poison-format.ts` | disposed, byte-identical restore |
| `drizzle-meta-stray` | `08-contract-and-data-integrity.yml#contracts` | FAIL exit 1 | stdout `contains only drizzle-owned artifacts` | PASS exit 0 | exactly `drizzle/meta/p05-poison-stray.json` | disposed, byte-identical restore |

Compiler, formatter, data-integrity suite — three genuinely different
verification mechanisms, not one detector family three times.

## Fourth fixture — the finding

`workflow-template-injection` → `05-workflow-security.yml#zizmor`:
**FINDING_CONFIRMED**. Poison leg PASS (exit 0) with the detector's own
`zizmor/template-injection` present in `zizmor.sarif`. The gate cannot reject.
See `DEF-023-finding.md`. Recorded as a finding, never as proof.

## Negatives — each by its declared reason

- **NEG01 WRONG_TARGET** — drizzle poison declared against the zizmor gate:
  poison leg PASS, `BROKEN_GATE(WRONG_TARGET)`; "something went red" refused.
- **NEG02 NON_RESTORING** — an undeclared execution artifact (`zizmor.sarif`)
  left behind: `BROKEN_GATE(NON_RESTORING)`; successful poison detection does
  not rescue it.
- **NEG03 UNPROVEN** — graduated + no proof ⇒ `BROKEN_GATE(UNPROVEN)` ⇒
  `VERIFIER_BROKEN`; clears when a valid proof is supplied and returns when it
  is removed. Also proven: a not-yet-graduated gate stays truthfully unproven
  without blocking; a CI-ONLY gate is never required to carry a local proof;
  an unavailable tool yields `NOT_LOCALLY_EXECUTABLE`, never a fake proof; and
  a `finding` record can NEVER satisfy the law.
- **NEG04 LIVE_POISON_FIXTURE** — fixtures planted under `.github/workflows`
  and `drizzle`, and a live-format file inside an approved root, all refused
  **before any gate ran**; the runner refuses without creating a candidate;
  control (same poison as inert `poison.patch`) accepted.
- **NEG05 WRONG_REASON** — right gate red, declared signature absent ⇒
  `BROKEN_GATE(WRONG_REASON)`, with expected and actual both preserved.
- **NEG06** — 15 false-assurance cases: no-op/absolute/traversal/`.git` patch
  paths, tampered fixture hash, changed-path mismatch, unsupported schema,
  ambiguous target, id mismatch, overly broad reason, undefined control,
  unknown applicability, unknown/CI-ONLY/duplicated registry target,
  non-runnable step, TIMEOUT as a non-detector result, tampered/truncated
  artifact, and every `BROKEN_GATE(*)` reducing to `VERIFIER_BROKEN`.
- **NEG07** — SIGINT mid-cycle: non-zero exit, no `assurance.json`, no poison
  in `server/`, `.github/workflows/`, or `drizzle/meta/`, and (after DEF-026)
  zero orphaned candidates with live runs untouched.

## Audits

- **AUD01** poison containment: 0 violations over 4,289 files; 8
  INERT_FIXTURE, 1 TEST_CANARY, 4 DOCUMENTED_FINDING, 30
  LEGITIMATE_EXISTING_SOURCE. Proven still able to fail on a planted live
  poison file.
- **AUD02** architectural isolation: 0 findings; all five required
  integrations present (P01 snapshot, P02/P03 contract+registry, P03 result,
  P04 executor, P04 teardown).

## Coverage (all 47 PARITY entries) — `EV02-coverage-map.tsv`

| State | Count |
| --- | --- |
| PROVEN | 3 |
| UNPROVEN | 1 (`05-workflow-security#zizmor`, `cannot_reject`) |
| NOT_YET_MANDATORY | 19 |
| CI_ONLY | 20 |
| NOT_LOCALLY_EXECUTABLE | 4 (docker/trivy/playwright unavailable) |
| INVALID_FIXTURE | 0 |

Blocking gates: **0** — `graduated.json` ships empty by design, so no gate is
falsely required to be proven today and none can be graduated later without
one.

## Regression — every command with its direct exit code

`P05-validation-sweep.txt`. Headlines: `scripts/` 630/630 (36 files: PB 35,
P01 20, P02 31, P03 56, P04 52, P05 43 + tooling) · tsc 0 · prettier 0 ·
ledger verify 0 · contract conformance verify/doc/audit 0 · registry 0 ·
P01 provenance 0 · P03 audits 0 · P04 audits 0 · P05 audits 0 ·
actions-security 0 · federation docs 0 · frozen install (established mode) 0.

## Ledger

Units: **24 of 25 closed** (CP01 closes with this record). Amendments:
AMD-001..AMD-006. Defects: **26 total, 25 closed, 1 OPEN — DEF-023 (HIGH)**.
Missing evidence 0 · contract drift none · flaky 0 · inconclusive 0 ·
infrastructure failures none unresolved.

## Residue and unrelated work

0 marked processes · 0 lane locks · 0 orphaned candidates · 0 poison anywhere
in the developer tree. `.ci-verify/runs/` holds 2 PRE-EXISTING registered
worktrees from earlier sessions, offered to the recovery sweep and **refused**
("registered git worktree — live") — the ownership law protecting work P05
does not own. Unrelated working tree: 25 entries, fingerprints byte-IDENTICAL
start → end.

## Controlled files changed

New: `scripts/ci/selftest/` (fixture, placement, assurance, coverage,
p05-audit, fixtures-driver, p05.test.ts, graduated.json, 4 fixture
directories), `docs/verification/evidence/p05/`.
Modified: `scripts/ci/blueprint.mjs` (AMD-006 additions only),
`scripts/ci/provenance-audit.mjs`, `scripts/ci/contract-conformance.mjs`,
`scripts/ci/p03-audit.mjs` (documented allowlist entries only — DEF-025), the
ledger triplet.

## ACCEPT(P05) — evaluated term by term

| Term | Value |
| --- | --- |
| `all_mandatory_closed` | true (with CP01 closed by this record) |
| `all_gates_pass` | **true** — GATE01 and GATE02 both PASS |
| `all_checkpoints_recorded` | true |
| `all_authorizations_granted` | true |
| `zero_blocking_open_defects` | **false — DEF-023 (HIGH) is OPEN** |
| `evidence_complete` | true |
| `zero_flaky_mandatory` | true |

Additional P05 requirements: ≥3 real gates PROVEN ✓ · GATE02 coverage law
armed ✓ · zero false-PROVEN paths ✓ · zero live poison violations ✓ · zero
poison residue ✓ · zero fixture path escape ✓ · zero wrong-target,
wrong-reason, or non-restoring acceptance ✓ · zero proof from an interrupted
run ✓ · zero duplicate control-plane implementations ✓ · assurance artifact
SHA valid ✓ · no proof from BLOCKED/TIMEOUT/INFRA_FAIL/INCONCLUSIVE/CI_ONLY ✓.

The framework itself meets every requirement. The single failing term is an
**open HIGH defect in production CI that P05 discovered and cannot fix within
its authorized scope.**

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-023**

DEF-023 is not a defect in P05's work — it is a pre-existing, live defect in a
required production check, found by the machinery P05 was built to provide.
Its remediation (`P06.T05` also carries it) edits a production CI workflow,
which P05 is forbidden to touch: §28 prohibits amending a gate to make a
fixture pass, and the change ships on merge, making it owner-scoped.

Two ways to unblock, in the order I would take them:

1. **Authorize the workflow fix** (recommended). Keep the SARIF upload and add
   a fail-closed check — run the scan a second time in `--format plain`, or
   assert the SARIF result count is zero. Then re-run the fixture: it becomes
   a `seed` proof, the gate moves to PROVEN, DEF-023 closes, and P05 accepts
   with **four** proven gates. This fixes a real production hole.
2. **Re-scope DEF-023 to P06 only** if the workflow change should ride with
   P06's implementation of that gate. That clears the P05 attribution while
   keeping the block where the fix will land.

Per §34, no commit was made: the P05 work stands complete and uncommitted in
the working tree, and no unrelated path was touched.
