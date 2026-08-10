# P04.CP01 — Executor Core checkpoint

Recorded 2026-08-10. Sole ledger writer used throughout; no manual edits.

## Identity and provenance

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| Execution-start HEAD | `1fa8e2153809261da6b426dce2e31ba650b8866a` (tree `394b9559…`, parent `0576e8bb…`) |
| `origin/main` (fetched at entry) | `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` (unchanged from P03) |
| Fresh P04 candidate | `head_sha 1fa8e215…` · `base_sha 4d644cf4…` · `merge_tree_sha 394b9559…` · `merge_commit_sha f03b6db328b7164fd554ddbf21e126638c1a3d4d` |
| Candidate identity digest | `a9a86c6b41532ae98222d0b9b5b920c4b930061bbfc076f0c2f4948d1ccc8418` — reproduced byte-identically across two independent snapshot runs; P03's snapshot (head `0576e8bb…`) is superseded |
| Contract sha256 | `58087d2a8262064658cac283703777dce60e414f323fbb5f8b54fb6885e172d5` (disk == pin, verified before registry use) |
| Ledger sha256 at entry | `a059ce295be800bc2ca01fc8e41f1e7018174e72dbc3ce4031aaef6ed951b089` (disk == pin) |
| Blueprint sha256 | entry `423ccd31…`; after AMD-005 `fb18bfad5908a497c830af462f3726ed8298d8ead9b852819ea6b11b91ef4bb5` (append-only authorization; GEN-000 untouched) |
| Registry | 47 PARITY entries from the frozen contract (LOCAL 17 / LOCAL+TOOL 10 / CI-ONLY 20; required 9, graduating 5); 4 out-of-scope recorded |
| Executor schema | `executor.jsonl` schema 1.0.0; result schema 1.0.0 (P03's, unchanged) |
| Toolchain | Node v22.22.0 · pnpm 10.33.0 · git 2.55.0 · container runtime ABSENT (docker/podman unavailable) |

## Entry conditions

P03 ACCEPTED (re-verified: `accept PB/P00/P01/P02/P03` all exit 0 at entry).
Container runtime absent → **HERMETIC:UNENFORCED explicitly accepted** for P04
(`entry-record.md`); consequences honored throughout (NEG04: deny ⇒
INCONCLUSIVE, never PASS; no simulated enforcement anywhere).

## What was built (units T01–T10 + declared additions)

Six runtime modules (`scheduler.mjs`, `lane.mjs`, `environment.mjs`,
`proc.mjs`, `teardown.mjs`, `executor.mjs`), the audit module
(`p04-audit.mjs`), 7 fixtures (`fixtures/p04/`), and the 52-test suite
(`p04.test.ts`). Full substance table: `T01-T10-implementation.md`.

- **Scheduler DAG:** validated before execution (unknown prereq,
  self-dependency, duplicate edge, cycle-with-members all refuse up front);
  lexicographic deterministic order; central PREREQUISITE_PERMITS table,
  totality-asserted over the 12 statuses; refused dependents settle BLOCKED
  with `blocked_by` causal records, cascading. Decision log is
  sequence-numbered evidence.
- **Budget:** concurrency/process/memory admission `SCHEDULER_ENFORCED`
  (admission arithmetic over declared hints), cpu `DECLARED` — OS enforcement
  never overclaimed, per-dimension notes in the budget object itself.
- **DB lane + sentinel:** atomic-mkdir named lock + owner record + per-lane
  append-only journal; scheduler path SERIALIZES (never rejects); bypass
  acquisition journals + throws LANE_VIOLATION structurally (no timing);
  stale locks detected, classified, reclaimed only via journaled
  `reclaimStale`; `UNAUTHORIZED_RELEASE` protects foreign locks; intervals
  `{gate_id, lane, acquisition_id, entered_at, exited_at, release_state}`.
- **Environment:** one construction boundary; six-way name classification;
  TZ=UTC, LC_ALL=C.UTF-8, recorded seed, per-gate TMPDIR under the owned run
  root, held-open collision-checked port reservations; secret-shaped names
  stripped and recorded BY NAME ONLY; markers unoverridable; stable
  profile_id.
- **Network truth:** policy is data; `HERMETIC:ENFORCED` claimable only for
  an executor-owned AND verified mechanism (none here ⇒ UNENFORCED);
  mandatory deny+unenforced ⇒ INCONCLUSIVE.
- **Timeout:** monotonic deadline, latched (late exit 0 stays TIMEOUT),
  SIGTERM → grace → SIGKILL against the child's own process group, sequence
  recorded. TIMEOUT ∈ NEVER_RETRY.
- **Teardown:** registry over 9 resource classes; LIFO, idempotent,
  failure-visible sweep; ownership proofs (realpath containment / live
  handle / fresh env-marker re-verification / run_id+acquisition_id);
  SIGINT/SIGTERM/uncaughtException wired with a SYNCHRONOUS interrupt latch;
  SIGKILL honestly uncatchable — recovery is next-invocation discovery.
- **Attempts/results/evidence:** retry only FAIL under declared
  max_attempts; fail-then-pass ⇒ FLAKY via P03 `classifyAttempts`;
  upgrade-only override chain preserving the functional outcome;
  `executor.jsonl` append-only events; results via P03 `JsonlReporter` in
  deterministic graph order; `manifest.json` written LAST
  (write-then-rename) with SHA-256 of both streams; `readExecutorEvidence`
  refuses INCOMPLETE_RUN / EVIDENCE_TAMPERED.
- **Process fidelity (§12):** argv spawn default; shell opt-in under GitHub
  Actions' exact default (`bash --noprofile --norc -e -o pipefail -c`) ⇒ the
  DEF-007 piped-exit-status false-PASS class is structurally impossible; cwd
  required; ENOENT ⇒ BLOCKED MISSING_EXECUTABLE, other spawn errors ⇒
  INFRA_FAIL; stdout/stderr separate; exit codes only from the child exit
  event.

## Validation results (all in `P04-suite.txt`, 52/52; 5 consecutive green runs)

**TEST01** linear/branching/independent ordering, causal BLOCKED cascade,
up-front refusals (with cycle members), lexicographic determinism, journaled
decisions, permit-table totality — PASS.
**TEST02** two DB gates: serialized not rejected, structurally disjoint
intervals (RELEASE line precedes next ACQUIRE line), one holder, zero
violations, both released, final lane state empty — PASS.
**TEST03** real child observed TZ/locale/seed/owned TMPDIR/owned
port/NODE_OPTIONS; host canary and removed canary did NOT leak; secret-shaped
names recorded by name only, value absent from the profile; markers
unoverridable; ports collision-checked and released — PASS.

Exact NEG failure signatures, each fired for its declared reason:
- **NEG01** leaked owned child ⇒ `INFRA_FAIL` reason `OWNED_RESOURCE_LEAK …
  functional outcome was PASS`; orphan verified dead; teardown clean.
- **NEG02** graceful: `TIMEOUT` with `deadline 400ms` reason, SIGTERM only,
  latch defeats the child's exit 0. Stubborn: signal sequence exactly
  `SIGTERM→SIGKILL`, child reaped, `TIMEOUT`.
- **NEG03** SIGINT at READY ⇒ exit 130; children dead; zero marked
  processes/locks/tmp; NO manifest; `readExecutorEvidence` ⇒
  `INCOMPLETE_RUN`; `INTERRUPTED` event journaled.
- **NEG04** deny-gate ⇒ `INCONCLUSIVE` reason `NETWORK_DENY_UNENFORCED`,
  events record `HERMETIC:UNENFORCED`; allow-control PASS; ENFORCED claimable
  only owned+verified (both directions unit-proven).
- **NEG05** zero suppression shapes in shipped modules; detector positive
  corpus proven; runtime probes `false|tee`⇒1, `(exit 7)|cat`⇒7, `(false)`⇒1,
  errexit⇒1, deliberate `false||true`⇒0 recorded as the contract's own choice.
- **NEG06** bypass ⇒ `LANE_VIOLATION` thrown + journaled; holder intact;
  forged release ⇒ `UNAUTHORIZED_RELEASE`; violation survives later green
  (append-only journal); queue-path control serializes; stale lock ⇒
  `STALE_LOCK` classified, journaled reclaim only.
- **NEG07** unowned similar-name process alive after REFUSED_UNOWNED;
  lookalike/traversal/symlink-resolved paths all `UNOWNED_PATH`, bystander
  files survive; owned-tree removal does not follow symlinks out; foreign
  lock release refused; malformed registrations refused
  (UNKNOWN_RESOURCE_TYPE / RESOURCE_ID_REQUIRED / CLEANUP_CALLBACK_REQUIRED /
  UNOWNED_PATH); duplicate cleanup idempotent; cleanup failure visible
  (clean=false, failure listed).
- **NEG08** missing mandatory ⇒ blocking MISSING_RESULT; runGate exception ⇒
  INFRA_FAIL EXECUTOR_EXCEPTION (never product FAIL); missing executable ⇒
  BLOCKED; malformed result refused by reporter; tamper/truncate ⇒
  EVIDENCE_TAMPERED with green restore controls; incomplete manifest ⇒
  INCOMPLETE_RUN; stale candidate ⇒ CANDIDATE_STALE, incomplete ⇒
  CANDIDATE_INCOMPLETE; contract drift ⇒ CONTRACT_DRIFT blocks
  registry-bound execution; cwd mutation ⇒ INFRA_FAIL CANDIDATE_MUTATION with
  functional outcome preserved; hidden flake structurally invalid at the P03
  boundary.

**FI01** SIGKILL ⇒ exit signal SIGKILL, owned children SURVIVE (honest
uncatchable boundary), run unreadable as complete; recovery discovery finds
marker-verified orphans, reaps them (zero after), classifies the lane STALE
and reclaims via journal; the three termination boundaries (SIGINT caught /
exception caught / SIGKILL uncatchable) explicitly distinguished — PASS.
**FI02** 600+600 hints under a 1000MB budget serialize (WAIT journaled,
structural non-overlap of spawn events); 4096-hint gate ⇒ INFRA_FAIL
`RESOURCE_ADMISSION_IMPOSSIBLE`, zero attempts, never started; no fan-out;
teardown clean — PASS.

**CLN01 10/10** — per-iteration records in `raw/cln01-iterations.json`:
every iteration independently non-zero exit, children dead, 0 marked
processes, 0 lane locks, tmp removed, no manifest. All ten clean.

## Audits

- **AUD01** teardown ownership (`AUD01-teardown-ownership.txt`): every
  destructive primitive maps to its declared home and ownership proof
  (10 allowed sites; rmSync only behind realpath containment, rmdir/unlink
  only in verified lane release/reclaim, kill only handle- or
  marker-verified); ZERO broad mechanisms (no pkill/killall/rm -rf/prune/
  wildcard); OWNERSHIP_SURFACE declared and compared — PASS.
- **AUD02** process fidelity (`AUD02-process-fidelity.txt`): exactly ONE
  gate-child spawn site (proc.mjs), read-only ps probes classified; exit
  codes captured directly on every path; GHA shell flags asserted exactly;
  DEF-007 class regression-anchored by runtime probes — PASS.
- **AUD03** P03 integration (`AUD03-p03-integration.txt`): no second
  taxonomy/summary/PARITY registry/YAML boundary/ledger writer/acceptance
  predicate; canonical imports proven present; P04 status tables ⊆ and
  total over the 12 statuses — PASS.
- P02's YAML-isolation audit re-run over the tree now scans the six new P04
  modules as other-runtime: zero violations.

## Prior-phase regression

`scripts/` Vitest 587/587 (35 files: PB 35, P01 20, P02 31, P03 56, P04 52 +
tooling) · tsc 0 · prettier 0 · ledger verify 0 · contract conformance
verify/render/doc/audit 0 (CONTRACT.md byte-identical re-render) · registry
fidelity 0 · p03-audit 0 · P01 provenance audit 0 · actions-security 0 ·
federation docs 0 · frozen install (established `--ignore-scripts` mode) 0.
Full command→exit table: `P04-validation-sweep.txt`.

## Ledger discipline

Units: **30/30 mandatory closed** (T01–T10, TEST01–03, NEG01–08, FI01–02,
CLN01, AUD01–03, EV01, GATE01, CP01 — CP01 closed upon this record).
Defects: **DEF-021 opened (HIGH) and CLOSED** through the full lifecycle
(detect → record → classify → root-cause → correct → targeted retest →
relevant regression → negative retest → evidence → close); the interrupt/
completion race it names is exactly the class NEG03/CLN01 exist to catch,
and both are its permanent regression anchors. Canonical totals: **21
defects, 21 closed, 0 open.** Amendments: AMD-001..AMD-005 (AMD-005 declared
the six new P04 IDs, additive-only). Flaky: **0** (5 consecutive green full
suites). Missing evidence: **0** (every PASS carries hashed, existing,
non-empty evidence — enforced by the writer). Contract drift: none.
Infrastructure failures: none unresolved. Inconclusive: none among P04
units (the INCONCLUSIVE deny-gate outcome is a fixture result the tests
assert, not a unit status).

## Resources and unrelated work

Residue delta (DEF-013 method): P04's own snapshot runs disposed; executor
test runs confined to isolated scratch roots; 0 marked processes (raw ps
hits were the probe's own argv, classified); 0 lane locks; 0 held ports.
Two `.ci-verify/runs` dirs PRE-DATE P04 (pids 22880/53536 vs this session's
73656+) — observed, not adopted, not deleted (prior-session artifacts).
Unrelated working tree: 25 entries, fingerprints byte-IDENTICAL start→end
(including the historically self-mutating `bootstrap-gstack.sh`, 709c1a75 at
both ends). Zero unrelated paths staged; zero mutated.

## Exact controlled files changed (the P04 initiative surface)

New: `scripts/ci/scheduler.mjs`, `scripts/ci/lane.mjs`,
`scripts/ci/environment.mjs`, `scripts/ci/proc.mjs`,
`scripts/ci/teardown.mjs`, `scripts/ci/executor.mjs`,
`scripts/ci/p04-audit.mjs`, `scripts/ci/p04.test.ts`,
`scripts/ci/fixtures/p04/` (7 fixtures).
Modified: `scripts/ci/blueprint.mjs` (AMD-005 additions only),
`docs/verification/ci-verify-ledger.json` + `.sha256` + rendered ledger (sole
writer), `docs/verification/evidence/p04/` (this evidence).

## ACCEPT(P04) — the seven terms

1. Every mandatory unit closed: **30/30** ✓
2. All acceptance gates PASS: GATE01 ✓ (CLN01 10/10, NEG01, NEG04 all PASS)
3. All checkpoints recorded with evidence: CP01 = this record ✓
4. All authorizations granted: none declared for P04 ✓ (HERMETIC:UNENFORCED
   entry acceptance recorded at entry)
5. Zero OPEN defects ≥ MEDIUM: 21/21 closed ✓
6. Evidence completeness 100%: writer-enforced, `verify` exit 0 ✓
7. Zero FLAKY mandatory units: 0 ✓

`ledger.mjs accept P04` evaluates the predicate mechanically; its exit 0 is
recorded in the post-checkpoint refresh.

## Decision

**PROCEED TO P05**

P05 must construct its OWN fresh prospective merge from the new committed
P04 baseline HEAD (this pre-commit candidate certifies `1fa8e215…` and is
superseded by the commit that follows this checkpoint).
