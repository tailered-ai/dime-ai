# P06.CP01 — PARITY Static/Security/Supply Chain checkpoint

## Identity

| Field | Value |
| --- | --- |
| Branch | `feat/ci-verify-control-plane` |
| HEAD | `705c9898eed249136cb02945c3f7cfd2124bda02` |
| BASE_SHA | `7fa4b3fe49f67f98e5aaa1fe466862ee3cfa20d9` |
| P06 candidate | head `705c9898` · base `7fa4b3fe` · tree `b8e2b7c6` · merge `00f9c346` · digest `32f0b8f1b7507647` |
| Contract | `400cc0391547435d…` · registry 47 entries |
| Prior phases | PB/P00/P01/P02/P03/P04/P05 all re-verified ACCEPTED (exit 0) |

## Scope derived from the CURRENT contract (P06.T01)

Ownership is a projection of the contract, not a hardcoded list:
**P06 16 · P07 4 · OPERATIONAL 7 · CI_ONLY 20**.

P06: 16 gates — 13 executable, 7 required, 6 required+executable. Two gates
are `NOT_LOCALLY_EXECUTABLE` (docker + trivy absent) and one required gate
(`gitleaks`) has **no `run:` steps** because its verdict comes from a
marketplace action, so local execution needs a P06 adapter that does not yet
exist. Seven operational gates (live production probes, network fetches,
ledger mutation) are excluded with a written reason each.

## Gate execution results (P06.T02–T12)

Executed through the P04 executor against the disposable candidate, using the
contract's own `run:` text.

**9 PASS · 4 FAIL · 3 BLOCKED**, of 7 mandatory gates **3 blocking**.

PASS: format-check, semgrep advisory, semgrep blocking, zizmor,
contract-and-data-integrity, ai-eval-critical, ci build, typecheck,
edge-arming validate.

The four failures were investigated rather than reported as verdicts, and
none is a detector finding:

| Gate | Exit | Actual cause |
| --- | --- | --- |
| `ci.yml#security-audit` | 1 | `sudo: a terminal is required to read the password` — a provisioning step. Its real checks **passed** (`{"status":"PASS",…}`, `osv-scanner: OK`) |
| `12-nightly#full-osv` | 56 | `curl: (56) Failure writing output to destination` — a download step |
| `dime-llm-validation#validate` | 2 | `No pyproject.toml found` — the runner ignored the contract working-directory |
| `01-pr-proof-contract#proof` | 1 | full suite: `passed=5079 failed=80 environmentBound=64`; failures are dominated by credential/DB-bound suites (`appUsers.login`, `ciSecrets`, `discordAuth`, `email`, `passwordReset`, `*.db.test.ts`) |

## Defects opened

- **DEF-031 (MEDIUM)** — the runner executes provisioning steps that cannot
  run non-interactively, turning environment friction into a fake gate FAIL.
- **DEF-032 (MEDIUM)** — the runner ignores contract `working-directory`.
- **DEF-033 (HIGH)** — scope derivation classifies secret-bound gates as
  EXECUTABLE. `01-pr-proof-contract#proof` and `ci.yml#test` require GitHub
  Actions secrets; locally they must be `NOT_LOCALLY_EXECUTABLE`, never
  `FAIL`. Reporting them red would be as wrong as reporting them green.

## What is NOT yet done

P06 is materially incomplete. Remaining mandatory work:

- correct the runner for DEF-031/032/033 and re-execute;
- a `gitleaks` adapter so the required gate is executable at all;
- tool-identity bootstrap with governed version pinning (P06.T01 proper);
- ASSURANCE poison/control proofs for every newly graduated gate —
  semgrep-blocking, security-audit, ai-eval-critical, gitleaks — none exist;
- the security-specific adversarial negatives (P06.NEG series);
- the CI-only classification audit (P06.AUD01);
- full cross-phase regression.

## ACCEPT(P06)

`all_mandatory_closed` false · `all_gates_pass` false ·
`zero_blocking_open_defects` false (DEF-031/032/033 open) ·
`evidence_complete` false.

## Decision

**DO NOT PROCEED**

**Blocking IDs: DEF-031, DEF-032, DEF-033**
