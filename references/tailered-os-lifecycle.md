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
| Merged | Merged | `deploy_consequence_recorded` | `deploy_decision` (deploy/no-deploy), `consequence_ref`, `observed_via` | **human** |
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

- **fixture**: `node scripts/tailered-os/lifecycle.mjs {fold|plan|apply} --fixture
  <path> [--task <id>]` over `{ task_id, events: [...] }`. The mutation plan always
  carries `executed: false, reason: "fixture mode — no live authority"`. The CLI is
  fixture-only permanently (`cli-live-unsupported`): it holds no transport, so it can
  never bypass the writer's gates.
- **live — NOT ACTIVE.** The committed manifest ships with
  `safety.notionWriteOperationsAuthorized: false`, so **no live write capability exists
  today**. Three independent verification rounds (2026-08-11) each returned FAIL against
  this writer, so the owner's conditional Gate-B approval of actor AI-10 has **not
  vested**. The code below is what a future, separately reviewed activation PR would
  arm — after closing the open items in "What is still unsound", which that PR must
  treat as its entry bar. The ONLY sanctioned write path is the
  policy-separated writer, `scripts/tailered-os/lifecycle-writer.mjs`. Contract:
  **observed fact → event schema → pure kernel → mutation plan (`deriveWrites`) →
  policy/authority validation (`authorizeWrite`, ~30 distinct refusal points) → injected
  transport write → reread → compare → attestation (`executeMutation`)**. The writer
  executes prevalidated plans only; it never invents transitions, never reinterprets
  evidence, never expands its own scope.
  - **Allowlist** (`WRITE_ALLOWLIST`, frozen): four properties — Execution State
    (closed vocabulary), Work Link (https URL), Proof / Result (https URL),
    Why It's Blocked (text) — on Tasks in data source
    `06a44772-1ae8-4d9d-be70-30741b334b85` whose Scope ID is `TOS-*` and that belong
    to the canonical Tailered OS project. Anything else refuses (`permission_denial`).
  - **Authority comes from disk, not from the caller**: `authorizeWrite` loads and
    validates the control-plane manifest itself on **every** write, so the kill switch
    is a real switch. `safety.notionWriteOperationsAuthorized` must be `true` AND carry
    the owner grant `safety.notionWriteAuthorization` (decision URL, grantedBy PREZ,
    actor AI-10) — the loader refuses a bare `true` as a self-grant, and refuses a
    dormant grant while the flag is `false`. A `manifest_path` override must resolve
    (after following symlinks) inside `config/` or `scripts/tailered-os/fixtures/`.
    Residual, stated plainly: in-repo is not the same as committed — an attacker with
    repository write access could place a file there, though they could equally edit the
    canonical manifest, so this grants no new capability. The manifest that authorized a
    write is recorded in its attestation (`authority_source`).
    Registry actor: AI-10, approved by PREZ 2026-08-11 conditional on qualification.
  - **Capabilities are unforgeable, single-use, and time-bounded**: the object
    `authorizeWrite` returns is registered in a module-private `WeakMap`;
    `executeMutation` refuses anything not in it, refuses a second execution of the same
    capability, refuses one older than `CAPABILITY_TTL_MS`, and **re-reads authority from
    disk** before writing — so engaging the kill switch stops writes already in flight,
    not merely new authorizations. Object shape is not authenticity: a JSON round-trip of
    a real capability is refused.
  - **Copy, then validate, then send the copy**: the whole plan — `task_id`, `trigger`,
    `authority`, `actor` and the write map — is read from caller memory exactly once into
    a frozen snapshot, and every gate, the capability and the payload read only that
    snapshot. A getter cannot pass the scope gates for one page and land the write on
    another. Symbol-keyed writes are refused outright.
  - **The transition table decides the target state**: a plan's
    `writes["Execution State"]` must equal the matched row's `to`. Proving that
    `(trigger, from)` existed said nothing about what was written, which let a plain
    machine `work_started` plan write `Merged` (NEW2-OG6-0014). Annotation rows may not
    change state at all.
  - **`write_reverified` is not a general write primitive**: it carries a live write
    only as an undo bound to a capability this writer authorized, restoring exactly that
    capability's captured priors. Undoing a human-authority write itself requires an
    observed human act. (Round 3 showed the *effect* was still reachable by feeding a
    self-inconsistent snapshot; that specific route is now closed by the
    snapshot-consistency gate, but see "What is still unsound".)
  - **No optimistic success**: reread mismatch ⇒ `applied: "partial"` ⇒ the kernel
    freezes the task (`mutation_result` applied=partial) until a human-visible
    `write_reverified`. A write whose outcome is unreadable is partial, never assumed.
  - **Kill switch / rollback**: the committed manifest is already `false`. Were it
    armed, setting it back (owner-reviewed PR) makes `authorizeWrite` refuse every plan
    on the canonical path (fresh manifest read per write) and `executeMutation` refuse
    outstanding capabilities minted against that path on its own re-read — but see
    "What is still unsound" #2 for the per-path gap. The
    engine's `assertLiveNotionAuthority` throws `notion-write-unauthorized`, and all
    ledger history is preserved append-only. (The writer itself persists nothing; it
    RETURNS attestations for the caller to record.)

## What stays human, permanently

Review approval, the merge itself, the unblock decision, and the deploy decision are all
`authority: "human"` ROWS requiring `observed_via`, enforced by the kernel and re-checked
by the writer, and `nextAction()` labels those stages `authority: "human"`.

**Read this before trusting that sentence.** `actor: "human"` and `observed_via` are
strings the CALLER supplies. Nothing in the kernel or the writer authenticates them: a
machine caller can assert `actor: "human"` with a fabricated `observed_via` and the
transition is accepted (independent verification round 3, NEW3-OG6-0024). The controls
are therefore honest about *shape* — a human row cannot be taken with a machine label —
but they do **not** prove a human acted. Making that claim true requires binding the
transition to something a machine cannot mint: for `approval_observed` and
`merge_observed`, fetching the review/merge from the GitHub API inside the writer and
matching reviewer identity and commit, rather than trusting evidence fields. That work
is an entry-bar item for any activation PR.

`post_merge_verified` (→ `Verified`) is machine authority by design: it requires an https
`evidence_ref`, but that URL is **not fetched**, so `Verified` rests on a machine-supplied
link. Stated rather than implied.

## What is still unsound (entry bar for any activation PR)

Recorded from three independent verification rounds so a future session starts from the
truth rather than from this document's optimism:

1. **Human authority is asserted, not proven** (NEW3-OG6-0024, HIGH). See above.
2. **The kill switch is per-path** (NEW3-OG6-0027): `executeMutation` re-reads the manifest
   the capability was minted against. A capability minted via `manifest_path` against an
   armed in-repo file still executes while the canonical manifest is disarmed. Activation
   must pin execute-time authority to the canonical manifest and remove the
   `manifest_path` test seam (the armed fixture under
   `scripts/tailered-os/fixtures/` exists only so vitest can exercise the armed path).
3. **Test seam = authority source.** While `manifest_path` exists, any in-repo manifest
   under `config/` or `scripts/tailered-os/fixtures/` can grant authority to a caller that
   explicitly names it.
4. **Six mutants survived** the round-3 mutation check — the execute-time authority
   re-read, the TTL, the realpath rule, `target.page_id` derivation, the undo capability
   binding, and the human `deploy_consequence_recorded` row all lack a test that fails
   when the fix is deleted.
5. **`Verified` is reachable on an unfetched URL** (see above).

## Determinism / replay

`foldLifecycle(events)` is a pure fold: no wall clock, no randomness; `record.at` comes
from the event. Replaying a log reconstructs the identical state; `verifyReplay` turns
any mismatch into a visible `replay_divergence`. Duplicate `event_key`s are no-ops with
no second record.

Tests: `scripts/tailered-os/lifecycle.test.ts` (21-test §36/§37 battery — every failure
class proven to fire) + `scripts/tailered-os/lifecycle-writer.test.ts` (OG-006
writer battery, 51 tests as of this revision — every pre-write gate, transport failure class, partial-write freeze,
and authority spoof proven to refuse, plus twelve regressions from two independent
adversarial rounds: deep-frozen capability, trust-boundary re-validation, own-property
allowlist lookup, on-disk authority, unforgeable capabilities, single-read write maps,
undo binding, cycle-safe freezing, symbol rejection, empty-select restoration, and a
freshness bound the caller cannot widen).
