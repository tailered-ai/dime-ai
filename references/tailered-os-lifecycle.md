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
    actor AI-10, and the `activationPullRequest` whose reviewed merge introduced it) —
    the loader refuses a bare `true` as a self-grant, and refuses a dormant grant while
    the flag is `false`. There is no caller-selectable manifest path. The manifest that
    authorized a write is recorded in its attestation (`authority_source`).
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

**That sentence used to be false at the layer claiming to enforce it.** Through Round 1,
`actor: "human"` and `observed_via` were strings the CALLER supplied; nothing
authenticated them, so a machine caller asserted them and the transition was accepted
(independent verification round 3, NEW3-OG6-0024). That is what stopped the first
campaign and why the writer shipped inert.

**Round 2 inverted the direction of trust.** The caller may now name an evidence
*locator* — which PR, which review id, which comment. `scripts/tailered-os/authority.mjs`
independently fetches that object from GitHub over an authenticated transport and
DERIVES the authority fact; the plan's evidence must then AGREE with what the forge
returned, and cannot supply it. For `approval_observed` the adapter proves: repository,
PR identity, base branch, that the named review exists on that PR, that its state is
`APPROVED` (a dismissed review refuses), that the reviewer login is an allowed human —
not a bot, not this agent's own account — that the approval is of the CURRENT reviewable
head, that branch protection itself still reports `APPROVED`, and that the reviewer is
not the author.

**Why this is not another string check.** GitHub attributes a review to the credential
that submitted it. This agent holds exactly one credential, `tailered-ai`, which is also
the account that authors these PRs; `prez-tailered-ai` is a separate account it has no
token for. An `APPROVED` review by that login is an artifact this process cannot
manufacture regardless of what it passes to the adapter. The security rests on account
separation, not on code in this repository.

**Notion is deliberately NOT an authority source.** Actor AI-10 holds a Notion connector
that can create and edit pages in the Decisions database — the Round 1 "owner decision"
record was itself created by the machine, transcribing a decision made in conversation.
Deriving authority from a record the machine can write is a self-grant with extra steps.
A human decision that lives only in Notion is therefore not machine-authenticable here
and fails closed; the Notion decision URL remains in the grant as the human-readable
cross-reference it always was.

Human authority is also bound to its **subject**, not merely to a human. A fact answers
"did an allowed human do this?" — the evidence must be about the pull request this task
recorded, and an unblock comment must name the task. Round 2's first build failed this:
a genuine approval and merge of an unrelated PR drove an unrelated task to `Approval` and
then `Merged`, and a months-old comment about a CVE authorized an unblock (R2-02,
CRITICAL, independent verification).

Scope confinement is verified against **the record the transport returns**, before any
byte moves — not against the caller's snapshot. The first build checked the data source,
the `TOS-*` scope and the project against caller-supplied fields and only fetched the page
*after* writing, so the four allowlisted properties could be written to any page the
connector could reach, including the canonical Decisions database (R2-04/A9, CRITICAL).

`post_merge_verified` (→ `Verified`) is machine authority by design, but the proof is now
**fetched**: `evidence_ref` must be a GitHub run, PR or commit URL that resolves, whose
object exists, concluded successfully, and is about the expected commit. An unresolvable
or non-GitHub URL refuses rather than being taken at face value.

## The owner grant is only as good as its reviewed merge

`safety.notionWriteOperationsAuthorized: true` is JSON the machine can edit, so the grant
text is not the authority. `safety.notionWriteAuthorization.activationPullRequest` pins
the PR whose reviewed merge introduced the grant, and on **every** authorization the
adapter proves: that PR is merged; an allowed human approved it at its final head; that
human is not the author; the merge commit is an ancestor of the running tree; and the
manifest bytes at that merge commit are IDENTICAL to **the bytes this process loaded** —
and that the manifest merged by that PR actually armed authority and carries this exact
grant, naming that same PR.

Read that carefully, because the first Round-2 build got it wrong in a way that mattered:
it compared `git show HEAD:` against `git cat-file <merge>:` — two committed blobs,
neither of which is the working-tree file the loader obeys. An **uncommitted** one-line
edit therefore armed the writer while both blobs agreed it was disarmed (adversarial
finding A1, CRITICAL, independently reproduced). It also compared the blobs only to each
other, so two copies of `{}` authenticated (A2, CRITICAL).

Consequence, now actually delivered: the writer cannot be armed by editing a file, staged
or not. It can only be armed by a merge that passed branch protection and that introduced
this exact grant, and it disarms itself if the file is touched afterwards.

## Authority has no caller seam

There is no `manifest_path` option, and no transport option. `authorizeWrite` resolves the
canonical manifest from a path derived from the module's own location, so cwd cannot move
it, no environment variable is read, and a symlink has nothing to redirect. The option
surface is closed: an unknown key is a VISIBLE refusal rather than a silent ignore,
because a silently-dropped option is how a seam comes back unnoticed. Tests reach armed
and disarmed states by mocking the manifest loader module and `node:child_process` —
dependency injection strictly below the authority boundary, with no production
equivalent.

## Round 1 items, and where they stand

| Round 1 entry-bar item | Round 2 |
| --- | --- |
| 1. Bind human authority to something a machine cannot mint | `authority.mjs` derives it from an authenticated GitHub fetch; identity comes from the forge |
| 2. Pin execute-time authority to the canonical manifest, remove the `manifest_path` seam | seam deleted; `executeMutation` re-reads the canonical manifest AND requires the same grant fingerprint |
| 3. Kill the six surviving mutants | `scripts/tailered-os/mutation-check.mjs` — 14 mutants, 0 survivors, 1 declared equivalent with proof |
| 4. Re-qualify live against the build that will actually merge | see the activation PR's evidence record |
| 5. Pass an independent verification | see the activation PR |

## Residual weaknesses (read before trusting any of the above)

0. **Two independent reviews of the first Round-2 build returned FAIL** (2026-08-11), with
   four CRITICAL findings between them. Everything above describes the state AFTER those
   were remediated — but the remediation has NOT itself been independently verified as of
   this revision, and the writer stays disarmed until it is. Treat the guarantees above as
   claims with tests behind them, not as an audited result.
1. **Same-process integrity is assumed.** The adapter is unforgeable *through its calling
   surface*: a look-alike object is not a fact, because authenticity is WeakMap membership.
   It is not proof against code that can patch the module graph or replace `execFileSync`
   — at which point the attacker is already executing arbitrary code in this process and
   every in-process control is moot. This is the standard boundary of an in-process
   policy layer, stated rather than papered over.
2. **The reviewer allowlist is the crown jewel.** `ALLOWED_HUMAN_REVIEWERS` in
   `authority.mjs` is one line; adding a login there is equivalent to granting human
   authority. It is protected by code review and nothing else.
3. **Notion-only human decisions cannot be authenticated** (above). Unblocks must be
   evidenced by an authored GitHub comment.
4. **The connector credential is broader than the allowlist.** Property-level enforcement
   is in-process policy; the governed Notion connector could write anything. The
   allowlist constrains this writer, not the credential.
5. **NEW3-OG6-0030 and NEW3-OG6-0031 have unrecoverable substance.** Round 3 named them
   only inside a range expression; no commit, comment, test or report describes what they
   were. They are carried as UNKNOWN rather than closed.

## Determinism / replay

`foldLifecycle(events)` is a pure fold: no wall clock, no randomness; `record.at` comes
from the event. Replaying a log reconstructs the identical state; `verifyReplay` turns
any mismatch into a visible `replay_divergence`. Duplicate `event_key`s are no-ops with
no second record.

Tests: `scripts/tailered-os/lifecycle.test.ts` (21-test §36/§37 battery — every failure
class proven to fire) + `scripts/tailered-os/lifecycle-writer.test.ts` (OG-006
writer battery, 65 tests — every pre-write gate, transport failure class, partial-write freeze,
and authority spoof proven to refuse) + `scripts/tailered-os/authority.test.ts` (44-test
adapter battery — every identity, freshness, substitution and forgery attack proven to
refuse). Run `node scripts/tailered-os/mutation-check.mjs` to re-prove that the
load-bearing controls are load-bearing; it exits non-zero on any survivor.
