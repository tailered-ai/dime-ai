# T19 — P06 acceptance evidence (base `43a33c84`, candidate `b81f6a47`)

Candidate: branch head `b81f6a47` merged onto FROZEN_BASE_SHA `43a33c84`
(P01 committed-mode synthetic merge). Contract `b594ebd9` (re-derived after
DEF-058; regeneration delta proven exactly 4 checks gaining workflow-level
env). All runs serial — no concurrent suites (the DEF-047/contention law).

## Roster — 18 gates, blocking 0, reconciles=true

Full log: `T19-acceptance-roster.log`. 14 PASS · 3 FAIL · 1 BLOCKED:

- **PASS (14)**: format-check 15.7s · proof 420.0s · semgrep advisory 74.1s ·
  semgrep blocking 18.7s · zizmor 0.6s · contracts 3.8s · artifact 138.1s ·
  deterministic 9.3s · ci build 9.2s · security-audit 3.1s · typecheck 21.3s ·
  edge-arming validate 1.8s · gitleaks 0.6s · **tailered-os test 81.9s**
  (DEF-057+DEF-058 both fixed and retested)
- **FAIL (3)** — all base-existing, dispositioned, none in the 9 required
  contexts: full-container-scan, full-osv (DEF-046, LOW), dime-llm-validation
  (DEF-045, LOW — path-scoped to the DORMANT ml/ lane)
- **BLOCKED (1)**: 13-tos-notion-context — correct exit-32 refusal
  (EXPRESSION_UNRESOLVED, credential-bound workflow; nonlocal audit T13)

Mandatory gates 7, blocking **0**.

## ASSURANCE — 8/8 PROVEN, mandatory local coverage 6/6

Full log: `T19-acceptance-assurance.log`. Every fixture completed
control-PASS → poison-FAIL (exact step + reason) → restore → control-PASS:
ai-eval-knowledge-corrupt, contracts-migration-mutation, **gitleaks-canary**
(re-proving the gate rejects planted secrets after the DEF-059 allowlist),
proof-failing-test, security-audit-unpinned-action,
semgrep-blocking-session-secret, typecheck-ts2322, zizmor-template-injection.

Coverage (registry-derived, required ∧ P06-owned ∧ locally executable):
proof, zizmor, contracts, deterministic, security-audit, typecheck — 6/6
PROVEN.

## Cross-phase regression at the same candidate

| Check | Result |
| --- | --- |
| P06+P07 negative suites | 56/56 |
| Full scripts phase suite (incl. the 6 new upstream tests) | 880/880 |
| prettier | clean |
| `ledger.mjs verify` | OK — no tampering, drift, or stale evidence |
| `contract-conformance.mjs verify` | PASS — 42 workflows, 53 checks, 9 required contexts |
| `contract-conformance.mjs audit` (yaml boundary) | PASS |
| `p03-audit.mjs` | AUD02 PASS |
| `selftest/p05-audit.mjs` | AUD02 PASS |
| `tsc --noEmit` | clean |

## #proof determinism at this base

5/5 consecutive full-suite PASS campaign (T14, no retries) at the prior
integrated base, and #proof PASS in every serial chain since integration of
`43a33c84`: 268.4s → 175.2s → 420.0s (acceptance), all serial, all green —
zero #proof failures at any 43a33c84-based candidate when run without
suite-level contention.

## Defect state at acceptance

Closed this window: DEF-047, DEF-049, DEF-050, DEF-051, DEF-052, DEF-054,
DEF-055, DEF-056 (freeze held), DEF-057, DEF-058, DEF-059, DEF-060.
Open advisories (all with recorded dispositions, none attributable as
program-blocking): DEF-045 (LOW), DEF-046 (LOW), DEF-053 (HIGH but
non-attributed: `.semgrep/` rule content is candidate source outside P06
authority; the gate is graduating, not required; its rejection capability is
independently PROVEN via a parsing ERROR rule).

## Freshness

`origin/main == 43a33c84 == FROZEN_BASE_SHA` — barrier PASS after the
acceptance chain; re-executed immediately before the acceptance records.
