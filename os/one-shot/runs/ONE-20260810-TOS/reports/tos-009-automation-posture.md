# TOS-009 — Lifecycle automation posture (this campaign: GATED, NOT BUILT)

**Decision:** no lifecycle automation ships in this campaign. This is the CEO-review cut adopted
in plan rev 2, and it is the honest outcome of the eliminate-first ladder — not a deferral for
convenience.

## Why gated

1. **Eliminate/Simplify came first and removed most of the automation surface.** The two
   operations most worth automating were (a) keeping PR↔Task links honest and (b) keeping
   execution state legible. (a) shipped as a **static CI contract** (TOS-006, PR #504) — software,
   not automation: no credentials, no writes, no retry surface, nothing to kill. (b) shipped as
   **filtered canonical views** (TOS-002 delta pass) — zero moving parts.
2. **The §18 entry bar is not met by evidence.** Production automation requires the full test
   matrix (duplicate event, replay, invalid signature, stale SHA, wrong repo, permission denial,
   outage, partial success, interruption, concurrent workers) with demonstrated results. None of
   that evidence exists yet, so per "Pending is better than false Approved," automation is not
   production-ready and must not pretend to be.
3. **Its prerequisites closed only inside this campaign.** TOS-006 (the contract automation would
   enforce), TOS-007 (the resolver automation would call), and TOS-008 (the governance records
   automation must live under) all landed here and none is merged + owner-ratified yet.

## What the next campaign inherits as the automation entry bar

- Candidate automations, in earn-their-existence order: (1) reversible Execution State
  transitions from GitHub PR events (Ready→PR Open→CI→Review), (2) Work Link attachment on PR
  open, (3) blocker surfacing from failed CI. Nothing that approves, merges, or writes Proof.
- Mechanism decision deferred: GitHub webhooks vs a polling Action. If webhooks: the full §18
  webhook control list (signature, delivery id, allowlist, replay, rate limit, dead-letter, kill
  switch) is REQUIRED before first event.
- Credential precondition: a least-privilege Notion integration token provisioned by PREZ
  (same owner gate as TOS-007 api mode).
- Governance precondition: a registry record for the automation actor (Pending until the §18
  test matrix has evidence), with kill/disable path populated BEFORE first run.

## May / may-not (standing, restated for the next builder)

Automation may: validate readiness, assemble context, route tasks, update reversible state,
attach PR/CI links, surface blockers, prepare drafts, route exceptions to humans.
Automation may not: approve itself, merge around protection, waive CI, approve exceptions,
spend, change personnel, self-grant permissions, suppress failures, fabricate Proof/Result,
or mark deployments verified without a production check.
