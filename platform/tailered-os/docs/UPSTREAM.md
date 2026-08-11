# Upstream provenance and update contract

Tailered OS is Tailered Sports' deployment wrapper for Cloudflare OS, based on
[cloudflare/cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter).
It lives at `platform/tailered-os/` inside the `tailered-ai/dime-ai` repository as an
**isolated application**: its own package.json, lockfile, pinned toolchain, tests, and
deployment boundary — repository-owned by dime-ai, operationally separate from the Dime
runtime. It follows the starter's core rule: **no upstream file is ever modified** — all
customization happens by composition (config overlay, service bindings, sibling
packages under `packages/`).

Because git submodule configuration belongs to the parent repository, the
`cloudflare-os` submodule is declared in dime-ai's **root** `.gitmodules`
(path `platform/tailered-os/cloudflare-os`), and the parent CI workflow lives at
`.github/workflows/tailered-os.yml` — a nested workflow would not execute.

## Current pins

| What | Where | Pinned at | Provenance |
| --- | --- | --- | --- |
| Starter base | this directory's content | `9c18a2e8b0c3741e5f4813546bbf24be5bbb98ee` | starter HEAD on 2026-08-10, audited during the Tailered repo-adopt evaluation. Standalone history (including the `starter-upstream` remote) is preserved in `tailered-ai/tailered-os` @ `aa6a4ae2df13df233af987cc6f03f2c895053f37`, retained as historical provenance. Future starter updates: diff this directory against `cloudflare/cloudflare-os-starter` at the recorded SHA and apply reviewed hunks by hand. |
| Cloudflare OS | `cloudflare-os/` submodule (declared in dime-ai root `.gitmodules`) | `b2a51b5426398c8353d9d4dd984bd525121ab5f2` | upstream `main` on 2026-08-09 — the exact SHA source-audited by the 2026-08-10 evaluation (five-agent audit; report in the adoption record) |

The starter originally pinned the submodule at `bf7f762d`. We advanced it to the
audited SHA after reviewing the 12-commit delta (only additive changes to the
surfaces `scripts/deploy.mjs` reads: a new `observability.traces` key the overlay
already manages, and an additive `stripTrailingSlashes` helper in the gatekeeper
contract) and confirming `pnpm test` passes against it.

## Update contract (mandatory for every submodule advance)

Upstream ships no tags, no releases, and no self-hosted upgrade documentation.
The pin discipline below is the only upgrade mechanism. **Never run
`git submodule update --remote`. Never track upstream `main`.**

1. Record the current gitlink SHA (rollback point).
2. Review the complete old→new upstream diff, prioritizing:
   - `packages/workshop-backend/wrangler.jsonc` and
     `packages/gatekeeper-context/wrangler.jsonc` (the base configs
     `scripts/deploy.mjs` reads and partially **replaces** — new upstream fields
     in replaced sections are silently dropped unless deploy.mjs carries them);
   - `packages/workshop-shared/src/gatekeeper.ts` (the contract
     `packages/custom-gatekeeper` implements);
   - `packages/error-reporting` (the contract `packages/error-reporter` implements);
   - Durable Object `migrations` blocks (new tags replay on fresh installs and
     must be presented by re-deploys).
3. Advance the gitlink to the reviewed SHA (initialize with
   `git submodule update --init platform/tailered-os/cloudflare-os` from the
   dime-ai repo root). From `platform/tailered-os/`, run `pnpm install`, then
   `pnpm install` inside `cloudflare-os/` (run inside the submodule so its own
   pinned pnpm governs), then `pnpm test`.
4. The `scripts/upstream-drift.test.mjs` golden will fail if the base-config
   shape changed — decide whether deploy.mjs must carry the change, then
   regenerate the golden (`UPDATE_GOLDEN=1 node --test scripts/upstream-drift.test.mjs`)
   in the same commit as the gitlink advance, with the decision noted in the
   commit message.
5. Update the pin table above. One commit per advance, message
   `chore: advance cloudflare-os submodule to <sha7> (<review summary>)`.
6. Deploys of an advanced pin follow the starter's upgrade checklist
   (`docs/customization.md` §Upgrades) and the operator skill's
   `upgrade-and-rollback.md` — Worker version rollback does NOT restore
   bindings, secrets, Access policy, or Durable Object migrations.

## Known-hazard register (from the 2026-08-10 source audit @ b2a51b54)

- `Gatekeeper.revertAction()` is unreachable at the audited SHA — approve/reject
  works; undo-after-apply does not exist. Do not promise revert semantics.
- A gatekeeper's `{restart: true}` response to `rejectAction` is discarded by the
  Overseer — after a rejection, a running gadget may keep reading rolled-back
  simulated state until its next reload.
- Session tokens never expire and have no revocation path. Deploy behind
  Cloudflare Access only; never enable password auth on a real deployment.
- `global_fetch_strictly_public` (the SSRF boundary) is inert under
  `wrangler dev` — local runs cannot prove the network sandbox.
- Keep `gatekeeper-mcp` (no URL allowlist by design) and
  `gatekeeper-homeassistant` (ships without the SSRF flag) uninstalled/disabled.
- GitHub and Notion gatekeepers have no webhooks; event-driven automation rides
  the Scheduler.
- The deploy is not atomic and there is no rollback script — the rollback matrix
  in the operator skill is the authority.

## Deployment status

**Not deployed.** Creating Cloudflare resources, authenticating wrangler, and the
first deployment require a separate explicit owner authorization, plus
verification that the Cloudflare account has Worker Loaders (Dynamic Workers),
Facets, KV, R2, and Browser Rendering entitlements.
