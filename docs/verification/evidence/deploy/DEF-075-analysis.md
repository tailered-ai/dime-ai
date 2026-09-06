# DEF-075 — Railway auto-deploy bypasses the readiness and authorization gate

date recorded: 2026-08-13
severity: HIGH · status: OPEN (remediation is owner-gated; see disposition in
`docs/verification/GRADUATION-RISK-QUEUE.md`)
detected by: independent closure review of the deployment control plane
(2026-08-13), confirming a sequencing gap the readiness certificate already
exposes as `ready_for_deployment: false / CANDIDATE_NOT_PROTECTED_MAIN_HEAD`.

## The defect

The control plane attests the production path but does not sit on it. The
repository's deployment topology is `push to main → Railway auto-deploy`
(repo law: "merge to main IS a production deploy"). The control plane's
`execute` command refuses production without a human authorization receipt —
but Railway auto-deploy never passes through `execute`. The certificate
machinery is head-bound, producing this sequence:

```
PR branch
  -> readiness: ready_for_deployment=false (candidate is not protected main)
  -> merge to main
  -> Railway production deployment starts AUTOMATICALLY
  -> only now can a main-bound readiness certificate be issued
```

The production deployment begins before the production-readiness certificate
can exist. The plane attests after the trigger; it does not control the
trigger.

## Blast radius

Any authorized GitHub merge to `main` initiates a production deployment
without passing through `scripts/ci/deploy/readiness.mjs execute` or its
receipt enforcement. The merge itself is human-gated (branch protection,
review), so this is a gap in *deployment* control, not an unauthenticated
path — but the receipt, freshness, migration-receipt, and lease laws are all
bypassed on the normal path into production.

## Required acceptance condition (closure test)

No production provider mutation can begin until the exact protected-main
HEAD, artifact identity, target identity, current security state, migration
plan, rollback target, and owner authorization receipt are verified. Proof:
a merge (or its equivalent trigger) demonstrably does NOT reach production
without a valid receipt, and a valid receipt demonstrably does.

## Why this cannot be fixed inside this qualification

Every remediation mutates production infrastructure or repository
protections, both explicitly prohibited to the initiative:

1. **Decouple merge from deploy (preferred).** Disable Railway auto-deploy on
   the service (or point it at a non-production environment); production
   deploys then flow only through the control plane's receipt-gated,
   lease-held execution. Railway service mutation — owner-only (Railway
   mutation tools are hard-denied to agents in `.claude/settings.json`).
2. **Gate the trigger.** Require a GitHub deployment-environment approval (or
   equivalent check) that validates a pre-merge readiness certificate bound
   to the prospective merge-tree SHA before the merge can land. Branch
   protection / ruleset change — owner-only.
3. **Qualify before merge.** Keep auto-deploy but bind readiness to the
   prospective merge tree (`merge_tree_sha` is already recorded in every
   certificate), with automatic refusal if the merge tree or artifact
   changes. Requires (2) to be enforceable, plus provider support for
   deploying a prebuilt artifact rather than rebuilding.

## Interim safety (what holds today, evidence-backed)

- Merge to `main` remains human-gated: branch protection with required
  review and 24 required green checks (PR #512 state, 2026-08-13).
- The artifact built on merge is Dockerfile-identical to the rehearsed class:
  live build-log proof in `railway-builder-proof.md` (deployment
  `5bb7e28b` built from the repository Dockerfile).
- Runtime identity is verifiable post-deploy via `RAILWAY_GIT_COMMIT_SHA`
  (health/smoke contract), so an unexpected artifact is detectable, though
  not preventable, on this path.
- Migration safety is independently enforced by SchemaGuard
  (`SCHEMA_GUARD_FATAL=1` on the production service): a merge that skipped
  `db-push.yml` blocks its own deploy.

## Note on digest-level artifact identity

Railway's build-on-push model rebuilds from source; digest equivalence
between a locally qualified image and the provider image is unprovable by
construction. The deployment contract therefore binds artifact identity by
commit SHA (`RAILWAY_GIT_COMMIT_SHA` chain) plus builder provenance (now
proved from build logs). Digest-level identity requires registry-image
deploys — an infrastructure decision that belongs to remediation option 1/3.
