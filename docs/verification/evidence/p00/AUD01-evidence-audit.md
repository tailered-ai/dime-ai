# P00.AUD01 — evidence audit: every answer carries a command and preserved output

Audited at HEAD `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6` on branch `feat/ci-verify-control-plane`.

| Unit | Exact command / source inspected | Raw output preserved | Interpretation | Inference-free |
| --- | --- | --- | --- | --- |
| P00.T01 | 3 `gh api` probes (rulesets, rule types, GraphQL mergeQueue) | `raw/T01-merge-queue.raw.txt` | `T01-merge-queue.md` | YES |
| P00.T02 | 7 `gh api` probes (classic, ruleset, org-inclusive rules, permissions, branch) | `raw/T02-required-contexts.raw.txt` | `T02-required-contexts.md` | YES |
| P00.T03 | `check-patch-coverage.mjs:42-53`; `07-coverage-patch.yml:37-46` | `raw/T03-coverage-scope.raw.txt` | `T03-coverage-scope.md` | YES |
| P00.T04 | js-yaml 4.3.1 parse of all 40 workflows | `raw/T04-census.raw.txt` + `raw/T04-census-script.mjs` | `T04-construct-census.md` | YES |
| P00.T05 | `check-github-actions-security.mjs:50-64,241-253,264-276,332-341`; grep of invocation surfaces | `raw/T05-actions-security-scope.raw.txt` | `T05-actions-security-scope.md` | YES |

## Negative findings were REPRODUCED, never asserted
The two absence claims are the least reliable finding class, so each was
confirmed from independent endpoints before being recorded:

| Absence claimed | Independent confirmations |
| --- | --- |
| Merge queue not enabled | (a) no `merge_queue` rule type in ruleset 18701573; (b) 0 textual occurrences of `merge_queue` in the full ruleset payload; (c) GraphQL `mergeQueue` returns `null` |
| Classic branch protection absent | (a) `branches/main/protection` 404; (b) `required_status_checks` 404; (c) token has `admin=true`, so 404 is not a permissions artifact; (d) `branches/main.protected=true` proves the ruleset is the only surface; (e) `rules/branches/main` returns only ruleset-18701573 rules; (f) `rulesets?includes_parents=true` shows no org-level ruleset |

## Corrections made during this phase
- Earlier prose in this session stated "39 workflows". The parsed count is
  **40** (`ls -1 .github/workflows/ | wc -l` = 40). The census figure governs.

## Result
5 of 5 units carry an exact command, preserved raw output, a written
interpretation, and a SHA-256 recorded in the ledger. Zero answers rest on
inference.
