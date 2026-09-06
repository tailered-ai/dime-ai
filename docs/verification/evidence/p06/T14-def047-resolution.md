# DEF-047 — resolution evidence

## The instability had three independent causes, not one

The previous checkpoint attributed all of DEF-047 to abandoned CPU-load
generators (DEF-049). That was the dominant cause but not the whole one.
Killing them was necessary and insufficient: the first determinism attempt on
a healthy host still failed, and the second failed again for a different
reason. Both remaining causes were real, and both are now fixed.

### Cause A — environmental (DEF-049, closed previously)

Eight orphaned `while :; do :; done` processes from a prior session, running
2 days 23 hours, holding host load at 36.9–58.2 on 8 cores. Terminated; load
fell to ~5.

### Cause B — a stale rendered contract (found by campaign attempt 1)

Attempt 1 failed deterministically on `P02.CONF01 / CONF02 — conformance`.
The cause was mine. The contract had been re-derived for integrated main in
the *working tree*, but P01 builds candidates from **committed** state, so
every candidate carried a stale frozen contract against merged-new workflows.
Attempt 2 then failed the same test for a narrower reason:
`docs/verification/CONTRACT.md` is a separately rendered artifact that §10
lists and I had not regenerated.

Committed as `d37ae215` and `ff5d3a48`. This was the verification chain
catching an inconsistency in its own inputs, which is what it exists for.

### Cause C — a genuine host-contention proxy (found by campaign attempt 2)

Attempt 2 also failed on `bcrypt cost=10 completes in < 500ms` at
**elapsed=531 ms** — a 6% overshoot, on a healthy 8-core host with zero
synthetic load, inside the full 5,090-test suite. Measured idle on the same
machine: median 60 ms, p95 65 ms over 40 samples.

That is §6's trigger met on evidence: a single-sample wall-clock assertion
sharing a machine with thousands of parallel tests measures CPU availability,
not bcrypt. Separately, it could not detect what its name claimed — it passed
the cost itself, so the five production hashing sites were never checked
(DEF-052).

Remediated by making the invariant real rather than by relaxing the bound:

| Assertion | Kind | Detects |
| --- | --- | --- |
| hash embeds cost ≥ 10, read from the modular-crypt prefix | deterministic | a hash produced below OWASP grade |
| **every production `bcrypt.hash` site uses cost ≥ 10** | deterministic | a production misconfiguration — previously untested |
| median of 5 samples < 500 ms (**same bound**) | statistical | a real cost regression, each +1 doubling the work |

bcrypt cost was not lowered, the threshold was not widened, and nothing was
excluded, retried, or allowlisted.

The first version of the production-cost check was itself vacuous — the
pathspec `server/**/*.ts` silently excludes files sitting directly in
`server/` (228 of 441 `.ts` files), hiding `server/stripeWebhook.ts`. Its own
negative test caught that; recorded as DEF-054.

**Negative proof:** control 16/16 PASS → poison `server/stripeWebhook.ts`
cost 10→4 → FAIL naming `server/stripeWebhook.ts(cost=4)` → restore → 16/16
PASS, zero residue.

## Determinism campaign (§15) — 5/5, no retries

Same candidate, same toolchain, same provisioning, full collection every run.
No rerun-on-failure, no parameter changes between attempts; the harness
terminates on the first non-PASS rather than continuing.

| Run | Verdict | Duration | Host load at start |
| --- | --- | --- | --- |
| 1 | **PASS** | 143.4 s | 2.94 |
| 2 | **PASS** | 212.6 s | 8.73 |
| 3 | **PASS** | 204.4 s | **12.55** |
| 4 | **PASS** | 145.8 s | 9.30 |
| 5 | **PASS** | 157.9 s | 9.74 |

Final collection: `passed=5092 failed=0 skipped=105 notExecuted=0
environmentBound=0`, 317 test files passed, 13 skipped.

Run 3 began at load 12.55 on 8 cores — above nominal capacity — and still
passed. That is worth more than a quiet-machine result: the gate is stable
under real contention, not only under ideal conditions.

## Preserved failures

Nothing was deleted and no run was retried to obtain a better outcome. Both
earlier campaign attempts are preserved in full at
`.ci-verify/campaign-attempt1-stale-contract/` and
`.ci-verify/campaign-attempt2-conf-and-bcrypt/`, alongside the original two
PASS and three FAIL runs recorded in prior turns.

## Closure status

The determinism half of DEF-047 is complete. Closure additionally requires the
`#proof` ASSURANCE poison/control cycle on the current candidate and a
re-derived mandatory proof-coverage count; until those are recorded, DEF-047
stays OPEN.
