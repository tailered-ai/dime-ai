# P05.T01–T07 implementation record

Five new modules under `scripts/ci/selftest/`, four fixtures, one driver, one
43-test suite. Every result flows through P03's taxonomy; every candidate
through P01; every command through P04. P05 adds no snapshot resolver, YAML
parser, contract loader, registry, executor, process runner, cleanup engine,
ledger writer, or acceptance predicate (proven by `P05.AUD02`).

| Unit | Module | Substance |
| --- | --- | --- |
| T01 | `fixture.mjs` | Fixture contract: `poison.patch` + `expect.json`, schema 1.0.0. Identity is content-derived (`fixture_sha256` pins the patch bytes) — no absolute paths, run ids, timestamps, usernames, or hostnames. `parsePatchPaths` refuses absolute, `..`-traversing, unprefixed, and `.git/` administrative paths before anything is applied. Reason patterns are validated for specificity: a regex under 6 chars, or one matching `""`/`"ok"`/`"exit 1"`, is `REASON_TOO_BROAD`. `validateAgainstRegistry` requires the target to resolve to EXACTLY ONE locally-runnable contract entry and the declared step indexes to be real `run:` steps |
| T02 | `placement.mjs` | The placement law, executable. `SENSITIVE_ROOTS` (workflows, actions, CODEOWNERS, drizzle) may never host fixture material; `APPROVED_FIXTURE_ROOTS` may host only `poison.patch` / `expect.json` / `README.md`. Storage mode is validated, not extensions: any live-format file inside a fixture directory is `LIVE_POISON_FIXTURE`. Enforced BEFORE any candidate exists, so a misplaced fixture is a verifier-safety failure rather than a target-gate "success" |
| T03 | `assurance.mjs` | The 20-step cycle: placement check → contract binding → fresh P01 candidate → pristine-state proof → pre-poison hashes → apply poison → prove the changed-path set EXACTLY matches the declaration and that bytes actually changed → run ONLY the intended gate through P04 → assert exact gate, detector-class status, and reason → reverse-apply → prove byte-for-byte restoration (declared execution artifacts removed via P04's `safeRemoveOwned`, anything undeclared is `NON_RESTORING`) → re-run the SAME gate → assert the declared healthy state → dispose. Never touches the developer tree; `finally` disposes always |
| T04 | `assurance.mjs` | Exact-gate enforcement on the structured `result.gate_id` — no prefix, substring, or label matching. A poison that reddens a different gate is `WRONG_TARGET` even though the run is red |
| T05 | `assurance.mjs` | Exact-reason enforcement over structured evidence: `stdout`, `stderr`, `result_reason`, or a declared worktree `artifact`. EVERY declared signature must match. Never "exit code != 0" |
| T06 | `coverage.mjs` | `gate_id → fixture(s) → proof state` over the frozen registry, with the six frozen states. The mandatory-gate law is ARMED: graduated + locally executable + no valid proof ⇒ `BROKEN_GATE(UNPROVEN)` ⇒ `VERIFIER_BROKEN` via P03's reduction. `graduated.json` ships EMPTY, so nothing is falsely required today and P06/P07 cannot graduate a gate without a proof. Only a `seed` fixture can prove; a `finding` record forces `UNPROVEN` and sets `cannot_reject` |
| T07 | `assurance.mjs` | `assurance.json` + `.sha256`. The `logical` section is deterministic over stable inputs (sorted records, no wall clock) and carries its own `logical_sha256`; `observational` holds timestamps and run dirs. Hand-editing either invalidates a hash — proven by `P05.NEG06` |

**Recovery (DEF-026):** `sweepStaleRunDirs` runs at the start of every
assurance run. Ownership is proven twice — realpath containment inside the
owned runs root, and *not* a registered git worktree — so an interrupted
run's orphan is recovered while a live run from any session is untouched.

## Seed gates — why these three

Selected by resolving actual contract identities and commands first, not from
the suggestion list. All three are locally executable today, need no Docker,
no CI-only context, and no unenforceable network hermeticity.

| Fixture | Contract ID | Runnability | Mechanism | Poison | Expected reason | Control |
| --- | --- | --- | --- | --- | --- | --- |
| `typecheck-ts2322` | `.github/workflows/ci.yml#typecheck` | LOCAL (required) | TypeScript compiler | `server/p05-poison-typecheck.ts` assigns a string to `number` | stdout `p05-poison-typecheck\.ts\(\d+,\d+\): error TS2322` — names the file AND the diagnostic code | PASS (exit 0) |
| `format-check-violation` | `.github/workflows/01-pr-proof-contract.yml#format-check` | LOCAL | Formatter | `server/p05-poison-format.ts` with deliberate spacing violations | stderr `\[warn\] server/p05-poison-format\.ts` AND `Code style issues found` | PASS (exit 0) |
| `drizzle-meta-stray` | `.github/workflows/08-contract-and-data-integrity.yml#contracts` | LOCAL (required) | Data-artifact hygiene (vitest) | a non-drizzle JSON in `drizzle/meta/` | stdout `contains only drizzle-owned artifacts` — the intended test's own name | PASS (exit 0) |

Three genuinely different verification mechanisms: a compiler, a formatter,
and a data-integrity assertion suite. Fixture scope is safe because every
poison exists only as inert patch bytes under the approved root and is applied
solely inside a disposable candidate (`P05.AUD01` proves containment).

**Local executability rests on one load-bearing fact**, recorded because it is
easy to miss: candidates live at `.ci-verify/runs/<id>/worktree`, *inside* the
repository, so Node's upward module resolution reaches the repo's
`node_modules`. A candidate created outside the repo would not resolve the
toolchain and these gates would not be locally runnable as written.

## Fourth fixture — a finding, never a proof

`workflow-template-injection` targets
`.github/workflows/05-workflow-security.yml#zizmor` and carries
`applicability: "finding"`. Its cycle CONFIRMS that the gate cannot reject
(poison leg PASS with the detector's own finding present in the SARIF). See
`DEF-023-finding.md`. Coverage marks that gate `UNPROVEN` + `cannot_reject`,
and `P05.NEG03` proves such a record can never satisfy the coverage law.

## Authoring iterations (recorded, not hidden)

Two fixture-authoring corrections happened before either fixture had ever
passed, both surfaced by the framework refusing to accept an inexact proof:

1. `format-check-violation` declared its reason on **stdout**; prettier writes
   `[warn]` lines to **stderr**. The framework returned `WRONG_REASON` and
   printed both streams. Only the stream was corrected — the regexes are
   unchanged and remain specific to the intended detector. This is the
   opposite of weakening a signature.
2. `workflow-template-injection` was authored as a `seed` proof and returned
   `WRONG_TARGET` (poison leg PASS). Investigating rather than relaxing the
   fixture produced DEF-023.

Defects opened during P05: DEF-022 (wrong-cwd near miss), DEF-023 (the zizmor
finding — OPEN), DEF-024 (AUD01 false positives), DEF-025 (real architectural
duplication + a self-exempting audit), DEF-026 (interrupted-cycle residue).
