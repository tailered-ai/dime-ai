<!-- A large PR with an empty body is not release-ready. Every section below is
required; write "none" explicitly where a section does not apply. -->

## Purpose and scope

<!-- What this PR does and deliberately does not do. -->

## Notion context

<!-- The governing Notion Project/Task URL, or "none" for changes with no Notion
scope. The pasted link IS the traceability mechanism (the Notion GitHub Sync
integration is archived — see references/notion-control-plane.md).

For Tailered-OS-scoped PRs (platform/tailered-os/, config/tailered-os-control-plane*,
scripts/tailered-os*, scripts/ci/tos-*, scripts/one-shot/, os/one-shot/) the
structured block below is REQUIRED and enforced by the 13-tos-notion-context
check; fill every line (canonical ids: config/tailered-os-control-plane.v1.json).
Other PRs may delete the block. -->

- Project: <!-- canonical Tailered OS project URL -->
- Task: <!-- direct Notion Task URL -->
- Scope ID: <!-- TOS-### -->
- Human owner: <!-- accountable human, never an AI -->
- Decision class: <!-- routine | material | owner-gated -->
- Deployment consequence: <!-- none | dime-runtime | tailered-os-runtime -->

## Linked incident / finding

<!-- INCIDENTS.md entry, issue number, audit finding, or "none". -->

## User-facing behavior changes

<!-- Every change a user can observe, including changed defaults and routes.
"Mechanical refactor" claims require the diff to contain zero behavior change. -->

## Reproduction evidence

<!-- For each fixed defect: how it was reproduced BEFORE the fix (command/test
+ failing output reference). A fix without a reproduced defect is a guess. -->

## Tests

- Added/changed tests:
- Full counts (passed / failed / skipped / not executed):
- Skipped tests and the declared reason for each:

## Bundle impact

<!-- check:bundle output: critical-path bytes vs budget. "Not measured" fails review. -->

## Database impact

<!-- Schema changes (db-push workflow required BEFORE deploy), data migrations, or "none". -->

## Security impact

<!-- Auth paths, redirects, secrets, preview/debug gates touched? Scanner results. -->

## Accessibility impact

<!-- Keyboard, focus, inert, reduced-motion, contrast. -->

## Deployment and rollback plan

<!-- What deploys when this merges (Railway auto-deploys main), how to verify
(smoke commands), and the exact rollback target SHA. -->

## Federation evidence

<!-- Two artifacts, two different homes. Write "none" (with a reason) where one does not
apply — per the convention at the top of this file, an empty line reads as "not produced".

1. Engineering evidence record — REQUIRED when this PR touches a production boundary:
   API/tRPC contracts, auth/sessions, schema or migrations, backfills, rate limiting,
   caching, containers/deploy, telemetry, resilience. PASTE the filled YAML below under
   its own "## Evidence record (engineering-federation §21.3)" heading; copy the block
   from .claude/skills/engineering-federation/references/record-template.yaml rather than
   retyping it. Terminal outcome comes from §21.4 and is part of that block, so it is not
   a separate field here.
2. Design evidence bundle — REQUIRED for UI/visual changes. LINK the folder under
   docs/audits/<date>-<surface>-evidence/.
   Contract: .claude/skills/design-federation/references/evidence-bundle.md -->

- Engineering evidence record: <!-- "below" | "none — docs-only, no production boundary" -->
- Design evidence bundle: <!-- path | "none — no visual change" -->

## Authorization

- [ ] CI green (all required checks)
- [ ] Owner has explicitly authorized merging this PR
- [ ] Post-deployment validation plan below

## Post-deployment validation

<!-- Exact commands/checks to run after deploy, e.g.
node scripts/smoke-deploy.mjs https://aisportsbettingmodels.com -->
