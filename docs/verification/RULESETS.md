# Control plane — rulesets, merge queue, CODEOWNERS

## Current live state — measured 2026-08-10 (DEC-003 / DEF-002)

**Ruleset `main-protection` (id 18701573, active) is the SOLE authoritative
enforcement surface on `main`. Classic branch protection is ABSENT. The merge
queue is NOT enabled.**

Measured with an `admin: true` token; every negative was reproduced from
independent endpoints before being recorded. Raw output and interpretation:
`docs/verification/evidence/p00/T02-required-contexts.md`,
`.../T01-merge-queue.md`, and the `raw/` transcripts beside them.

| Property | Live value | Probe |
| --- | --- | --- |
| Ruleset 18701573 | `active`, rules `deletion`, `non_fast_forward`, `pull_request`, `required_status_checks` | `gh api repos/tailered-ai/dime-ai/rulesets/18701573` |
| Classic branch protection | **ABSENT** — HTTP 404 "Branch not protected" | `gh api .../branches/main/protection` |
| Is the 404 a permissions artifact? | **No** — token reports `admin=true` | `gh api repos/tailered-ai/dime-ai --jq .permissions` |
| Is `main` protected at all? | Yes — `branches/main.protected = true`, by the ruleset | `gh api .../branches/main` |
| Org-level rulesets | **NONE** | `gh api '.../rulesets?includes_parents=true'` and `.../rules/branches/main` |
| Merge queue | **NOT enabled** — `mergeQueue` is `null`, no `merge_queue` rule | GraphQL `repository.mergeQueue(branch:"main")` |
| Strict policy | `strict_required_status_checks_policy: true` | ruleset payload |
| Bypass actors | `[]`, `current_user_can_bypass: "never"` | ruleset payload |

### Required status checks ENFORCED TODAY — 9, each pinned to `integration_id: 15368`

```
Security Audit
TypeScript Check
Vitest
Secret Scan (gitleaks)
01-pr-proof-contract
05-workflow-security
06-dependency-review
08-contract-and-data-integrity
10-ai-eval-critical
```

### Still GRADUATING — 5 of the 14-context end state

```
02-codeql
03-semgrep-blocking
07-coverage-patch
09-artifact-build-and-smoke
11-artifact-attestation
```

### `pull_request` rule — live parameters

| Parameter | Live value |
| --- | --- |
| `required_approving_review_count` | **0** |
| `require_code_owner_review` | false |
| `require_last_push_approval` | false |
| `dismiss_stale_reviews_on_push` | false |
| `required_review_thread_resolution` | false |
| `allowed_merge_methods` | merge, squash, rebase |

This is recorded as measurement, not as a finding of vulnerability. A
0-approval policy is consistent with single-maintainer operation — requiring an
approval that cannot exist would wedge every merge. The ruleset remains strict,
blocks force-push and deletion, and has no bypass actors.

> **SUPERSEDED — the block below described the state as of 2026-08-05 and is
> retained as history, not as current fact.** It asserted a dual-surface
> geometry (ruleset + classic protection) with four contexts, one approval,
> code-owner review, last-push approval, stale-approval dismissal, conversation
> resolution, and `enforce_admins`. None of that is live as of 2026-08-10: the
> classic surface is gone and the ruleset now carries nine contexts. The
> divergence was found by P00.T02 of the `ci:verify` control plane and tracked
> as DEF-002; DEC-003 resolved it as **DOCUMENT_LIVE_STATE** — this document was
> corrected to match reality, and **no repository protection was created,
> restored, or altered.**

### Historical record — 2026-08-05 (superseded, retained for audit)

> **DRIFT FOUND AND CLOSED 2026-08-05.** `main` is guarded by *two independent*
> mechanisms, and they had drifted apart: **`Secret Scan (gitleaks)` was
> required by classic protection but ABSENT from ruleset 18701573**, so secret
> scanning gated merges through only one of the two surfaces. If classic
> protection were ever relaxed — as it legitimately was during the 2026-08-05
> manus-purge break-glass — secret scanning would have silently stopped
> gating. Earlier revisions of this document asserted four ruleset contexts;
> that was aspirational, not measured.
>
> Both surfaces now carry the same four contexts, and **every one is pinned to
> `integration_id: 15368` (GitHub Actions)**. The three pre-existing entries
> were unpinned, which meant a same-named check from any other app could have
> satisfied them; all four were verified to genuinely originate from the
> Actions app before pinning. `scripts/graduate-ruleset.mjs` prints the
> ruleset-vs-classic comparison on every run so this cannot go quiet again.
>
> | Context | Ruleset 18701573 | Classic protection |
> | --- | --- | --- |
> | Security Audit | ✅ pinned | ✅ |
> | TypeScript Check | ✅ pinned | ✅ |
> | Vitest | ✅ pinned | ✅ |
> | Secret Scan (gitleaks) | ✅ pinned | ✅ |

## Graduating checks — use the script, not hand-edited JSON

`node scripts/graduate-ruleset.mjs --wave=<1|2|3> [--apply] [--force]`

Dry-run by default. Before writing anything it proves, against live GitHub
data, that (1) the wave's observation window from ROLLOUT.md has elapsed,
(2) every context it is about to require actually **reported** on a recent
merged PR — requiring a context that never reports wedges every merge on
"Expected — waiting for status" — and (3) each of those reports was green.
`--force` overrides only the calendar, never the reported-and-green proof.

## Target configuration

Apply after the graduation milestones in ROLLOUT.md (adding a required check
that doesn't exist yet blocks all merges — sequence matters).

### Required status checks (end state)

```
Security Audit                     (existing, ci.yml)
TypeScript Check                   (existing, ci.yml)
Vitest                             (existing, ci.yml)
Secret Scan (gitleaks)             (existing)
01-pr-proof-contract
02-codeql
03-semgrep-blocking
05-workflow-security
06-dependency-review
07-coverage-patch                  (after calibration window)
08-contract-and-data-integrity
09-artifact-build-and-smoke
10-ai-eval-critical                (AI_SURFACE=true)
11-artifact-attestation
```

Advisory (never in the required list until graduated per ROLLOUT.md):
`03-semgrep-advisory`, `ai-review`, `mutation-diff`, `fuzz-diff`,
`openssf-scorecard`, `format-check`.

### gh api — add required checks to the existing ruleset

```bash
# Read current ruleset, edit required_status_checks in place:
gh api repos/tailered-ai/dime-ai/rulesets/18701573 > ruleset.json
# (edit: append the new contexts to rules[type=required_status_checks].parameters.required_status_checks
#  with integration_id pinned to GitHub Actions app id 15368 — binds check identity
#  to the Actions app so a same-named check from another app can't satisfy it)
gh api -X PUT repos/tailered-ai/dime-ai/rulesets/18701573 --input ruleset.json
```

Classic protection mirror — **NOT APPLICABLE as of 2026-08-10.** Classic branch
protection is absent (404 with an `admin` token), so there is no second surface
to mirror. The command below is retained only for the case where an owner
decision later restores that surface; running it today would *create* classic
protection, which is a protection change and must be an explicit owner action:

```bash
gh api -X PATCH repos/tailered-ai/dime-ai/branches/main/protection/required_status_checks \
  -f strict=true \
  $(printf -- '-f contexts[]=%q ' "Security Audit" "TypeScript Check" "Vitest" "Secret Scan (gitleaks)" \
    01-pr-proof-contract 02-codeql 03-semgrep-blocking 05-workflow-security 06-dependency-review \
    08-contract-and-data-integrity 09-artifact-build-and-smoke 10-ai-eval-critical 11-artifact-attestation)
```

### Merge queue — NOT enabled (measured 2026-08-10)

`repository.mergeQueue(branch:"main")` returns `null` and ruleset 18701573
carries no `merge_queue` rule. **The `merge_group:` triggers declared by 10
workflows are therefore inert — they cannot fire in the current
configuration.** The combined branch+base state is verified only by the
`pull_request` event, which checks out `refs/pull/N/merge`.

Enabling it remains an open owner option (Settings → Rules → ruleset →
"Require merge queue", or a `merge_queue` rule via `gh api`). It would
eliminate the stale-branch races observed on 2026-08-05 (PR #359 went stale
twice under strict checks while #357/#358 merged), which is why every required
workflow already declares `merge_group`. Recommended params for a solo repo:
`grouping_strategy: ALLGREEN`, `max_entries_to_build: 2`, merge method: merge.

### Signed commits

Not currently enforced. Decision for the owner: most commits are agent-authored
via CLI without signing set up; enabling `required_signatures` today would
block the primary workflow. Recorded as **deferred owner decision** — enable
after configuring commit signing for the working machine(s).

### Two approvals on sensitive paths / break-glass

Single-maintainer reality: a second human approval cannot exist. Compensating
controls: `enforce_admins` stays ON for normal operation; the break-glass path
is the documented, memory-recorded protection-lowering procedure used for the
2026-08-05 manus purge (lower → act → restore, each step logged in the ops
record). CODEOWNERS keeps review-policy and workflow files owner-only so an AI
reviewer or contributor cannot alter its own instructions silently.

### Secret Protection

GitHub push protection is an org/repo setting (Settings → Code security →
Secret Protection → Push protection: enable). Gitleaks remains the in-CI layer
either way. Status: to confirm in UI — cannot be set via current `gh api` PAT
scope; open item in ROLLOUT.md.

## CODEOWNERS

`.github/CODEOWNERS` extended (this PR) to cover: `/` default, `.github/`,
migrations (`/drizzle/`), auth/billing (`/server/stripe/`, auth/session files),
AI surface (prompts, model config, agent runtimes, `ml/dime-1.0/`,
`shared/dime/`), and the AI-review + verification-policy files themselves
(`.coderabbit.yaml`, `.semgrep/`, `docs/verification/`) — reviewers read
instructions from the PR head, so the instruction files must be owner-gated.

## Org policy note

Full-SHA action pinning is already repo-law, enforced per-PR by
`scripts/check-github-actions-security.mjs` (0 non-SHA refs across 135 uses
at audit time) and now additionally by zizmor (05). Org-level: adopt the same
requirement in any future repo; this repo is the reference implementation.
