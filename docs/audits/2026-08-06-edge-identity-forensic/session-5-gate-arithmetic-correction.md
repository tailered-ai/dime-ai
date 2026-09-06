# Session #5 — Gate Arithmetic Correction

**The published gate totals in PR #474 and PR #475 were wrong.** This record states what was
wrong, how it happened, what the correct figures are, and the structural change that stops it
recurring. It corrects **arithmetic only**. Every per-gate classification, every piece of
evidence, and both historical verdicts in those records stand unchanged and are not rewritten.

From this point,
[`session5-closure-gates.json`](./session5-closure-gates.json) is the **authoritative source** for
gate status and counts. Prose records cite it; they do not maintain their own sums.

---

## 1. What was published, and what was true

| Record | Published | Actual at that moment |
| --- | --- | --- |
| PR #474 | 32 PASS · 6 BLOCKED · 1 NOT PROVEN · 0 FAIL — over **39** | 30 PASS · 10 BLOCKED · 2 NOT_PROVEN · 0 FAIL — over **42** |
| PR #475 | 32 PASS · 7 BLOCKED · 0 NOT PROVEN · 0 FAIL — over **39** | 30 PASS · 10 BLOCKED · 2 NOT_PROVEN · 0 FAIL — over **42** |
| **This correction** | — | **33 PASS · 7 BLOCKED · 2 NOT_PROVEN · 0 FAIL — over 42** |

The denominator itself was understated. Both the numerator and the denominator were wrong in
both records.

The movement from `30 PASS` to `33 PASS` is **not** part of the correction — it is three gates
genuinely closed by owner action after PR #475 merged (G-013, G-017, G-019; see §4).

**The verdict never changed and does not change now.** `COMPLETE WITH EXPLICIT EXTERNAL BLOCKER`
was correct under the wrong arithmetic and remains correct under the right arithmetic, because
it turns on `BLOCKED > 0`, not on any total.

---

## 2. Why it happened

Three causes, compounding:

1. **The totals were prose.** A hand-maintained line at the bottom of a markdown table, which
   nothing derived and nothing checked. It drifted the moment a row was added.

2. **Markdown rows silently carried more than one gate.** `#467 · #468 · #469 merged and
   present` is three gates on one row. `Human / agent / pipelines under enforcement ×3` is three
   more. Counting rows and counting gates gave different answers, and neither was written down
   as the definition.

3. **The recount script written to catch it had its own defect.** It matched `/×(\d+)/` against
   the whole table line, so `×3 shapes` appearing in an **evidence** column was read as a gate
   multiplier. The first attempted correction was therefore also wrong — it reported 42 gates by
   coincidence rather than by counting.

Cause 3 is the important one. A verification tool that is itself unverified reproduces the class
of failure it was written to detect. It is the same shape as the two false zeros this session
already produced from broken command pipelines — a plausible number arrived at by an unsound
route.

---

## 3. The structural fix

Correcting the number by hand would have fixed one instance of an unbounded problem. Instead:

- **Every gate has a permanent unique ID** — `G-001` … `G-042` — assigned once and never reused.
- **Status is a machine-readable enum field**, not prose: `PASS | BLOCKED | NOT_PROVEN | FAIL`.
- **Totals are declared in the manifest and recomputed from the rows** by
  [`scripts/session5ClosureGates.test.ts`](../../../scripts/session5ClosureGates.test.ts), which
  runs in CI.
- **The verdict is derived, not chosen.** The test recomputes it from the status counts and fails
  if the declared verdict disagrees — so a preferred conclusion cannot outrun the evidence.

### Three independent reconciliations, all agreeing

| Method | Result |
| --- | --- |
| Machine count from structured `status` fields | PASS 33 · BLOCKED 7 · NOT_PROVEN 2 · FAIL 0 → **42** |
| Direct table-row count | **42** |
| Count of unique Gate IDs | **42** |
| Declared `totals.TOTAL` | **42** |

### The test is proven able to fail

Eight deliberate regressions, each applied as a temporary patch, run, then restored:

| Mutation | Result |
| --- | --- |
| Declared PASS count off by one | RED → restored GREEN ✅ |
| Declared TOTAL off by one | RED → restored GREEN ✅ |
| Duplicate gate ID | RED → restored GREEN ✅ |
| Status outside the allowed vocabulary | RED → restored GREEN ✅ |
| Empty `evidence_reference` | RED → restored GREEN ✅ |
| BLOCKED gate with no stated dependency | RED → restored GREEN ✅ |
| **Verdict forced to `COMPLETE` while blockers remain** | RED → restored GREEN ✅ |
| **A real FAIL hidden behind a passing verdict** | RED → restored GREEN ✅ |

Manifest SHA-256 `a12e0560844e3523c5d0cb28a88567fc56367c6f6a9a388ed9d23e04cd6e2b59` before and
after — byte-identical. Repository residue: **0**.

The last two mutations are the ones that matter beyond bookkeeping. They make it mechanically
impossible to publish a clean verdict over an unclean matrix.

---

## 4. Gates closed by owner action since PR #475

Not a correction — real movement, on real evidence.

| Gate | Requirement | Evidence |
| --- | --- | --- |
| **G-013** | Authenticated human access before enforcement | `2026-08-10T05:45:40Z`, deployment `1967c511`: owner-gated `analytics.overview` / `metrics.getSessionMetrics` / `getMemberMetrics` / `getDurationHistogram` / `appUsers.me` → **200**, returning live data (`dau=8 wau=42 mau=60`). `ip=47.152.167.182 ipSrc=cf-connecting-ip`, XFF carrying only CF PoP + Railway edge. |
| **G-019** | Obsolete `EDGE_AGENT_BYPASS_KEY` removed from the app service | Absent from production `variableNames` on deployment `b8261dc7`. Cloudflare and GitHub Actions copies intentionally preserved. A real Android user was served normally throughout the change. |
| **G-017** | Safe dual-secret rotation posture configured | `EDGE_ORIGIN_SECRET_PREV` present on `b8261dc7`; primary continuity proven by `edgeVerified=true` at `06:10:25Z`. |

### One deliberate scope limit on G-017

`edgeVerified=true` proves the **primary** secret still authenticates. It does **not** prove
`EDGE_ORIGIN_SECRET_PREV` holds the correct value, and nothing can prove that yet — by design,
`PREV` is redundant while the primary matches, so a typo in it is invisible until an actual
rotation makes it load-bearing (rotation runbook Step 2).

That distinction is carried as its own gate, **G-042**, at `NOT_PROVEN`, so configuration
readiness is never mistaken for a completed rotation. The owner's statement that `PREV` was
populated from the current value is recorded as **owner-attested**, which is an honest evidence
class, not a proof.

---

## 5. Current reconciled state

```
PASS 33 · BLOCKED 7 · NOT_PROVEN 2 · FAIL 0 · TOTAL 42
VERDICT: COMPLETE WITH EXPLICIT EXTERNAL BLOCKER   (derived, not chosen)
```

**7 BLOCKED** — all on Railway authority this agent does not hold: G-020 qualifying soak,
G-021 `EDGE_MODE=on`, G-022/023/024 human/agent/pipeline access under enforcement, G-025
direct-origin denial, G-027 partial-bypass detector live executability.

**2 NOT_PROVEN** — neither a defect nor a permissions wall:
- **G-041** — #471's first live caller is scheduled for `2026-08-10T13:00:00Z` and has not yet
  occurred. Both digest schedulers are confirmed registered on the live deployment, which is the
  positive discriminator separating "not yet due" from "broken."
- **G-042** — `PREV` under an actual rotation, as above.

---

## 6. What this record does not claim

It does not claim the earlier records were substantively wrong. Every gate row in them was
correct; the sums beneath them were not. It does not change the verdict, because the verdict was
never a function of the total. And it does not claim the new figures are correct merely because
a test passes — the test itself was shown to fail against eight distinct defects before its
passing result was accepted as evidence.
