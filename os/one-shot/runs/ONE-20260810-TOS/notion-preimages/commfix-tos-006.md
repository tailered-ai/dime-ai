# Pre-image: TOS-006 task page (3b89673313e781e9a2e5c5e703cba8d3)
Fetched: 2026-08-10T23:22:51.234Z
URL: https://app.notion.com/p/3b89673313e781e9a2e5c5e703cba8d3

## Properties before mutation (relevant)
- Status: "Not started"
- Execution State: "Ready"
- Work Link: "https://github.com/tailered-ai/dime-ai"

## Full content before mutation
## GitHub authority
GitHub remains authoritative for branches, commits, diffs, PR state, reviews, CI, and merge.
## Notion authority
Notion remains authoritative for why, owner, priority, decision, business context, scope, result, and learning.
## Required PR context
For Tailered OS scopes, include Notion Project, Notion Task, Scope ID, human owner, decision class, and deployment impact.
## Validation
- The 13-tos-notion-context check fails a violating fixture PR and passes (no-ops) on a Dime-only PR.
- The check is marked Required on the protected branch after merge (OG-002).
- The PR template carries the Notion context section and the contract documents its failure modes.
## Non-goals
- No Notion API calls from CI; the check is text-contract based.
- No bot account and no auto-commenting service.
- No blocking of Dime-only PRs.
