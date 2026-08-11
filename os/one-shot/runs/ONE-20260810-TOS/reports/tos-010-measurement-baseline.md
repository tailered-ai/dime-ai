# TOS-010 — Measurement baseline (ledger-derived; Draft where no instrument exists)

Primary instrument: `node scripts/one-shot/closeout.mjs metrics ONE-20260810-TOS` — every number
below is mechanically derived from `events.jsonl`; nothing is estimated. Status vocabulary:
**Measured** (this run produced it), **Draft** (smallest valid path defined, no data yet),
**Not-applicable** (no such operation occurred this run).

| §22/§45 metric | Status | Value / instrument |
| --- | --- | --- |
| % Tailered OS PRs with valid Notion context | Measured | 2/2 campaign PRs in the contract's scope carry compliant blocks (PR #504 dogfooded, #505); enforcement instrument = 13-tos-notion-context once merged (+Required flip OG-002) |
| Missing-Work-Link rate (TOS tasks) | Measured | 2/10 at audit (TOS-003, TOS-005); delta pass targets 1 of them (TOS-003) |
| Missing-Proof rate (TOS tasks) | Measured | 10/10 at audit — no TOS scope is terminal yet, so Proof emptiness is currently truthful |
| Missing-human-owner rate | Measured | 0/10 (audit enumeration) |
| Context-resolution latency (fixture) | Measured | 1.8 ms cold, 2074-byte packet, 1 external read (BENCHMARK_RESULT evt_00036) |
| Context-resolution latency (live api) | Draft | blocked on PREZ token (owner gate); instrument exists (`context.mjs` prints ms + bytes) |
| Context-resolution failure clarity | Measured | 11/11 failure modes emit what/why/fix (13-test suite) |
| Critical/High findings per scope; remediation cycles | Measured | metrics output: findings_total, critical_findings, high_findings, remediation_cycles |
| Negative tests recorded | Measured | metrics: negative_tests_recorded |
| gstack workflows / subagents / disagreements | Measured | metrics: gstack_invocations, subagents_dispatched/completed, subagent_disagreements |
| Owner gates per scope + open count | Measured | metrics: owner_gates, owner_gates_open |
| Context drift events (supplied vs live) | Measured | metrics: context_drift_events |
| Notion write verification completeness | Measured | closeout blocker fires when commits > verifications |
| Task Ready → execution start / → PR open | Draft | derivable from SCOPE_STARTED/PR_OPENED timestamps once scopes flow through Ready in Notion with the ledger running; this run's TOS scopes predate the ledger |
| PR → first review / review → green / CI fail → repair | Draft | needs CI_STATE_CHANGED + REVIEW_COMPLETED event pairs across a full PR lifecycle; instrument (event types + timestamps) exists |
| Duplicate-event rate / idempotent-retry success | Not-applicable | no automation ran (TOS-009 gated); ledger's duplicate-idempotency-key check is the future instrument |
| Rollback frequency / escaped defects | Not-applicable this run | CHANGE_REVERTED / post-merge FINDING events are the instrument |
| PREZ intervention rate | Measured (proxy) | 3 owner gates + 1 permission-classifier denial recorded this run |
| Manual handoffs removed / reusable assets | Measured | assets: ledger kernel, closeout/metrics validator, TOS-006 contract, TOS-007 resolver, 22 negative fixtures, 14 Notion views (delta pass), execution-packet template |
| New-teammate comprehension time (<2 min target) | Draft | instrument = the TOS-002 Command Center surfaces; measure with a human read-through after the delta pass |
| Agent full-context establishment time | Measured (fixture) | one command → 2 KB packet in <2 ms; live path Draft pending token |

**The program consumed itself:** TOS-006's validator gates its own PR; TOS-007's happy-path
fixture is the live TOS-006 task; the ledger recorded its own bootstrap and its own bug
(FIND-LANE0-0001 opened, remediated, negative-proven, closed — first full findings-lifecycle
datum). No invented baselines: everything unmeasurable is marked Draft with its instrument named.
