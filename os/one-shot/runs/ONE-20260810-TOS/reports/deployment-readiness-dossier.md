# Tailered OS deployment-readiness dossier (no deploy performed)

**Conclusion:** the deployment path is fully specified by the code and can be executed the day
its gates clear, but this campaign correctly stops before staging: the runtime is not on `main`
(PR #496 owner-gated), and every required input below is PREZ-provisioned. Realistic terminal
state this run — dossier, not deploy — exactly as planned.

**Inspected contract** (not assumed from the name): `platform/tailered-os/` on the PR #496
branch at `722f3616a`.

- **Target platform:** Cloudflare Workers — four permanent service identities: `workshop`
  (Overseer/UI, custom-domain route), `context` (Gatekeeper context, KV-backed),
  `customGatekeeper`, `errorReporter`. Each gets a generated `wrangler.prod.jsonc` from the
  single annotated, non-secret control surface `deployment.jsonc`.
- **Build/deploy command:** `pnpm check` (config validation, `scripts/deploy.mjs --check`) then
  `pnpm deploy` (wrangler). One deployment per checkout; concurrent deploys need separate
  worktrees. Wrangler provisions DNS/TLS for the custom domain and the Context KV namespace on
  first deploy (or binds an existing one by id).
- **Auth:** Cloudflare Access mode (issuer `https://<team>.cloudflareaccess.com`, audience from
  the self-hosted Access app protecting the Workshop hostname; `admins` list gates `/admin`).
- **AI catalog:** optional; ships disabled. Enabling later requires `CF_AI_GATEWAY_API_TOKEN`
  installed via `wrangler secret put` (the generated config declares it required, so a missing
  secret fails the deploy clearly).
- **Observability:** first-class in the contract (invocation logs, traces, sampling rates are
  required config paths). Rollback: wrangler versioned deployments + the workers are stateless
  outside KV; kill path = disable the Access app / delete routes.
- **Isolation from Dime:** unchanged and re-proven in Lane E — Railway build context excludes
  `platform/` (.dockerignore), path-scoped CI, separate pnpm graph, zero server/client overlap.
  Deploying Tailered OS touches a Cloudflare account, never Railway/Stripe. **Decision for
  PREZ:** whether the target Cloudflare account is a NEW account or a separate zone in an
  existing one — Dime's existing Cloudflare resources remain untouchable either way.

## Exact PREZ-provisioned inputs (OG-004)

Non-secret values (edit `platform/tailered-os/deployment.jsonc` in a PR):
`accountId`; four worker names; `workers.workshop.route.customDomain` (or `workersDev: true`
for evaluation); `access.issuer` + `access.audience` (create the Access application first);
`access.admins`; `customGatekeeper.name` + `.message`.

Secrets (1Password → wrangler, never in git/Notion/CI logs):
`CLOUDFLARE_API_TOKEN` for wrangler auth (scope: Workers Scripts:Edit, Workers KV:Edit, DNS:Edit
on the target zone — least privilege, target account only); `CF_AI_GATEWAY_API_TOKEN` ONLY if
the AI catalog is enabled.

## Gate order to first staging deploy

1. PREZ publishes + ratifies PR #496 (OG-003) → runtime on `main`.
2. PREZ picks the Cloudflare account/zone posture and provisions the inputs above (OG-004).
3. `pnpm check` green in `platform/tailered-os/` → `pnpm deploy` with `workersDev: true`
   (evaluation route) = the staging step; the §25 staging proof list runs there (startup,
   Access denial behavior, KV, observability, kill switch, rollback) before any custom-domain
   production route exists.
4. Production route + the full §26 gate (all TOS scopes stable, reviews green, canary plan)
   before `customDomain` goes live.
