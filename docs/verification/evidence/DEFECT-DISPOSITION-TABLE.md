# Defect dispositions

## Acceptance-time table (base `43a33c84`, candidate `b81f6a47`) — supersedes the §22 table below, which is preserved unchanged

| ID | Sev | Root cause | Class | Disposition at acceptance |
| --- | --- | --- | --- | --- |
| DEF-045 | LOW (regraded from MEDIUM at acceptance review; rationale in ledger history) | `dime-llm-validation#validate` red on origin/main itself; failures byte-identical on base | base | **OPEN, advisory** — not a required context, path-scoped to the DORMANT `ml/**` lane, base debt |
| DEF-046 | LOW | nightly tier red (full-osv + full-container-scan); local verifier reproduces both exactly | base | **OPEN, advisory** — AUDIT tier, not a merge-contract context |
| DEF-053 | HIGH | two ERROR-severity `.semgrep/` rules fail to parse; the gate exits 0 anyway | candidate (rule content) | **OPEN, advisory** — fix designed + sandbox-proven but `.semgrep/` content is outside P06 authority; gate graduating, not required; rejection capability independently PROVEN |
| DEF-056 | MEDIUM | main outpaces a full verification cycle | structural | **CLOSED** — freeze (coordinated human merge hold, nothing weakened) held through the full final cycle; barrier PASS (`FREEZE-43a33c84.md`) |
| DEF-057 | HIGH | worktree candidates left the cloudflare-os gitlink empty while CI checks out `submodules: recursive` | verifier | **CLOSED** — `provisionCandidate` submodule init; retested (T16) |
| DEF-058 | HIGH | contract extractor dropped workflow-level `env:` blocks (job∪step only) → false detector FAIL on a correct submodule pin | verifier fidelity | **CLOSED** — extractor folds workflow∪job env; delta proven exactly 4 checks; contract `9b52169c → b594ebd9`; tailered-os#test PASS ×3 chains (T16) |
| DEF-059 | HIGH | gitleaks `cloudflare-api-key` fires on the quoted-JSON juxtaposition the DEF-058 fix created; value is the public submodule commit SHA | candidate finding (false positive) | **CLOSED** — one fully-anchored literal per the config's public-SHA convention; range rescan 1→0; planted secrets still fire; canary PROVEN (T17) |
| DEF-060 | MEDIUM | 15s-bounded test dynamically imported the full app-router graph under v8 coverage at host load 18 — the bound measured CPU availability | candidate test-quality (DEF-047 Cause-C class) | **CLOSED** — static top-level import (5-sibling pattern); assertions unchanged; timeout NOT widened; coverage gate PASS 172.6s on retest (T18) |

All other defects (DEF-044, DEF-047, DEF-049, DEF-050, DEF-051, DEF-052,
DEF-054, DEF-055) were already CLOSED with retest evidence in prior turns.

---

## §22 — canonical disposition of every defect open at turn start (historical, preserved unchanged)

The turn's brief said seven were open. The canonical ledger said **six** at
turn start: the seventh (DEF-049) had been closed in the final action of the
previous turn. That discrepancy is recorded rather than adopted, because the
ledger is the authority and "the brief said so" is not evidence.

Four further defects were opened during this turn (DEF-051 already closed
previously, plus DEF-053 and DEF-054 here), and each carries its own
disposition below.

| ID | Sev | Phase | Root cause | Class | Remediation | Acceptance impact | Final status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEF-044 | MED | P06 | Money Semgrep rule cannot fire — corrected diagnosis: it does not merely mis-constrain, it fails to **parse** | candidate | superseded by DEF-053, which carries the accurate cause and the proven fix | none — gate is graduating, not required | **CLOSED (superseded)** |
| DEF-045 | MED | P06 | `dime-llm-validation#validate` red on base itself; 6 failures byte-identical on new base `29a4a97e` | base | none — outside P06 scope, and it is not a candidate regression | **ADVISORY, non-blocking** — not among the 9 required contexts | OPEN |
| DEF-046 | LOW | P06 | Nightly tier red (OSV + container scan); local verifier reproduces both exactly | base | none — dependency/base-image debt | **ADVISORY, non-blocking** — AUDIT class, not a merge-contract context | OPEN |
| DEF-047 | HIGH | P06 | `#proof` intermittent. Environmental root cause was DEF-049's abandoned CPU-load generators; a second, independent cause was found this turn | environment + candidate | load generators killed; CONTRACT.md rendered; bcrypt invariant made deterministic | **BLOCKING until the determinism campaign and ASSURANCE proof complete** | see checkpoint |
| DEF-050 | HIGH | P01 | No candidate constructable — main advanced and conflicted on `pnpm-lock.yaml` | verifier/base | authorized integration merge + canonical lockfile reconciliation | was blocking; now resolved | **CLOSED** |
| DEF-052 | MED | P06 | bcrypt test hardcoded its own cost, so it verified nothing about production | candidate | invariant made real and negatively proven | resolved | **CLOSED** |
| DEF-053 | HIGH | P06 | **Two** ERROR-severity Semgrep rules fail to parse; the gate's own invocation shape makes it exit 0 anyway | candidate | correction designed and proven in sandbox; **not applied** — `.semgrep/` rule content is outside P06's authorized scope | **ADVISORY, non-blocking** — `03-semgrep#blocking` is graduating, not required, and its ability to reject is independently proven via a working ERROR rule | OPEN |
| DEF-054 | MED | P06 | My own first bcrypt fix was vacuous — `server/**/*.ts` excludes files directly under `server/` | verifier | pathspec corrected; caught by its own negative test | resolved | **CLOSED** |

## Why the two remaining advisories do not gate acceptance

The nine required contexts are `contracts`, `dependency-review`,
`deterministic`, `gitleaks`, `proof`, `security-audit`, `test`, `typecheck`,
`zizmor`. Neither `dime-llm-validation#validate` (DEF-045) nor
`03-semgrep#blocking` (DEF-046's sibling tier and DEF-053's gate) appears in
that list — the latter is *graduating*. Under the frozen acceptance model a
non-required context is not part of the merge contract, so a base-existing red
in one cannot gate this branch.

That is a disposition, not a dismissal. Each is reported truthfully, none is
recorded as PASS, none is suppressed, and none is claimed to be resolved.

## The one that would have gated, and why it does not

DEF-053 is the uncomfortable case: two ERROR-severity security rules have been
contributing nothing, and the gate reports success. Under §18 that is a
mandatory-detector capability failure **only if the rule participates in
required enforcement**. It does not — `03-semgrep#blocking` is graduating. The
gate's own ability to reject is separately proven by an ASSURANCE cycle using
`dime-session-secret-fallback`, a rule that does parse and does fire.

So the gate is honest about itself; two of its rules are not. The correction
is designed and proven (3 findings against a three-branch fixture, 0 false
positives against a clean one) and deliberately not applied, because
`.semgrep/` rule content is candidate source outside this phase's authority.
