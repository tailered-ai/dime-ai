# P04.T01–T10 implementation record

Six new runtime modules under `scripts/ci/`, one fixture corpus, one audit
module, one test surface. Every gate result flows through P03's
`makeResult`/`validateResult`/`JsonlReporter` — P04 adds no result vocabulary
(proven by P04.AUD03).

| Unit | Module | Substance |
| --- | --- | --- |
| T01 | `scheduler.mjs` | Validated DAG (unknown prereq / self-dep / duplicate edge / cycle refuse UP FRONT with the cycle members); Kahn order with lexicographic tie-break — never filesystem, hash-map, clock, or race order; central `PREREQUISITE_PERMITS` table, totality-asserted over the 12 statuses at module load; refused dependents settle `BLOCKED` with `blocked_by` causal records and cascade; journaled, sequence-numbered decision log |
| T02 | `scheduler.mjs` | `makeBudget` with per-dimension enforcement truth (`SCHEDULER_ENFORCED` admission arithmetic vs `DECLARED` hints — OS quotas are never claimed); pure `admissionDecision` (ADMIT/WAIT/IMPOSSIBLE); an impossible declared requirement is `INFRA_FAIL RESOURCE_ADMISSION_IMPOSSIBLE`, never product FAIL, never started |
| T03 | `lane.mjs` | Named exclusive lane; atomic `mkdir` lock (exactly one winner) + `owner.json`; per-lane append-only journal; in-process FIFO queue serializes scheduler-sanctioned requests — serialize, never reject |
| T04 | `environment.mjs` | ONE construction boundary; classification of every name (inherited/set/removed/forbidden/gate_supplied/secret_ci_only); TZ=UTC, LC_ALL=C.UTF-8, seed, isolated per-gate TMPDIR under the owned run root; owned-port reservation held live until release, collision-checked; secret-shaped names stripped and recorded BY NAME ONLY; markers unoverridable; stable `profile_id` |
| T05 | `environment.mjs` | Policy (`allow`/`deny`/`inherit`) is DATA; `detectNetworkEnforcement` claims `HERMETIC:ENFORCED` only for an executor-owned AND verified mechanism — this host has none, so `HERMETIC:UNENFORCED`; verdict table: mandatory deny+unenforced → `INCONCLUSIVE`, allow never downgraded |
| T06 | `proc.mjs` | Monotonic (`hrtime.bigint`) deadline; latch: post-deadline outcome is TIMEOUT even on late exit 0; SIGTERM → bounded grace → SIGKILL against the child's own process GROUP (detached spawn); full signal sequence recorded |
| T07 | `teardown.mjs` | Registry of owned resources (9 declared classes) with per-entry cleanup callback, status, and evidence; LIFO sweep, idempotent, failure-visible; ownership law: realpath containment for paths (traversal + symlink escape refused at REGISTRATION), live handle or fresh `CI_VERIFY_OWNER` marker re-verification for pids, run_id+acquisition_id for lane locks; `wireSignals` covers SIGINT/SIGTERM/uncaughtException with a SYNCHRONOUS interrupt latch (DEF-021); SIGKILL honestly declared uncatchable — recovery is next-invocation discovery |
| T08 | `executor.mjs` | Attempt records preserved append-only; retry ONLY for `FAIL` under declared `max_attempts`; `NEVER_RETRY` = BLOCKED/INFRA_FAIL/CONTRACT_DRIFT/BROKEN_GATE/INCONCLUSIVE/TIMEOUT; P03 `classifyAttempts` makes fail-then-pass FLAKY; upgrade-only override chain (network downgrade, owned-leak, candidate-mutation, cleanup-failure) preserving the functional outcome in the reason |
| T09 | `executor.mjs` | `executor.jsonl` append-only event stream (schema 1.0.0: RUN_START, SCHED_DECISION, GATE_START, ENV_PROFILE, NETWORK, LANE, ATTEMPT_SPAWNED, ATTEMPT, LEAK, INTEGRITY, CLEANUP_FAILED, GATE_RESULT, CLEANUP, INTERRUPT_SIGNAL, INTERRUPTED, RUN_COMPLETE); final results via P03 `JsonlReporter` in deterministic graph order; `manifest.json` written LAST by write-then-rename with SHA-256 of both streams; `readExecutorEvidence` refuses INCOMPLETE_RUN / EVIDENCE_TAMPERED; stdout/stderr captured to separate per-attempt files; exit codes only from the child `exit` event |
| T10 | `lane.mjs` | Sentinel: STRUCTURAL journal audit (`auditLaneJournal`) — a second ACQUIRE before RELEASE is a violation by append order, no clocks; bypass `tryAcquire` on a held lane journals + throws `LANE_VIOLATION`; stale locks (dead owner pid) are DETECTED and CLASSIFIED, reclaimed only via journaled `reclaimStale`; `UNAUTHORIZED_RELEASE` protects foreign locks; `{gate_id, lane, acquisition_id, entered_at, exited_at, release_state}` recorded per protected interval |

Process-execution rules (§12): direct argv spawn default; shell is opt-in and
runs under GitHub Actions' EXACT default (`bash --noprofile --norc -e -o
pipefail -c`), so the DEF-007 piped-`$?` false-PASS class is structurally
impossible; `cwd` is required (never the developer working directory by
default); ENOENT → `BLOCKED MISSING_EXECUTABLE`, other spawn errors →
`INFRA_FAIL SPAWN_FAILURE`; signal termination recorded distinctly.

Defects found and closed during P04: DEF-021 (HIGH — interrupt/completion
race; see `DEF-021.md`).
