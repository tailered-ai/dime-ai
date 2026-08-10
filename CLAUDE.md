# CLAUDE.md

AI Sports Betting platform (React + tRPC + Drizzle/MySQL + Express) undergoing a rebrand to
**Dime AI**. This file maps the project's skill arsenal and the rules that govern it.

Harness-neutral companions (Claude Code loads this file; pi/Codex load `AGENTS.md` instead):
`AGENTS.md` (universal context root), `HARNESS.md` (agent runtimes + wiring), `SKILLS.md`
(full skill corpus + triggering), `LLM.md` (model policy: Fable 5 / Opus 5 / Codex
`gpt-5.6-sol`, no older models — authoritative), `CODEX.md`. Keep them in sync with this
file; on conflict about models, LLM.md wins.

**Execution protocol — Claude Code primary.** Claude Code (VS Code extension + Desktop,
subscription auth — never the API for interactive work) is the primary harness; the pi
foundation is called, cached, and triggered on every prompt: this file + the SessionStart
hooks load per session, `.claude/scripts/prompt-capsule.sh` (UserPromptSubmit hook)
injects the execution capsule into EVERY prompt, and the `pi-harness` skill
(`.claude/skills/pi-harness/`) routes shipping/review/agent tasks through `pnpm pi:*`
and the embedded runtimes. Auth law: LLM.md "Auth model: subscription-first".

## Skill arsenal — structure

| Layer                                    | Location                                                                                                          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design intelligence                      | `.claude/skills/` (uipro)                                                                                         | ui-ux-pro-max (searchable styles/palettes/fonts/stacks + dials), design-system, design, ui-styling, brand, banner-design, slides                                                                                                                                                                                                                                                                                                                                                                                  |
| Design intelligence (upstream plugin)    | plugin `ui-ux-pro-max@ui-ux-pro-max-skill`, vendored at `.claude/plugins-vendored/ui-ux-pro-max-skill/` (v2.11.0) | Upstream nextlevelbuilder build, newer than the `.claude/skills/` copy (84 styles / 192 palettes / 74 font pairings vs 67 / 161 / 57). Ships 7 skills: ui-ux-pro-max, design, design-system, ui-styling, brand, banner-design, slides — namespaced `ui-ux-pro-max:<skill>`, so they coexist with the vendored flat copies                                                                                                                                                                                         |
| Design taste                             | `.agents/skills/frontend-design/`                                                                                 | Anthropic official — distinctive, non-templated visual direction                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Writing quality                          | `.claude/skills/stop-slop/`                                                                                       | hardikpandya/stop-slop — strips AI writing tells from prose (filler phrases, formulaic structures, passive voice); use when drafting/editing copy or docs                                                                                                                                                                                                                                                                                                                                                         |
| Design taste (Emil Kowalski)             | `.claude/skills/` (emilkowalski/skill)                                                                            | emil-design-eng (UI polish philosophy), apple-design (Apple-style motion/materials for web), animation-vocabulary (name-that-motion glossary), review-animations                                                                                                                                                                                                                                                                                                                                                  |
| Design taste (Anthropic, pinned 9d2f1ae) | `.claude/skills/`                                                                                                 | frontend-design (also in `.agents/skills/`), algorithmic-art (p5.js generative art + templates), mcp-builder (MCP server quality guide)                                                                                                                                                                                                                                                                                                                                                                           |
| Design taste (leonxlnx, pinned b177427)  | `.claude/skills/` (13 skills, leonxlnx/taste-skill, MIT) + plugin `taste-skill@taste-skill`                       | Anti-slop frontend: taste-skill (v2 default, brief-inference + VARIANCE/MOTION/DENSITY dials), taste-skill-v1, redesign-skill (audit-first upgrades), soft-skill (expensive/agency look), minimalist-skill (Notion/Linear editorial), brutalist-skill (Swiss/terminal), gpt-tasteskill (GSAP motion), output-skill (anti-truncation), stitch-skill (Google Stitch DESIGN.md), image-to-code-skill, imagegen-frontend-web/-mobile, brandkit (image-gen only). Plugin tracks upstream alongside the vendored copies |
| Code review                              | `.claude/skills/code-review-excellence/`                                                                          | wshobson/agents (pinned d7cf7dc) — review methodology: severity triage, security/perf/maintainability checklists, feedback phrasing                                                                                                                                                                                                                                                                                                                                                                               |
| Product management (phuryn)              | `.claude/skills/` (68 skills, phuryn/pm-skills)                                                                   | Strategy (canvases, five-forces, pricing), discovery (assumptions, experiments, interviews, OST), execution (PRD, OKRs, sprints, retros), GTM (ICP, battlecards, growth loops), market research, analytics (SQL, A/B, cohorts), toolkit (NDA, privacy policy). Overlaps deanpeters plugins — prefer `/pm-*` commands for the deanpeters chain                                                                                                                                                                     |
| Upload bundles                           | `.claude/skill-zips/` (untracked, derived)                                                                        | claude.ai-ready zips for Settings → Skills → Add. Not in git (2026-08-05): regenerate on demand by zipping the corresponding skill directory under `.claude/skills/` or `.agents/skills/`                                                                                                                                                                                                                                                                                                                         |
| Payments                                 | `.agents/skills/stripe-best-practices/`                                                                           | Stripe official — API selection, billing, webhooks, key security                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Engineering process                      | plugin `superpowers@claude-plugins-official`                                                                      | 14 skills: brainstorming, writing/executing-plans, TDD, systematic-debugging, verification-before-completion, code review (both directions), subagent/parallel dispatch, worktrees, branch finishing, writing-skills                                                                                                                                                                                                                                                                                              |
| MCP development                          | plugin `mcp-server-dev@claude-plugins-official`                                                                   | Designing and building MCP servers that work well with Claude: deployment models (remote HTTP, MCPB, local), tool design patterns, auth, interactive MCP apps                                                                                                                                                                                                                                                                                                                                                     |
| Product management                       | plugins `*@pm-skills` (55 enabled of 70 vendored), vendored at `.claude/plugins-vendored/pm-skills/`              | Full deanpeters/Product-Manager-Skills catalog: discovery, JTBD, user stories/splitting/mapping, PRD, prioritization, roadmap, positioning, personas, journey maps, OST, POL probes, stakeholders, SaaS finance/growth metrics, TAM/SAM/SOM, workshops, exec-track advisors                                                                                                                                                                                                                                       |
| Advertising                              | `.agents/skills/` (12, realkimbarrett/advertising-skills)                                                         | Direct response: avatar/offer extraction, Schwartz awareness mapping, headline-matrix, mechanism-builder, objection-crusher, ad-angle-multiplier (creative testing), scroll-stopping-creative, conversion-path-builder, performance-diagnosis, generic-language-killer, full-funnel-campaign-orchestrator                                                                                                                                                                                                         |
| Architecture                             | `.agents/skills/` (2)                                                                                             | architect-backend-systems (system boundaries, APIs, data/identity/queues, reliability, migrations, threat models), architect-github-repos (repo-wide structure audits, dead/duplicated file classification, structural cleanup). Both carry `agents/` + `references/` subdirs; skip for isolated bug fixes and pure UI work                                                                                                                                                                                       |
| Repo-specific verification               | `.claude/skills/` (1)                                                                                             | intended-vs-implemented (audit the gap between documented intent and actual code)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Design orchestration                     | `.claude/skills/design-federation/`                                                                               | Thin UI-work router over the design federation (entry `/ui-loop`): one declared aesthetic Lead per surface, brand-law reading order (pages override → MASTER.md, THREE-COLOR-LAW wins where they disagree), the brief → build → rendered-proof → audit loop, and the evidence-bundle contract. references/: routing, brief template, evidence bundle, registry (pins/licenses/scopes)                                                                                                                             |
| Engineering orchestration                | `.claude/skills/engineering-federation/`                                                                          | Backend/infra sibling of design-federation (entry `/eng-loop`): vendored Production-Grade Engineering Reference Architecture (v1.0, 2026-08-05) as control standard; classify → baseline → build → gate → evidence-record loop with terminal outcomes; routes design method to architect-backend-systems; hard conditionals for schema (db-push law), backfills, new infra (earn-its-existence), traffic control. references/: the standard, dime-mapping (controls → repo gates), routing (invocation surfaces — the architect skills are Read-path, not Skill-invocable), record-template.yaml (copy → fill → paste into the PR body — owner-ruled 2026-08-07, DR-014 Ruling 2)  |
| Design operations (pinned ae5e951)       | `.claude/skills/impeccable/`                                                                                      | pbakaus/impeccable v4.0.4 (Apache-2.0, vendored — provenance in its `VENDOR.md`): 23 `/impeccable` workflow commands (init/shape/critique/audit/polish/…), 59-rule deterministic detector (`npx impeccable@3.5.0 detect --json`), 4 `impeccable-*` subagents in `.claude/agents/`. Edit-time hooks deliberately NOT wired (owner opt-in via settings.local.json)                                                                                                                                                  |
| Design handoff                           | plugin `figma@knowledge-work-plugins`                                                                             | figma/mcp-server-guide (pinned 07316dd) — read design files, components, and tokens; translate Figma designs into code                                                                                                                                                                                                                                                                                                                                                                                            |
| Deployment                               | plugin `railway@railway-skills`                                                                                   | railwayapp/railway-skills — `use-railway` skill + hosted MCP server for services, environments, deployments, logs, and troubleshooting. Pair with `references/railway-deploy.md` (deploy law below)                                                                                                                                                                                                                                                                                                               |
| Secondary harness                        | `.pi/` + global `@earendil-works/pi-coding-agent`; embedded runtime `server/_core/piAgent.ts`                     | pi coding agent wired to this repo: loads `AGENTS.md` + all skill trees + `.claude/commands/` as templates via `.pi/settings.json`; dime-guard extension, dime theme, model policy. pi-agent-core embeds the same stack in-process (createPiAgent/runPiChat/runPiAgent, gateway-routed). Runbook: `references/pi-harness.md`                                                                                                                                                                                      |
| Multiplayer orchestration                | `~/src/qm` reference clone (yc-software/qm)                                                                       | QM — Slack + web org workspaces driving Pi/Claude Code; this repo feeds it as a skill pack and sandbox checkout; deployment owner-gated (docker/fly/aws). Runbook: `references/qm-harness.md`                                                                                                                                                                                                                                                                                                                     |
| Browser + shipping (gstack)              | `~/.claude/skills/gstack` (user scope, tracks upstream `main`); bootstrap `.claude/scripts/bootstrap-gstack.sh`   | garrytan/gstack — 53 skills, all installed **`gstack-` prefixed**. `/gstack-browse` is THE browsing path (never `mcp__claude-in-chrome__*`); plus `/gstack-qa`, `/gstack-review`, `/gstack-investigate`, `/gstack-canary`, `/gstack-land-and-deploy`, the `/gstack-plan-*-review` panel, and `/gstack-careful`+`-freeze`+`-guard`. The prefix is what keeps `/ship` and `/retro` Dime's — full list, the collision law, and the bootstrap contract are in the **gstack** section below                                                                                                                                                            |

Plugin config lives in `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`, 61
plugins across 6 marketplaces). `skills-lock.json` pins the npx-installed sources.
`.agents/skills/` is the universal directory (17 agent platforms).

**Plugin bootstrap is not guaranteed (IMPORTANT).** `settings.json` declares the plugins; it does
not install them. Remote/cloud sessions have started with an empty
`~/.claude/plugins/installed_plugins.json` and only the `claude-plugins-official` marketplace
cloned — every plugin skill silently missing, with no error. The vendored `.claude/skills/` and
`.agents/skills/` trees always load, so the loss is easy to miss: superpowers, mcp-server-dev, the
55 `*@pm-skills`, figma, and railway just aren't there (the `/sp-*` and `/pm-*` commands still
work — they are local files in `.claude/commands/`).

**This is now self-healing.** A `SessionStart` hook (`startup|resume|clear`, timeout 300s) runs
`.claude/scripts/bootstrap-plugins.sh` on every session start and resume. Warm sessions early-exit
in ~2s; a cold container rebuilds to 61/61 in ~95s. To check or repair by hand:

```bash
claude plugin list | grep -c @        # expect 61
./.claude/scripts/bootstrap-plugins.sh
```

`--scope project` is a no-op against the already-declared `enabledPlugins`, so
`.claude/settings.json` is left untouched. Installed plugins load in the **current** session.

## Shared agent access (IMPORTANT)

A second, non-blocking `SessionStart` hook runs
`.claude/scripts/bootstrap-dime-context.sh`. It loads the same checksum-bound,
five-minute `pnpm agent:context` capsule used by Codex. Reuse that capsule instead
of repeating GitHub authentication, repository, PR/check, Railway topology,
deployment, and health discovery.

The exact non-secret authority is `config/dime-agent-access.v1.json`. GitHub and
Railway remain pinned to
`tailered-ai/dime-ai`,
`stunning-creativity` (`8dd7341d-702c-48c7-90df-5c19a4f04913`), and production
(`787f3113-17ab-47d9-9819-1268aeb09b3e`). Never use an implicit Railway link or
print, persist, or place Railway variables in Claude's environment. Railway
access runs through the independently hash-pinned, device-only macOS Keychain
broker; the standard Railway CLI config must not hold access or refresh tokens.

Credentials are scope-isolated:

- production owner and user logins use a native Railway broker that captures
  the raw map privately, selects only that role's exact three unreferenced
  values, and passes them to a fixed authentication child through a private
  pipe; cookies remain browser-process-only and no storage state is written;
- every Hugging Face training, serving, publisher, locked-evaluator, and
  locked-publisher credential has a separate `op run` process;
- RunPod has a separate scope, but identity and permissions remain unverified;
  `CREDENTIAL_PRESENT_PERMISSION_UNVERIFIED` is not provider authorization;
- AWS uses the allowlisted `dime-builder` SSO profile by default and never
  static keys.

Use `pnpm agent:doctor` for a live read-only identity preflight,
`pnpm platform:auth:owner` or `pnpm platform:auth:user` only when production
login is explicitly required, and
`pnpm credential:verify -- --scope <reviewed-scope>` only for identity proof.
Do not print, persist in evidence, or move credential values between scopes.
Credential execution fails closed unless each sensitive executable and the
Railway broker match independently administered signing or root-owned hash
provenance; same-user and ad-hoc signatures are insufficient.
Passing context, identity, credential, or login checks never authorizes merge,
deployment, Railway mutation, provider execution, Hugging Face publication,
RunPod compute, model download, training, tracing, route activation, shadow
traffic, or Research Alpha.

**All six marketplaces are vendored (`.claude/plugins-vendored/`, 18M) — bootstrap is fully
offline.** `extraKnownMarketplaces` points at them with
`{"source": "directory", "path": "./.claude/plugins-vendored/<name>"}`; no GitHub source remains.

| Vendored marketplace  | Size | Contents                                                           |
| --------------------- | ---- | ------------------------------------------------------------------ |
| `pm-skills`           | 2.6M | all 70 plugin payloads, 55 enabled                                 |
| `ui-ux-pro-max-skill` | 8.5M | v2.11.0, the 7 skills it ships (5.5M is `ui-styling/canvas-fonts`) |
| `dime-vendored`       | 4.5M | superpowers, mcp-server-dev, figma                                 |
| `taste-skill`         | 1.9M | taste-skill                                                        |
| `railway-skills`      | 672K | railway                                                            |

**Why `dime-vendored` exists.** `claude-plugins-official` and `knowledge-work-plugins` are
_reserved names_ — the CLI accepts them only from GitHub `anthropics` sources and rejects a
directory source outright ("The name '…' is reserved for official Anthropic marketplaces"). So
superpowers, mcp-server-dev, and figma are rehosted under a non-reserved marketplace name and keyed
as `<plugin>@dime-vendored` in `enabledPlugins`. Skill IDs are namespaced by _plugin_, not
marketplace, so `superpowers:brainstorming`, `mcp-server-dev:build-mcp-server`, and `figma:figma-use`
are unchanged.

Three things that are easy to get wrong here:

- **`claude plugin marketplace remove` rewrites `.claude/settings.json`** — it strips every
  matching `enabledPlugins` entry (56 of them, for these two) and moves the marketplace
  declaration into _user_ settings as an absolute path. Check `git diff .claude/settings.json`
  after any marketplace surgery; `git checkout .claude/settings.json` restores it.
- **Installs are still cached to `/root/.claude/plugins/cache/`**, which is ephemeral. That cache
  is a derived artifact — the repo is the source of truth, and the cache is rebuilt from
  `.claude/plugins-vendored/` on demand. Do not edit skills in the cache; edit them in the repo.
- **`bootstrap-plugins.sh` must stay cwd-independent and must never exit 2.** Hooks do not always
  run from the repo root, so the script resolves its root from `${BASH_SOURCE[0]}`, not `$PWD` or
  `git rev-parse`. Exit 2 is a _blocking_ error for `SessionStart` — a missing arsenal must degrade
  to a warning, never wedge the session.

Do not flat-vendor pm-skills into `.claude/skills/`: five names (`ansoff-matrix`,
`customer-journey-map`, `opportunity-solution-tree`, `porters-five-forces`, `swot-analysis`)
collide with the phuryn skills already there. The marketplace layout keeps them namespaced as
`<skill>@pm-skills`.

## Custom commands (`.claude/commands/`)

Give `$ARGUMENTS` real context, not just a topic name. Full command definitions are under
`.claude/commands/`; inspect only the command relevant to the current task.

Non-derivable notes: the `/pm-*` discovery chain is `/pm-problem` → `/pm-probe` → `/pm-story` →
`/pm-epic` → `/pm-prioritize`; ALL `/ui-*` commands enforce Dime brand law from
`design-system/dime-ai/MASTER.md`; `/stripe` is grounded in this repo's webhook/checkout code;
`/ship <PR#>` = verify CI and release gates → merge approved PR → confirm Railway deployment and
smoke checks; `/gh-fix <issue#>` = issue → isolated worktree → focused fix → verification → PR;
`/ui-loop <surface + change>` = federated design loop (design-federation skill): brief with ONE
declared aesthetic Lead → build → rendered proof → impeccable/motion gates → evidence bundle;
`/eng-loop <change + context>` = federated engineering loop (engineering-federation skill):
classify boundary → baseline → smallest change → gates per dime-mapping → evidence record
with terminal outcome (schema changes ride db-push.yml BEFORE dependent code).

Typical build loop: `/pm-problem` → `/pm-story` → `/sp-plan` → `/sp-tdd` → `/ui-build` → `/sp-verify` → `/sp-review-ask` → `/sp-finish`.
For multi-skill or aesthetic-direction UI work, `/ui-loop` wraps the `/ui-build` → `/sp-verify` span.

Useful CLI: `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" [--domain ...] [--stack ...] [--design-system --variance N --motion N --density N]`

## gstack

[garrytan/gstack](https://github.com/garrytan/gstack) lives at `~/.claude/skills/gstack` — **user
scope, not project scope**: `./setup` symlinks each sub-skill into `~/.claude/skills/`, so nothing
in this repo can carry it. A third `SessionStart` hook
(`.claude/scripts/bootstrap-gstack.sh`, `startup|resume|clear`, timeout 300s) closes that gap: a
warm machine early-exits in ~0s, a cold one clones and builds once (~40s) and never again.
**`bun` is a prerequisite** (`brew install bun`) — without it the hook warns and exits 0 rather
than wedging the session. Opt out with `DIME_SKIP_GSTACK=1`.

The hook pins `--prefix` (every gstack skill installs as `/gstack-<name>` — see **Name collisions**
below) and `--no-plan-tune-hooks` (never writes hooks into a teammate's `~/.claude/settings.json`),
and sets `GSTACK_SKIP_COREUTILS=1` so an unattended session never `brew install`s on someone's
machine — re-run `./setup` by hand if you want `/gstack-codex` hang protection. It deliberately does
**not** `git pull` an existing checkout; gstack tracks upstream `main` and advancing it is a
deliberate act: `/gstack-upgrade`, or `cd ~/.claude/skills/gstack && git pull && ./setup`.

**Browsing law (IMPORTANT).** Use the **`/gstack-browse`** skill for **all** web browsing —
page loads, screenshots, scraping, form interaction, console/network inspection, rendered proof.
**Never use the `mcp__claude-in-chrome__*` tools.** The binary is
`~/.claude/skills/gstack/browse/dist/browse` (76 commands: `goto`, `screenshot`, `snapshot`,
`click`, `fill`, `eval`, `console`, `network`, `scrape`, `ux-audit`, …). There is no `bin/browse` —
`bin/` holds the 76 `gstack-*` helper executables, not the browser.

Running `browse` from a repo creates a per-project `.gstack/` daemon-state dir there and appends
`.gstack/` to that repo's `.gitignore` (idempotent, `browse/src/config.ts`). This repo ignores
per-project `.gstack/` browser state, so an unexplained `.gitignore` diff after your first
`/gstack-browse` is this, not a mistake. Note that headless `browse` against **production** is a
bot to the edge and gets 403'd by design; verify prod from Railway logs instead
(`references/railway-deploy.md`).

Available gstack skills — **all 53 carry the `gstack-` prefix**:

- **Plan** — `/gstack-office-hours`, `/gstack-autoplan`, `/gstack-plan-ceo-review`,
  `/gstack-plan-eng-review`, `/gstack-plan-design-review`, `/gstack-plan-devex-review`,
  `/gstack-plan-tune`, `/gstack-spec`
- **Design** — `/gstack-design-consultation`, `/gstack-design-shotgun`, `/gstack-design-html`,
  `/gstack-design-review`, `/gstack-diagram`
- **Review** — `/gstack-review`, `/gstack-devex-review`, `/gstack-cso`, `/gstack-investigate`,
  `/gstack-retro`, `/gstack-health`
- **Ship** — `/gstack-ship`, `/gstack-land-and-deploy`, `/gstack-canary`, `/gstack-benchmark`
- **Browser** — `/gstack-browse`, `/gstack-connect-chrome`, `/gstack-qa`, `/gstack-qa-only`,
  `/gstack-setup-browser-cookies`, `/gstack-scrape`, `/gstack-skillify`, `/gstack-pair-agent`
- **Docs** — `/gstack-document-release`, `/gstack-document-generate`, `/gstack-learn`,
  `/gstack-make-pdf`
- **Safety** — `/gstack-careful`, `/gstack-freeze`, `/gstack-guard`, `/gstack-unfreeze`
- **iOS** — `/gstack-ios-qa`, `/gstack-ios-fix`, `/gstack-ios-design-review`, `/gstack-ios-sync`,
  `/gstack-ios-clean`
- **Setup/state** — `/gstack-setup-deploy`, `/gstack-setup-gbrain`, `/gstack-sync-gbrain`,
  `/gstack-upgrade`, `/gstack-codex`, `/gstack-context-save`, `/gstack-context-restore`,
  `/gstack-landing-report`, `/gstack-benchmark-models`

`/gstack-upgrade` is named that way upstream and is not double-prefixed. The root `/gstack` router
is never prefixed.

That is 53 distinct skills across 54 `gstack-*` skill directories: upstream ships `connect-chrome`
as a **symlink** to `open-gstack-browser`, so both directories carry the same `SKILL.md` (one inode,
one declared `name:`) and the pair surfaces as the single skill **`/gstack-connect-chrome`** —
`/gstack-open-gstack-browser` does not resolve as a separate entry.

### Name collisions (IMPORTANT — do not "simplify" this)

This repo owns two names gstack also ships: **`ship`** (`.claude/commands/ship.md`, the Railway
release pipeline) and **`retro`** (`.claude/skills/retro/`, the phuryn PM retro).

**Claude Code does not resolve these by scope.** There is no project-beats-user rule — verified
2026-08-10 in a fresh session, where `retro` resolved to gstack's skill, not this repo's. Same-named
skills collapse to one winner, and `skillOverrides` is keyed by bare skill name with no scope
qualifier, so it cannot disable the user-scope copy without disabling the project's too.

The fix is upstream-supported and lives in the naming mode, not in precedence:

| Name | Resolves to | Notes |
| --- | --- | --- |
| `/ship` | **Dime** — `.claude/commands/ship.md` | Railway release pipeline. The only `ship`. |
| `/retro` | **Dime** — `.claude/skills/retro/SKILL.md` | phuryn PM retro. The only `retro`. |
| `/gstack-ship` | gstack | branch/test/VERSION/CHANGELOG/PR workflow |
| `/gstack-retro` | gstack | weekly engineering retrospective |

`./setup --prefix` renames **every** gstack skill (gstack applies the prefix uniformly — there is
no per-skill allowlist), which is what frees `ship` and `retro`. setup persists the choice via
`gstack-config set skill_prefix true` in `~/.gstack/config.yaml`, so a later bare `./setup` and
`/gstack-upgrade` (which stashes, `git reset --hard`s, then re-runs setup) both stay prefixed.
The bootstrap hook judges health on the **observable surface**, not on the config: the checkout is
a real git checkout, `VERSION` is non-empty, `browse/dist/browse` is executable,
`~/.claude/skills/gstack-browse/SKILL.md` exists and is the checkout's own `browse/SKILL.md`
(compared by inode, so path spelling cannot fool it), and `skill_prefix=true`. Anything less is not
healthy, so a flat-mode machine is reconciled by one `./setup --prefix`.

**Bounded self-repair.** setup persists `skill_prefix=true` at `setup:180` but does not create the
skill links until `setup:994`, and it deletes the old flat links at `setup:987` — so an interrupted
setup can leave a machine claiming prefixed mode with _no gstack skills at all_. Trusting the config
would call that healthy; refusing to act on it would leave it broken forever. The hook instead makes
**one** `./setup --prefix` attempt per cooldown window:

- Success → `gstack repaired (…)`, state cleared.
- Failure → prints `gstack DEGRADED:` with the exact cause and the manual recovery command, **exits
  0** so startup is never blocked, and records `~/.gstack/.dime-gstack-repair` (epoch + gstack
  version@sha, atomic write-then-rename).
- While that state is fresh, later sessions skip setup entirely and just repeat the warning — no
  setup storm. Retry re-opens after 6h (`DIME_GSTACK_REPAIR_COOLDOWN`) **or** as soon as gstack's
  own version/sha changes, whichever comes first. Deleting the state file forces an immediate retry.
- Concurrent sessions are serialised by an atomic `mkdir` lock at
  `~/.gstack/.dime-gstack-repair.lock`; the loser reports and exits rather than waiting, and a lock
  orphaned by a killed session is reclaimed after 30m (`DIME_GSTACK_LOCK_STALE`).

Both state files follow gstack's own `~/.gstack` dot-file convention (cf. `.last-setup-version`,
`setup:1227`). Neither lives in the repo.

Deliberate consequence: a developer who runs `./setup --no-prefix` by hand gets the collision back,
and the next SessionStart will reconcile them to prefixed. `DIME_SKIP_GSTACK=1` is the opt-out.

Repo law still governs gstack output: UI obeys `design-system/dime-ai/MASTER.md`, schema changes
ride `db-push.yml` first, and merging to `main` IS a production deploy.

## Precedence rules (IMPORTANT)

1. **Dime brand law beats skill suggestions.** For any UI work, `design-system/dime-ai/MASTER.md`
   (+ `design-system/dime-ai/pages/*.md` overrides) is authoritative: one-accent mint `#45E0A8`
   (`#0FA36B` for mint text on light), Familjen Grotesk + IBM Plex Mono, 160ms motion, no
   gradients/purple/neon-green/gold. uipro's palette/font generator output is generic — never
   let it override the locked tokens.
2. **Process skills govern how, not what.** superpowers (TDD, verification, planning) applies to
   engineering work; PM skills apply to product framing; neither overrides explicit user direction.
3. **Backend data contracts** for the projections feed are documented in
   `design-system/dime-ai/pages/ai-model-projections.md` and `dime-ai/DIME-FEED-MIGRATION-DRAFT.md`
   — do not violate them when rebuilding UI.

## Dime AI context pointers

- `dime-ai/README.md` — brand kit map + verified tokens
- `dime-ai/reference-pages/` — implementation references: chat/home (dark+light), feed
  (dark+light), landing page. Static, pixel-verified against the Claude Design source.
- `dime-ai/DIME-FEED-MIGRATION-DRAFT.md` — the phased plan for rehosting the MLB projections
  feed inside the Dime shell (route `/feed` → "AI Model Projections" tab)
- Chat page: `client/src/pages/DimeChat.tsx` (`/chat`, SSE via `POST /api/dime/chat`) — keep the
  streaming core when reskinning
- Claude traffic routing — the Anthropic SDK (`server/_core/anthropicClient.ts`), Agent SDK
  (`server/_core/dimeAgent.ts`), embedded pi-agent-core runtime (`server/_core/piAgent.ts`),
  and Claude Code CLI all route through an Anthropic-compatible gateway via
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. dimeAgent spawns Claude Code as a
  subprocess with built-in tools; piAgent runs in-process with app-defined `AgentTool`s and
  streamed events — pick per task, both expose the same result shape
- `ml/dime-1.0/README.md` — canonical governed Dime 1.0 development foundation: QLoRA/SFT
  post-training and evaluation from pinned `meta-llama/Llama-3.1-8B` Base. It owns reviewed
  prompts, schemas, synthetic public fixtures, CPU validation, and release gates; it does not
  contain a production-trained checkpoint or active endpoint. Server wiring remains a frozen
  future scaffold in `server/_core/dime1*.ts`. `DIME_CHAT_LLM_PROVIDER` must stay `"frozen"`
  until a separate owner-authorized promotion PR satisfies `ml/dime-1.0/docs/RELEASE_GATES.md`.
  **2026-08-04 (owner decision):** Dime Chat is API-based (`DIME_CHAT_LLM_PROVIDER: "anthropic"`);
  the ML lane is DORMANT — PR #289 closed (branch `agent/dime-v1-release-candidate-v1` preserves
  the checksummed dataset candidate), the RunPod endpoint decommissioned, its production env vars
  removed, and `dime-llm-validation.yml` triggers slimmed to the `ml/` tree only.
- `references/notion-control-plane.md` — Notion is the organizational control plane (root page
  "Tailered Team Home"): goals, projects, decisions, releases, and AI governance metadata live
  there; GitHub stays authoritative for code, CI, and commit evidence. Machine-readable
  authority map: `config/tailered-os-control-plane.v1.json` (canonical Tailered OS Project,
  Command Center, Tasks/Projects databases, AI Systems Registry — enforced by
  `scripts/tailered-os-control-plane.mjs`). Production releases get a Release record with exact
  evidence links; owner decisions get a Decision record; PRs paste their Notion context URL into
  the PR template's "Notion context" section (the archived GitHub Sync integration no longer
  auto-relates them). Never mirror GitHub issues into Notion by hand, and never put secrets in
  Notion.

## Deploy law (IMPORTANT)

**Hosting: Railway serves the whole app** (Express serves API + built Vite client;
DNS on the custom domain points at Railway). Runbook: `references/railway-deploy.md` —
Dockerfile/`railway.json` build everything, with Debian Python for the model runners.
Railway auto-deploys on push to `main`. An earlier standalone frontend host was dropped
2026-07-11 (it was the planned frontend host mid-migration); the app is Railway-only now.
The legacy platform deployment has been retired (its runbook was removed from the repo
2026-07-23).
Schema changes always need the manual `db-push.yml` workflow before any code deploy.

## Repo conventions

- TypeScript strict; `npx tsc --noEmit` must pass (CI runs it with `NODE_OPTIONS=--max-old-space-size=6144`)
- Vitest suite requires GitHub Actions secrets (see `.github/workflows/ci.yml` header) — DB-dependent
  tests fail without `DATABASE_URL` etc.
- Never commit secrets. The `uploads/` folder inside `dime-ai/design-bundle/` contains personal
  reference material — do not redistribute it or ship it to production bundles.
- Sports-betting product: keep responsible-gaming language on marketing surfaces (21+, 1-800-GAMBLER).
