# Dime repository operating context

For GitHub, Railway, platform, AWS, Hugging Face, 1Password, or RunPod work,
begin with:

```bash
pnpm agent:context
```

This composes the exact GitHub/Railway capsule with the shared, sanitized agent
access state. It validates the repository, Railway workspace/project/production
environment/services, reads only cached provider identity evidence, and reports
which scope-isolated 1Password reference files are configured. Claude Code also
runs this command through a non-blocking `SessionStart` hook. Use the returned
five-minute capsule for the entire task while it is fresh.

Operating rules:

- Consume the fresh capsule instead of repeating repository, authentication,
  topology, deployment, health, PR, and check discovery.
- Use `pnpm agent:context -- --refresh` only when the capsule expired, a merge
  or deployment just occurred, the user requests current state, or an identity
  or parity mismatch is suspected. Use `pnpm agent:doctor` only for a live,
  read-only identity preflight.
- Reuse a successful GitHub check rollup only for the exact recorded commit SHA.
  New local changes still require focused validation and the required GitHub
  checks after push.
- Never use an implicit local Railway link for this repository. The reviewed
  broker passes explicit project, environment, and service IDs. Railway
  credentials are device-only in macOS Keychain and are retrieved only inside
  the independently hash-pinned `dime-railway-keychain` executable;
  `~/.railway/config.json` must contain no access or refresh token.
- Never print, persist, or place Railway variables in an agent environment. On
  an explicit production login, the native broker captures the pinned
  unreferenced shared-variable response in a private pipe, selects the requested
  role's exact three reviewed values in native code, and sends only that triple
  to the fixed authentication child over a second private pipe.
- Platform login is explicit. For production UI work run
  `pnpm platform:auth:owner` or `pnpm platform:auth:user`; use the headed
  variants only when a human-visible browser is needed. The harness attempts at
  most one credential login, verifies `appUsers.me`, and retains cookies only
  inside the current browser process. Browser storage state is never written to
  disk or reused.
- Verify Hugging Face or RunPod credentials only through
  `pnpm credential:verify -- --scope <reviewed-scope>`. Each scope has its own
  1Password process; never combine training, serving, publisher,
  locked-evaluator, RunPod, or AWS credentials.
- RunPod credential presence does not prove identity or least privilege. Until
  independently attested grants exist, its only valid status is
  `CREDENTIAL_PRESENT_PERMISSION_UNVERIFIED` and its authorization is `NONE`.
- Credential-bearing execution remains blocked unless the Railway broker and
  other security-sensitive executables match independently administered trust
  roots. Same-user modes, ad-hoc signatures, and repository-writable manifests
  are not trust roots.
- AWS uses the reviewed `dime-builder` SSO profile by default. Do not add static
  AWS access keys to repository or broker files.
- A passing connection is evidence of identity and read access. It is never
  authorization to merge, deploy, redeploy, restart, change variables, run a
  job, access the database, migrate, roll back, or alter a Railway source.
- A passing credential or production-login verification never authorizes
  provider execution, model download, publication, training, tracing, route
  activation, shadow traffic, or Research Alpha.
- Before any separately authorized remote mutation, bypass the cache and
  perform a fresh, operation-specific preflight. Do not add mutation behavior
  to either shared access script.

---

# Universal harness context (pi, Codex, other AGENTS.md-aware agents)

AI Sports Betting platform (React + tRPC + Drizzle/MySQL + Express) rebranding to **Dime AI**.
Claude Code loads CLAUDE.md (the full skill-arsenal map) instead of this file; the two must
not conflict — when they appear to, CLAUDE.md wins and this file has drifted: fix it.

Companion files: [HARNESS.md](HARNESS.md) (which agent runtimes exist and their config),
[SKILLS.md](SKILLS.md) (every skill source and how skills trigger), [LLM.md](LLM.md) (model
policy and routing), [CODEX.md](CODEX.md) (Codex specifics).

## Model policy (summary — LLM.md is authoritative)

Current-generation models only: **claude-fable-5** (default) or **claude-opus-5** for
Anthropic; **gpt-5.6-sol** for Codex. Never select older models. Enforced in
`.pi/settings.json` (`defaultModel`, `enabledModels`) and `server/_core/piAgent.ts`
(`PI_AGENT_APPROVED_MODELS`).

## Skills (summary — SKILLS.md is authoritative)

227 skills and 33 prompt templates are wired into pi (audited; see SKILLS.md; +5 on
2026-08-05: `design-federation`, vendored `impeccable`, `engineering-federation`,
`/ui-loop`, `/eng-loop`). If a skill
plausibly applies to the current task, invoke it before acting — skills encode process
(TDD, debugging, verification, planning), design taste, brand law, PM method,
UI-work routing (`design-federation`, entry `/ui-loop`), backend/infra control routing
(`engineering-federation`, entry `/eng-loop`), and
repo-specific verification (`verify`, `intended-vs-implemented`). In pi:
`/skill:<name>` or let the model auto-trigger from `<available_skills>`; prompt templates
from `.claude/commands/` are `/<name>`.

## Laws (non-negotiable)

1. **Dime brand law** — for any UI work, `design-system/dime-ai/MASTER.md` (+
   `design-system/dime-ai/pages/*.md` overrides) is authoritative: one-accent mint `#45E0A8`
   (`#0FA36B` for mint text on light), Familjen Grotesk + IBM Plex Mono, 160ms motion, no
   gradients/purple/neon-green/gold. Skill/generator output never overrides these tokens.
2. **Deploy law** — Railway is the sole host and auto-deploys every push to `main`: a merge
   to `main` IS a production deploy. Schema changes require the manual `db-push.yml`
   workflow BEFORE dependent code deploys. Runbook: `references/railway-deploy.md`.
3. **Data contracts** — the projections feed contracts in
   `design-system/dime-ai/pages/ai-model-projections.md` and
   `dime-ai/DIME-FEED-MIGRATION-DRAFT.md` must not be violated.
4. **Chat provider pin (owner-gated)** — `DIME_CHAT_LLM_PROVIDER` changes only by explicit
   owner-authorized code change (see `server/_core/dimeChatModel.ts`); the `dime1` path
   stays gated behind `ml/dime-1.0/docs/RELEASE_GATES.md`.

## Tailered OS (`platform/tailered-os/`)

Embedded isolated app (Cloudflare OS starter wrapper): own package.json/lockfile/pinned
pnpm, own tests, own future Cloudflare deployment boundary. NOT part of the Dime
build/Railway image; neither side imports the other. Upstream `cloudflare/cloudflare-os`
is an exact-pinned submodule declared in the ROOT `.gitmodules`; pin + update contract +
hazard register: `platform/tailered-os/docs/UPSTREAM.md` (authoritative). CI:
path-scoped `.github/workflows/tailered-os.yml`. Root prettier/docker/renovate/CodeQL
deliberately exclude the tree. Not deployed; deployment is owner-gated.

## Repo conventions

- TypeScript strict; `npx tsc --noEmit` must pass (CI uses `NODE_OPTIONS=--max-old-space-size=6144`).
- Package manager is **pnpm** (`pnpm add --ignore-scripts`); npm crashes on this tree.
- Vitest needs CI secrets (`DATABASE_URL` etc.) — DB-dependent tests fail locally without them.
- Never commit secrets. `dime-ai/design-bundle/uploads/` is personal reference material — do
  not redistribute or ship it.
- Sports-betting product: keep responsible-gaming language (21+, 1-800-GAMBLER) on marketing
  surfaces.
- Notion control plane: organizational context (goals, projects, decisions, releases, AI
  governance metadata) lives in Notion under the "Tailered Team Home" root page; GitHub stays
  authoritative for code and CI evidence. Machine-readable authority map:
  `config/tailered-os-control-plane.v1.json`; human runbook: `references/notion-control-plane.md`.
  PRs paste their Notion context URL into the PR template's "Notion context" section; never
  hand-mirror GitHub issues into Notion, never store secrets there.
