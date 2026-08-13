# PRX v1.1 collision matrix — tailered-ai/dime-ai

Generated 2026-08-13 (UTC) against `origin/main` = `249bf314c131e0f34aa0f1aae393411e4e8c8d55`.
Classifications: `ADDITIVE` (new path, no competing definition), `ADDITIVE-EDIT`
(existing file gains lines, no existing behavior removed), `NOT TOUCHED`,
`NOT NEEDED` (v1.0 proposal dropped in v1.1), `CONFLICTS` (requires resolution —
none remain unresolved).

## Path-level dispositions

| Proposed path | Class | Evidence |
| --- | --- | --- |
| `scripts/prx/` (pure libs, CLI entries, healthy fixtures, tests, scoped Stryker + Vale config) | ADDITIVE | `ls scripts/prx` → absent; convention precedent: `scripts/ci/` lane (libs + tests + fixtures) |
| `docs/verification/prx/` (standard doc + Section 14 evidence artifacts + `adversarial-fixtures/`) | ADDITIVE | absent; parent `docs/verification/` is the repo's verification home (AUDIT.md, ROLLOUT.md, evidence/); listed in CODEOWNERS but ruleset `require_code_owner_review=false` |
| `.github/workflows/14-prx-communication.yml` | ADDITIVE | numbered lane `01–13` occupied, `14-` free; `git grep -il prx` over tracked text files → only binary/font/base64 substring false positives |
| `package.json` (`prx:*` scripts + `mdast-util-from-markdown` devDependency) | ADDITIVE-EDIT | no `prx` scripts exist; `mdast-util-from-markdown@2.0.2` already in `pnpm-lock.yaml` via `react-markdown` — direct reference adds zero new packages |
| `pnpm-lock.yaml` | ADDITIVE-EDIT | same — importer entry only |
| `.github/pull_request_template.md` | NOT TOUCHED | live template is authoritative (SOL-PRX-003); v1.0's case-variant `PULL_REQUEST_TEMPLATE.md` is REJECTED and not shipped |
| `.gitmessage` | NOT NEEDED | absent today; v1.1 ships no hook and never silently edits git config, so a commit template file has no activation path |
| `tools/check-commit.mjs`, `tools/check-body.mjs` | NOT NEEDED | no `tools/` dir exists; superseded by `scripts/prx/` per repo convention |
| Root `.vale.ini` + `.vale/styles/` | NOT NEEDED | root config would ambiently govern every future `vale` invocation repo-wide; v1.1 scopes Vale at `scripts/prx/vale/.vale.ini`, invoked only with `--config` (ADDITIVE) |
| `commit-msg` hook / installer | NOT NEEDED | measured absence of any hook infrastructure (`.husky/` absent, `core.hooksPath` unset, no active `.git/hooks`); SOL-PRX-016 resolved by removing the hook claim; local surface = `pnpm prx:commit` / `pnpm prx:body` |
| `stryker.conf.json` | NOT TOUCHED | exists, scoped to money/settlement core, CODEOWNERS-listed; PRX mutation runs use separate `scripts/prx/stryker.prx.json` |
| Vale binary | NOT COMMITTED | downloaded at run time, checksum-verified against committed `vale-lock.json` pins (SOL-PRX-011); no opaque binary enters the repo |

## Rule-level collisions (measured against Phase 0 baselines)

| v1.0 rule | Measured live practice | v1.1 resolution |
| --- | --- | --- |
| Subject ≤ 50 chars (blocking) | 50/50 non-merge subjects exceed 50 (median 76.5, max 119) | Advisory-class only; advisory threshold 72; never blocks; graduation owner-gated |
| Capitalized imperative subject | 48/50 use conventional-commit `type(scope): subject`, lowercase after colon | v1.1 adopts the measured repo convention (conventional prefix) as the deterministic shape rule; Beams capitalization NOT adopted (recorded as EXTERNAL_ADAPTATION divergence) |
| Body wrap 72 (blocking) | 22/50 commits carry a body line > 72 (max 83) | Advisory-class; narrow exemption spans only (URL token, parsed trailer block) |
| Em-dash prohibition | 21/50 subjects and the repo's own governing docs use em dashes as house style | Advisory-class, designated-prose scopes only; conflict with the unverified "17-field writing system" recorded in the law registry as PROPOSED, owner decides |
| List/table/checkbox prohibition in PR bodies | Live template REQUIRES list fields (Tests) and checkboxes (Authorization); 9/10 sampled bodies use lists | Dropped. Structure is allowed everywhere the live template allows it. Structural-form detection (Unicode/blockquote/HTML/entity forms) is retained at library level as audit-class findings (fixtures B05–B08 prove detection) |
| v1.0 capsule + 7 generic sections replace the template | 14-section live template is the enforced contract; 2/10 sampled bodies carry all 14 | Body schema validates the LIVE 14 sections (exactly once, non-empty, "none" permitted where the template says so). The identifier capsule is OPTIONAL and governed-scope: absent = no finding; present = strict schema (exactly once, first visible block, six exact keys, value grammars, no narrative) |
| Mandatory Run-Id/Evidence trailers on all commits | 0/50 commits carry them; Co-Authored-By on 50/50 | Governed-scope predicate: trailer schema activates when a commit opts in (any governed trailer present) or when the caller passes `--governed`; Co-Authored-By grammar validated wherever present |

## Stop-condition assessment

No material collision lacks a safe additive resolution. No Section 4 stop
condition fires. Implementation may proceed.
