# P00.T01 — is the merge queue ENABLED, or are the `merge_group:` triggers inert?

Branch `feat/ci-verify-control-plane`, HEAD `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6`. Raw output:
`raw/T01-merge-queue.raw.txt`.

## Commands
```
gh api repos/tailered-ai/dime-ai/rulesets
gh api repos/tailered-ai/dime-ai/rulesets/18701573 --jq '.rules[].type'
gh api graphql -f query='{ repository(owner:"tailered-ai",name:"dime-ai"){ mergeQueue(branch:"main"){ id configuration { mergeMethod mergingStrategy } } } }'
```

## Observed
| Probe | Result |
| --- | --- |
| Rule types in ruleset 18701573 | `deletion`, `non_fast_forward`, `pull_request`, `required_status_checks` |
| Any `merge_queue` rule | **NO** — 0 occurrences across the full ruleset payload |
| GraphQL `repository.mergeQueue(branch:"main")` | **`null`** |
| Workflows carrying a `merge_group:` trigger | 10 (per the P00.T04 census) |

## ANSWER
**The merge queue is NOT enabled on `main`.** GitHub returns `mergeQueue: null`
for the branch and no ruleset carries a `merge_queue` rule.

The `merge_group:` triggers present on 10 workflows are therefore **INERT** —
they can never fire in the current configuration.

## Consequence for the blueprint
1. The combined branch+base state is verified by GitHub **only** through the
   `pull_request` event's `refs/pull/N/merge` checkout. There is no second,
   post-queue verification of the merge result.
2. That makes P01's prospective-merge materialization MORE load-bearing, not
   less: it is the only local analogue of the single combined-state check.
3. P10.T05 reconciliation must not assume a merge-queue run exists.
