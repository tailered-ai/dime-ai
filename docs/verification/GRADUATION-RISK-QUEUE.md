# Graduation-risk queue

Advisory defects deliberately outside the P08–P10 critical path, tracked so
non-blocking never silently becomes forgotten. Standing rule (owner-directed,
2026-08-12): **before any affected check graduates to required, its defect
must be CLOSED and the gate's rejection capability ASSURANCE-proven.**

| Field | DEF-053 | DEF-045 | DEF-046 |
| --- | --- | --- | --- |
| Current severity | HIGH (non-attributed) | LOW | LOW |
| What it is | TWO ERROR-severity Semgrep rules (`parseFloat(… $C …)`, `import … from "$PATH"`) fail to PARSE; directory-config drops them and `03-semgrep#blocking` exits 0 anyway | `dime-llm-validation#validate` red on origin/main itself — 6 governed-eval failures, byte-identical locally | Nightly tier red: `full-osv` + `full-container-scan` reproduce exactly locally |
| Why non-blocking today | `03-semgrep#blocking` is **graduating**, not required; the gate's ability to reject is independently PROVEN via a parsing ERROR rule (ASSURANCE fixture) | Not one of the 9 required contexts; workflow is path-scoped to `ml/**`; the ML lane is owner-DORMANT (2026-08-04) | AUDIT tier — not a merge-contract context; dependency/base-image debt |
| What would make it blocking | `03-semgrep#blocking` added to the required contexts (ruleset 18701573) — a security rule that cannot execute in a required gate is a silent hole | ml/ lane reactivation, or the context being added to required checks | The nightly tier being promoted into the merge contract, or a policy change gating releases on it |
| Owner | repo owner (rule content is candidate source outside ci-verify authority) | ML lane owner (dormant) | repo owner (dependency/base-image refresh) |
| Target phase/date | before semgrep graduation — fix is DESIGNED AND SANDBOX-PROVEN (3 findings vs three-branch fixture, 0 FP vs clean), a small `.semgrep/` PR | on ml/ reactivation | routine dependency maintenance; re-measure each P10 certificate |
| Required remediation | apply the proven rule rewrites; add an ASSURANCE cycle per repaired rule; re-run `03-semgrep#blocking` control/poison | fix the 6 governed evals or re-baseline them under owner authority | bump vulnerable images/deps until `full-osv`/`full-container-scan` green |

## Ratchet-baselined findings (same law: recorded, never hidden)

| Field | DEF-064 |
| --- | --- |
| Current severity | LOW |
| What it is | `.state-pill--pass` on the landing page fails WCAG AA color contrast (serious, 1 node) — found by the P09 a11y gate's first run against the BUILT client |
| Why non-blocking today | baselined under the documented ratchet (`scripts/ci/p09/a11y-baseline.json`); any NEW violation still reds the gate |
| What would make it blocking | the baseline entry being removed without the fix, or an a11y policy change requiring zero baselined findings |
| Owner | UI work under brand law (`design-system/dime-ai/MASTER.md` — one-accent mint, contrast fixes must not violate THREE-COLOR-LAW) |
| Target phase/date | next UI-loop touching the landing page |
| Required remediation | raise the pill's contrast to ≥4.5:1, delete the baseline entry, re-run the a11y control |

## Enforcement hook

`P10`'s certificate run must re-read this queue: if any listed check has become
**required** while its defect is still OPEN, the certificate is refused with
the defect ID. That converts this document from a note into a gate input.
