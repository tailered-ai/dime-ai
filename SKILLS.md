# SKILLS.md — skill corpus and triggering

Every skill source in this repo, wired so all harnesses see the same corpus. Audited via
pi's own resource loader (2026-08-01): **227 skills + 33 prompt templates load in pi, zero
duplicate names, zero diagnostics errors.** (+5 on 2026-08-05, not yet re-audited in pi:
`design-federation` + vendored `impeccable` + `engineering-federation` flat skills — all
gitignore-negated like `pi-harness`, impeccable pinned via its `VENDOR.md` — and the
`/ui-loop` + `/eng-loop` templates.) CLAUDE.md's arsenal table describes what each
collection contains; this file covers where they live and how they load and trigger.

## Sources

| Source                                                                                                   | Count | Claude Code          | pi                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/skills/` (flat: uipro, taste, phuryn PM, emil, anthropic, repo-specific…)                       | 102   | native               | `.pi/settings.json` `skills` (7 older uipro dirs excluded — superseded below)                                                                                             |
| `.claude/plugins-vendored/ui-ux-pro-max-skill/.claude/skills/`                                           | 7     | plugin               | settings (v2.11.0, newer than flat copies: 84 styles / 192 palettes / 74 fonts). Path must point INSIDE the plugin — pi skips dot-directories (`.claude/`) when recursing |
| `.claude/plugins-vendored/pm-skills/` (deanpeters)                                                       | 70    | plugins (55 enabled) | settings (all 70)                                                                                                                                                         |
| `.claude/plugins-vendored/dime-vendored/` (superpowers 14, mcp-server-dev 3)                             | 17    | plugins              | settings (figma removed 2026-08-11 — unused; see CLAUDE.md)                                                                                                               |
| `.claude/plugins-vendored/railway-skills/`                                                               | 1     | plugin               | settings                                                                                                                                                                  |
| `.agents/skills/` (universal: frontend-design, stripe-best-practices, architect-\*, advertising)         | 16    | **Read-path only**   | auto-discovered                                                                                                                                                           |
| Package `git:github.com/badlogic/pi-skills` (web search, browser automation, Google APIs, transcription) | ~8    | —                    | `.pi/settings.json` `packages` → `.pi/git/`                                                                                                                               |
| Package `git:github.com/anthropics/skills` (docx/pdf/pptx/xlsx, web artifacts)                           | ~15   | —                    | same                                                                                                                                                                      |
| `.claude/plugins-vendored/taste-skill/`                                                                  | 13    | plugin               | _skipped — exact duplicates of the flat copies_                                                                                                                           |

**`.agents/skills/` is NOT Skill-invocable in Claude Code (corrected 2026-08-07 — this row
previously said "native").** Nothing is registered as a Claude Code skill by virtue of living
there; the Skill tool cannot invoke a copy in that tree, so anything living only there must be
loaded with `Read <path>/SKILL.md`. That covers `architect-backend-systems`,
`architect-github-repos`, and the 12 advertising skills. Two names are still reachable from a
_different_ source — `stripe-best-practices` via the stripe plugin (`stripe:stripe-best-practices`)
and `frontend-design` via `.claude/skills/` — but note `frontend-design` is not in the roster
either, for its own reason. **The converse also fails: `.claude/skills/` membership is required,
not sufficient** (`review-animations` opts out with `disable-model-invocation: true`;
`frontend-design` has ordinary frontmatter and is still absent). Confirm the live roster before
marking anything invocable. Detail:
`.claude/skills/engineering-federation/references/routing.md`, "Invocation reality".

Known duplicate names: 5 phuryn/deanpeters collisions (`ansoff-matrix`,
`customer-journey-map`, `opportunity-solution-tree`, `porters-five-forces`,
`swot-analysis`) load from both trees in pi; pi is lenient (warns, loads). Either variant
is acceptable.

## Triggering (make skills fire intuitively)

- **Rule for every agent: if a skill plausibly applies — even 1% — invoke it before
  responding.** Process skills first (brainstorming, systematic-debugging, TDD,
  verification-before-completion), then domain skills (frontend-design, stripe, uipro).
- Claude Code: `Skill` tool / `/<command>`; superpowers' using-superpowers gate enforces
  the rule at session start.
- pi: skills are advertised in `<available_skills>` (name + description) so the model
  auto-selects by prompt match; explicit invocation is `/skill:<name>`. All 35
  `.claude/commands/*.md` are also loaded as `/` prompt templates (same `$ARGUMENTS`
  syntax) — `/ship`, `/stripe`, `/ui-build`, `/ui-loop`, `/eng-loop`, `/sp-*`, `/pm-*`, plus pi-native
  `/review` from `.pi/prompts/`.
- Embedded runtimes get no skill discovery — bake needed skill content into the
  `systemPrompt` passed to `createPiAgent()`/`runDimeAgent()`.

## Precedence

Dime brand law (`design-system/dime-ai/MASTER.md`) beats every skill's palette/font/motion
suggestions. Process skills govern how, not what. User/owner direction beats both.

The `design-federation` skill (`.claude/skills/design-federation/`, entry `/ui-loop`)
operationalizes this for UI work: one declared aesthetic Lead per surface, the brand-law
reading order, and an evidence bundle before any "done" claim. Its backend/infra sibling
`engineering-federation` (`.claude/skills/engineering-federation/`, entry `/eng-loop`)
does the same for production-boundary engineering: the vendored Production-Grade
Engineering Reference Architecture as control standard, repo law on top, and an evidence
record with a terminal outcome before any "done" claim.

## Importing into QM

QM (references/qm-harness.md) imports this repo as a **skill pack** — same Agent Skills
standard, scanned for `SKILL.md`. Canonical pack config: git URL of this repo with
`skillGlobs: [".agents/skills/**", ".claude/skills/**"]` and the 7 superseded flat uipro
dirs excluded (the same dedup `.pi/settings.json` applies). Private repo ⇒ the pack
credential's path allow-list must cover `/aisportsbettingcontact/`. QM audits pack
commits and handles name collisions at ingest.

## Adding skills

Drop a `<name>/SKILL.md` dir in `.agents/skills/` (all harnesses pick it up) or
`.claude/skills/` (add the path to `.pi/settings.json` if pi should see it). External
collections: `pi install -l <git|npm source>` (records into `packages`, auto-installs for
everyone on trust).
