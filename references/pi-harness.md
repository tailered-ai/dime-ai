# pi coding-agent harness

[pi](https://github.com/badlogic/pi-mono) is this repo's secondary coding harness alongside
Claude Code: a minimal terminal agent (read/write/edit/bash) extended per-project instead of
forked. Org fork for harness development: `yc-software/pi` (clone at `~/src/pi`; it has
diverged from upstream — treat the published npm package as the runtime, the fork as R&D).

## Install / update

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version          # 0.83.0 at adoption (2026-08-01)
pi update             # update pi itself
```

Auth: `ANTHROPIC_API_KEY` env var, or `/login` for subscription auth. Claude traffic can be
pointed at the Anthropic-compatible gateway the rest of the repo uses by exporting
`ANTHROPIC_BASE_URL` + key before launching pi (see CLAUDE.md "Claude traffic routing"); for
custom routing, add a provider in `~/.pi/agent/models.json`.

## What pi picks up in this repo

| Layer                | Source                                                                                                                                                                                                     | Mechanism                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Context              | `AGENTS.md` (root) — pi loads it INSTEAD of CLAUDE.md (first-match per dir)                                                                                                                                | auto-loaded from cwd + parents                                                     |
| Skills (universal)   | `.agents/skills/` — 16 skills                                                                                                                                                                              | auto-discovered                                                                    |
| Skills (full corpus) | `.claude/skills/` (99, minus 7 superseded uipro flats), vendored `ui-ux-pro-max-skill` (7, v2.11.0), `pm-skills` (70), `dime-vendored` (17: superpowers/mcp-server-dev), `railway-skills` (1)        | `skills` array in `.pi/settings.json` (paths relative to `.pi/`; `!path` excludes) |
| Skills (packages)    | `git:github.com/badlogic/pi-skills`, `git:github.com/anthropics/skills`                                                                                                                                    | `packages` array — auto-installed to `.pi/git/` on trust                           |
| Prompt templates     | all 27 `.claude/commands/*.md` (same `$ARGUMENTS` syntax) + pi-native `/review` in `.pi/prompts/`                                                                                                          | `prompts` array + auto-discovery                                                   |
| Model policy         | `defaultModel: claude-fable-5`, `enabledModels: [claude-fable-5, claude-opus-5, gpt-5.6-sol]`                                                                                                              | `.pi/settings.json`; policy law in `LLM.md`                                        |
| Extension            | `.pi/extensions/dime-guard.ts` — blocks destructive git (force push, reset --hard, clean -fd, checkout ., --no-verify), writes to `design-bundle/uploads/` and `.env*`; warns on `drizzle/**` (schema law) | auto-discovered; hot-reload with `/reload`                                         |
| Theme                | `.pi/themes/dime.json` — brand-law dark theme, mint `#45E0A8` accent, no purple/gold                                                                                                                       | `theme: "dime"` in settings                                                        |
| System append        | `.pi/APPEND_SYSTEM.md` — skill-triggering rule, model policy, ship law, verification rule injected into every session                                                                                      | auto-loaded                                                                        |
| Ship entry points    | `pnpm run pi` / `pi:ship [PR#]` / `pi:review` / `pi:rpc` / `pi:json`                                                                                                                                       | package.json scripts                                                               |
| Integrity gate       | `pnpm pi:audit` — deterministic audit of the whole foundation (context files, .pi paths, hooks, skill, entry points, model policy, gitignore, CLI loader census); runs in CI on every PR (typecheck job)   | scripts/pi-harness-audit.ts                                                        |

See `SKILLS.md` for the corpus map and known duplicate names. Pi has no MCP by design; use
CLI tools (`gh`, `railway`) via bash. Trade-off accepted deliberately: ~250 skills add
their name+description to every request (system-prompt cost for maximal auto-triggering).

## Trust

`.pi/settings.json` and project skills only load after the project is trusted:

- Interactive: pi prompts on first launch; `/trust` saves the decision (restart to apply).
- Non-interactive (`-p`, `--mode json`, `--mode rpc`): no prompt — pass `-a`/`--approve`
  to trust for that run, or the project resources are silently skipped.

## Usage patterns

```bash
pi                                  # interactive, full project wiring after trust
pi -p -a "Summarize server/routes"  # one-shot with project resources
pi --tools read,grep,find,ls -p -a "Review server/stripeWebhook.ts"   # read-only
pi -c                               # continue last session
pi --mode rpc                       # process integration (LF-delimited JSONL)
```

Skills invoke as `/skill:verify`, `/skill:livelab`, etc.; templates as `/ship <PR#>`,
`/stripe <task>`, `/ui-build <task>`, `/review [scope]`.

## Embedded runtime — pi-agent-core (server-side)

`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` (^0.83.0, pnpm deps) embed the
same agent stack in-process — the counterpart to `server/_core/dimeAgent.ts` (Claude Agent
SDK, which spawns Claude Code as a subprocess). Integration module:
`server/_core/piAgent.ts`.

| Export                                                                      | Use                                                                                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPiAgent({systemPrompt, model?, tools?, thinkingLevel?, sessionId?})` | Stateful `Agent` — `subscribe()` to `message_update` text deltas for SSE, `steer()`/`followUp()` queues, `abort()`                                  |
| `runPiAgent({prompt, ...})`                                                 | Run-to-completion; returns `{result, isError, numTurns, totalCostUsd, durationMs}` — same shape as `runDimeAgent()` so call sites can swap runtimes |
| `resolvePiAgentModel(ref?)`                                                 | Catalog model with gateway `baseUrl` override; accepts bare Anthropic id or `provider/id` (e.g. `openai-codex/gpt-5.6-sol`)                         |
| `PI_AGENT_APPROVED_MODELS`                                                  | Current-generation allowlist (LLM.md); `resolvePiAgentModel` throws outside it unless `DIME_ALLOW_LEGACY_MODELS=1`                                  |

Routing/auth: pi-ai's Anthropic provider reads `ANTHROPIC_AUTH_TOKEN` (Bearer) before
`ANTHROPIC_API_KEY` — the same order as `anthropicClient.ts` — and
`resolvePiAgentModel()` swaps the model's `baseUrl` to `ANTHROPIC_BASE_URL` when set, so
all pi-agent-core traffic follows the server's gateway routing with zero key plumbing.
The `openai` (OPENAI_API_KEY) and `openai-codex` (Codex OAuth) providers are registered
too, so `openai-codex/gpt-5.6-sol` resolves when those credentials exist.

Differences from the Agent SDK runner: pi-agent-core ships **no built-in tools** (define
`AgentTool`s with typebox schemas; throw on failure, never encode errors in content) and
no subprocess. Session persistence is in-memory; add
`@earendil-works/pi-storage-sqlite-node` if durable sessions are ever needed.
Default model follows `DIME_AGENT_MODEL` (claude-fable-5).

## Session sharing — pi-share-hf (private dataset)

Global CLI `pi-share-hf` + TruffleHog (brew) publish this project's pi sessions to the
Hugging Face dataset `taileredsports/dime-ai-pi-sessions` — **keep that dataset PRIVATE**;
these transcripts contain product code. Workspace `.pi/hf-sessions/` (gitignored) is
incremental. Pipeline per run:

```bash
pi-share-hf collect AGENTS.md CLAUDE.md SKILLS.md   # redact → TruffleHog → LLM review
pi-share-hf list --uploadable && pi-share-hf grep -i 'stripe|secret|token'
pi-share-hf upload --dry-run && pi-share-hf upload
```

The pipeline is fail-closed: any TruffleHog finding or failed/missing LLM review blocks a
session. Reviews bill the Anthropic key (pi default model). Reject anything doubtful with
`pi-share-hf reject <session.jsonl>`.

## Dime Chat provider ("pi")

`DIME_CHAT_LLM_PROVIDER` is `"pi"` (dimeChatModel.ts, owner direction 2026-08-01 — freeze
ended): `POST /api/dime/chat` serves through `runPiChat()` (piAgent.ts) — embedded
pi-agent-core, claude-fable-5, same system prompt/token budgets/validation/SSE contract as
the direct-SDK path, which stays wired as `"anthropic"`. `"dime1"` remains an inactive
scaffold behind ml/dime-1.0 release gates.

## Precedence (unchanged by harness choice)

Dime brand law (`design-system/dime-ai/MASTER.md`) beats skill output; deploy law
(`references/railway-deploy.md`) and the schema-before-code rule apply to anything pi
ships; never commit secrets. `.pi/npm/` and `.pi/git/` (project-local pi package installs)
are gitignored.
