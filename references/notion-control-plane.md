# Notion control plane

Notion holds Tailered Sports' organizational truth: what the company is trying to
accomplish, what is being built, who owns each result, what was decided and why, and
whether outcomes are moving. External systems keep operational truth and Notion links to
them instead of restating them. This file is the human runbook agents read before touching
Notion; the **machine-readable authority map is
[`config/tailered-os-control-plane.v1.json`](../config/tailered-os-control-plane.v1.json)**
(enforced by `scripts/tailered-os-control-plane.mjs` + its vitest suite — if this file and
the manifest disagree, the manifest wins and the disagreement is a bug).

Root page: **[Tailered Team Home](https://app.notion.com/p/3b49673313e781569b59ff6f9ea0e4f1)**
(owner-confirmed 2026-08-10; this is the same page id previously titled
"Dime AI — Operations HQ"). Workspace uuid `a3e96733-13e7-81b4-820f-000342c82d33`.

## Tailered OS canonical surfaces (owner-confirmed 2026-08-10)

| Surface | URL |
| --- | --- |
| Tailered OS Project (canonical) | https://app.notion.com/p/3b89673313e7814da8a4ccfa9a21c969 |
| Tailered OS Command Center | https://app.notion.com/p/3b89673313e78114b9afd915c61d78a5 |
| Communication & Comprehension Standard | https://app.notion.com/p/3b89673313e78126896ae70b5f756795 |
| Claude Code Execution Contract | https://app.notion.com/p/3b89673313e78145bcb8fc9552bd727e |
| Tasks database | https://app.notion.com/p/96228d0d4aca436e8527053a27f7472c |
| Projects database | https://app.notion.com/p/888202aaf938497a91075121646e4cb4 |
| AI Systems Registry | https://app.notion.com/p/8673b8ac6f424acebc53b6cbf0698251 |

Tailered OS work items carry `TOS-###` Scope IDs and live in the canonical Tasks
database — never in a second tracker.

## Source-of-truth map

| Information                                 | Authoritative system                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| Source code and PR state                    | GitHub (`tailered-ai/dime-ai`) |
| CI and test evidence                        | GitHub Actions                                       |
| Runtime and deployment state                | Railway (RunPod only if the ML lane reactivates)     |
| Billing and subscriptions                   | Stripe                                               |
| Product telemetry                           | Analytics stack                                      |
| Credentials and secrets                     | 1Password + device-only Railway broker. Never Notion. |
| Strategy, goals, ownership, decisions, project health | Notion                                     |
| Model and agent governance metadata         | Notion AI Systems Registry, linking to artifacts     |
| Legal originals                             | Controlled legal file store, linked from Notion      |

## Conventions that touch this repo

- **PR linking.** The PR template has a "Notion context" section. Paste the governing
  Notion Project/Task URL there (or "none"). The link itself is the traceability
  mechanism. The Notion **GitHub Sync integration is archived** — do not rely on it to
  auto-relate PRs; a rebuilt, governed integration is TOS-006 scope.
- **Releases.** Every production deploy gets a Release record: exact commit SHA, PRs, CI
  link, deployment, health verification (`node scripts/smoke-deploy.mjs` output),
  migration state, and rollback SHA. A record never says "passed" without those links.
  Merge to `main` IS a production deploy (deploy law unchanged), so the record follows
  the merge.
- **Decisions.** Owner decisions land in the Decisions database with evidence links.
- **No double entry.** GitHub issues and PRs are never hand-mirrored into Notion; link to
  them instead.
- **No secrets.** Notion never holds keys, tokens, or credential values. The agent-access
  authority stays `config/dime-agent-access.v1.json`; the organizational control-plane
  identifiers stay `config/tailered-os-control-plane.v1.json`; credentials stay in
  1Password and the device-only Railway broker.
- **Registry honesty.** `ml/dime-1.0` is registered as Dormant / Not approved (no
  production checkpoint); Dime Chat is registered as the production Anthropic-gateway
  agent. Lifecycle changes ride decisions and `ml/dime-1.0/docs/RELEASE_GATES.md`, not
  registry edits. Machine actors are governed through the AI Systems Registry; an
  unverified integration stays Pending, never Approved.

## Recorded 2026-08-06 inventory — UNVERIFIED, pending connector re-verification

The 2026-08-06 build-out recorded seven root-page sections (Founder Cockpit, Product &
Engineering, AI Systems & Model Operations, Growth & Customer, Operations & People,
Leadership & Board, Setup & Governance) and sixteen related databases (Goals, Projects,
Tasks, Knowledge, Decisions, Meetings, Metrics, Releases, Incidents, Risks, AI Systems
Registry, Evaluation Runs, Market Coverage Matrix, Product Feedback, Experiments, Founder
Inbox). Of these, only the surfaces in the canonical table above are owner-confirmed as of
2026-08-10. The Decisions, Risks, Releases, and Knowledge database ids are carried in the
manifest marked `verified: false` until re-verified over the Notion connector; treat every
other 2026-08-06 pointer as historical until re-verified. The "Setup & Governance" page is
superseded as a governance source by the Tailered OS Command Center, the Communication &
Comprehension Standard, and the Claude Code Execution Contract. The prior revision of this
file (git history, 2026-08-06) preserves the full inventory, seeded state, manual-step
list, cadence, and day-30 criteria for provenance — its "Connect GitHub Sync" step is
superseded (integration archived), and its remaining open items belong to the canonical
Tasks database, not to this file.
