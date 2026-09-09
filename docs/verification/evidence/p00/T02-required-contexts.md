# P00.T02 — which required status contexts are enforced TODAY vs still graduating?

Branch `feat/ci-verify-control-plane`, HEAD `4d644cf47d2ee8a1528e1efd8a79da5ce658d8c6`. Raw output:
`raw/T02-required-contexts.raw.txt`.

## Commands
```
gh api repos/tailered-ai/dime-ai/branches/main/protection             # classic
gh api repos/tailered-ai/dime-ai/branches/main/protection/required_status_checks
gh api repos/tailered-ai/dime-ai/rulesets/18701573
gh api repos/tailered-ai/dime-ai/rules/branches/main                  # org-inclusive
gh api 'repos/tailered-ai/dime-ai/rulesets?includes_parents=true'
gh api repos/tailered-ai/dime-ai --jq '.permissions'
gh api repos/tailered-ai/dime-ai/branches/main --jq '.protected'
```

## FINDING 1 — classic branch protection is ABSENT (reproduced three ways)
| Probe | Result |
| --- | --- |
| `branches/main/protection` | **404 "Branch not protected"** |
| `branches/main/protection/required_status_checks` | **404 "Branch not protected"** |
| Token permissions | `admin=true, maintain=true, push=true` -> the 404 is **NOT** a permissions artifact |
| `branches/main.protected` | `true` — main IS protected, by the ruleset |
| `rules/branches/main` (includes org-level) | 4 rules, **all** from ruleset 18701573 |
| `rulesets?includes_parents=true` | only 18701573; **no org-level ruleset** |

**`main` is guarded by exactly ONE surface: repository ruleset 18701573.**
The dual-surface (ruleset + classic) geometry described in
`docs/verification/RULESETS.md` no longer exists.

## FINDING 2 — enforced contexts today: 9 (strict), all pinned to integration_id 15368
1. Security Audit
2. TypeScript Check
3. Vitest
4. Secret Scan (gitleaks)
5. 01-pr-proof-contract
6. 05-workflow-security
7. 06-dependency-review
8. 08-contract-and-data-integrity
9. 10-ai-eval-critical

`strict_required_status_checks_policy: true` (branch must be current).
`bypass_actors: []`, `current_user_can_bypass: "never"`.

## FINDING 3 — still graduating: 5 of the 14-context end state
`02-codeql`, `03-semgrep-blocking`, `07-coverage-patch`,
`09-artifact-build-and-smoke`, `11-artifact-attestation`.

## FINDING 4 — the `pull_request` rule is weaker than RULESETS.md documents
| Parameter | Live value | RULESETS.md asserts |
| --- | --- | --- |
| `required_approving_review_count` | **0** | 1 approval |
| `require_code_owner_review` | **false** | code-owner review required |
| `require_last_push_approval` | **false** | last-push approval required |
| `dismiss_stale_reviews_on_push` | **false** | stale-approval dismissal |
| `required_review_thread_resolution` | **false** | conversation resolution |
| `allowed_merge_methods` | merge, squash, rebase | (not documented) |

NOT characterised as a vulnerability. A 0-approval policy is plausibly
deliberate for a solo-maintainer repository — requiring one approval would
wedge every merge. What is objectively true is that the checked-in authority
and the live configuration DISAGREE, and only the owner can say which is
correct. Tracked as **DEF-002**.

## ANSWER
9 contexts enforced today; 5 graduating; classic protection absent; the
documented approval geometry is not live.
