# TOS-009 — Task execution lifecycle engine

`scripts/tailered-os/lifecycle.mjs` — a pure, event-driven state machine that moves a
canonical Notion Task's **Execution State** through the engineering lifecycle from
**observed external facts**, and emits the Notion mutation it implies as **data**. It
automates bookkeeping, never judgment: approval, merge, unblock, and the deploy decision
are human acts the engine may only *record from evidence*.

Built in Campaign Four (ONE-20260810-C4) under directive §35–§37, which resolved the
TOS-009 deferral (OG-006 class): **build, don't gate**.

## State vocabulary

The nine Execution State options of the canonical Tasks database
(`config/tailered-os-control-plane.v1.json` → `notion.databases.tasks`,
data source `06a44772-1ae8-4d9d-be70-30741b334b85`):

`Ready → Executing → PR Open → CI → Review → Approval → Merged → Verified`, plus
`Blocked` (reachable from any state; returns to the recorded `blocked_from`).

## Transition table (authority column is the law)

| From | To | Trigger event | Required evidence | Authority |
| --- | --- | --- | --- | --- |
| Ready | Executing | `work_started` | `packet_ref`, `work_link` (URL) | machine |
| Executing | PR Open | `pr_opened` | `pr_number`, `head_sha` (40-hex) | machine |
| PR Open / CI | CI | `checks_observed` | `head_sha` (must match PR head), `check_rollup` | machine |
| CI | Review | `review_requested` | `review_ref` + recorded green rollup | machine |
| Review | Approval | `approval_observed` | `reviewer`, `review_id`, `review_state=APPROVED`, `observed_via` | **human** |
| Approval | Merged | `merge_observed` | `merge_sha` (40-hex), `observed_via` | **human** |
| Merged | Merged | `deploy_consequence_recorded` | `deploy_decision` (deploy/no-deploy), `consequence_ref` | machine |
| Merged | Verified | `post_merge_verified` | `evidence_ref` (consequence must be recorded first) | machine |
| Verified | Verified | `learning_captured` | `learning_ref` | machine |
| any | Blocked | `failure_observed` | `failure_class`, `detail_ref` | machine |
| Blocked | (blocked_from) | `unblocked` | `resolution_ref`, `observed_via` | **human** |
| any | (same) | `mutation_result` | `plan_ref`, `applied` (full/partial) | machine |
| any | (same) | `write_reverified` | `verification_ref` | machine |

A `checks_observed` with rollup `failure` routes to **Blocked** with `ci_failure` recorded
— visible state, never silent continuation. `authority_failure` events (permission denial,
API timeout, expired credentials) are fail-closed refusals: no transition is ever inferred
from them, or from the passage of time.

## §37 failure classes

`duplicate_event` (idempotent no-op, surfaced not silent) · `event_reorder` (names the
expected from-state) · `replay_divergence` (`verifyReplay`) · `missing_relation` (Work
Link) · `missing_evidence` · `stale_task` (generation pin mismatch — re-read before
acting) · `missing_pr` · `stale_sha` (observation for a superseded head) · `ci_failure` ·
`authority_violation` (machine actor on a human transition) · `permission_denial` ·
`api_timeout` · `partial_write` (freezes ALL transitions until `write_reverified`) ·
`malformed_input` · `expired_credentials`.

## Modes

- **fixture** (the only executable mode today): `node scripts/tailered-os/lifecycle.mjs
  {fold|plan|apply} --fixture <path> [--task <id>]` over `{ task_id, events: [...] }`.
  The mutation plan always carries `executed: false, reason: "fixture mode — no live
  authority"`.
- **api**: fails CLOSED (`notion-write-unauthorized`) while
  `safety.notionWriteOperationsAuthorized` is `false` in the control-plane manifest —
  and even an authorized manifest hits `api-write-unimplemented` until the live writer
  is built and tested under a separate owner-gated activation by PREZ. The engine
  mutating the control plane that governs its own approval state is exactly the loop
  the fail-closed default exists to prevent.

## What stays human, permanently

Review approval, the merge itself, the unblock decision, and the deploy decision. The
engine records these from observed evidence (`observed_via` is required); it can neither
perform nor infer them, and `nextAction()` labels those stages `authority: "human"`.

## Determinism / replay

`foldLifecycle(events)` is a pure fold: no wall clock, no randomness; `record.at` comes
from the event. Replaying a log reconstructs the identical state; `verifyReplay` turns
any mismatch into a visible `replay_divergence`. Duplicate `event_key`s are no-ops with
no second record.

Tests: `scripts/tailered-os/lifecycle.test.ts` (21-test §36/§37 battery — every failure
class proven to fire).
