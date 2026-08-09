# Feed — compaction contrast + salience

**Branch:** `docs/mlb-status-comment-truth` · **PR:** #416 · **Date:** 2026-08-06
**Lead:** `impeccable` v4.0.4 (pin `ae5e951`) · **Surface:** `/feed`

> **OWNER AUTHORIZATION — 2026-08-06, full.** These are the two items the
> previous directive's scope fence deferred. Both are now approved, authorized,
> and fixed. The earlier fence is kept verbatim in the law with a RESOLVED note
> appended, so the record shows they travelled on their own decision rather than
> riding in on the previous approval.

## One cause, two symptoms

`.projection-card--compact` sets `opacity: 0.72`. Opacity composites the card
**layer** over the page, so page ground bleeds into the text *and* the card
background:

```
effective text = 0.72 × colour  + 0.28 × page
effective bg   = 0.72 × cardBg  + 0.28 × page
```

Everything below follows from that. The dim itself stays — it is owner directive
2026-07-23. What changes is how the text compensates for it.

**#1 — the light-theme LIVE mint missed its own target.** The rule existed
specifically to lift that label over 4.5:1, and its comment claimed it reached
"~4.8:1". Measured: **4.4969:1**, short by 0.003. Deepening the mix from 60% to
50% measures **5.0170:1**.

**#2 — the compaction remap overshot.** It pushed `--text-secondary` and
`--text-muted` all the way to `--foreground`, which composited settled cards to
10.10 dark / 8.79 light — *brighter than the bettable scheduled card* at 8.13 /
6.54. Salience ran backwards. Both tokens now resolve to a bounded mid tone via
`color-mix`: 82% of the foreground ink mixed toward the page ground. One rule
covers both themes, because `--foreground` and `--background` flip together —
so the same 82% is a light grey on dark and a dark grey on light. Achromatic by
construction, no new token, and no raw hex (the repo's X-HEX ratchet enforces
that last point, and caught a first attempt that used `#ffffff`/`#000000`).

**Why not simply revert the remap?** Because it exists for a reason. Reverting
to stock `--text-secondary` drops light-theme settled text to ~3.4:1 — a worse
failure than the one being fixed. The window is narrow: above 4.5, below the
scheduled card. The mid tone lands inside it.

## Measured, in a browser, against the built artifact

| | dark before | dark after | light before | light after |
|---|---|---|---|---|
| scheduled (bettable) | 8.1328 | 8.1328 | 6.5385 | 6.5385 |
| live | 6.2541 | 6.2541 | **4.4969** ✗ | **5.0170** ✓ |
| final / postponed / suspended | **10.0986** | **6.8497** | **8.7878** | **5.2683** |
| micro-labels on a settled card | 10.0986 | 6.8497 | 8.7878 | 5.2683 |

Before figures: [`rendered-proof-before-production.txt`](./rendered-proof-before-production.txt)
(captured against live production, i.e. the real pre-fix code).
After: [`rendered-proof-after.txt`](./rendered-proof-after.txt).

Two properties are hard-asserted by the gate, in both themes:

- **A — every status label clears 4.5:1.** All are normal text (14.05px at 1440,
  12.00px at 375, weight 600), so 4.5 is the correct floor, not 3.0. The gate
  asserts the size too, so a future type change cannot silently move the goal.
- **B — no settled card's labels exceed the scheduled card's.** Checked for the
  status slot *and* a second remapped element (`.summary__item dt`), which is
  how the fix is shown to reach every micro-label rather than only the status.

Baseline run against production: **13 failures** (1 × property A, 12 × property
B). After: **ALL CHECKS PASSED**.

## Scope

Only the two token declarations and the one mint percentage changed. The
`opacity: 0.72` dim, the card anatomy, the mint-rationing rules from #413, the
slate tier, and every layout property are untouched — the diff alters colour
resolution and nothing else.

## Gates

| Gate | Result |
|---|---|
| Baseline (production, pre-fix) | **13 failures** — the two defects, reproduced |
| Contrast + salience gate (post-fix) | **ALL CHECKS PASSED**, both themes |
| `npx tsc --noEmit` | clean |
| `npx prettier --check` | clean |
| `npx vitest run client/src` | see [`typecheck-tests.txt`](./typecheck-tests.txt) |
| build + boot + `smoke-deploy.mjs` | **10/10** — [`smoke.txt`](./smoke.txt) |
| impeccable detector | 3 warnings, all pre-existing `side-tab` |
| review-animations motion gate | **did not fire** — no motion property in the diff |

Three CSS-contract tests were added to `ProjectionCard.test.ts` so neither fix
can be silently reverted: the remap must not return to bare `--foreground`
(both tokens), the mint mix must be 50% and not 60%, and every remapped tone
must stay achromatic AND hex-free.

### A test bug caught before it could mislead

The achromatic guard first failed against correct CSS. The matcher was
`/color-mix\([^)]*\)/` — a character class cannot span the nested `var(...)`, so
it captured a truncated value and compared that. Rewritten to match whole
declarations. Worth recording: the same class of error (a matcher that silently
fails to see what it is checking) produced a vacuous pass in the #413 harness.

## Known issues

None outstanding on this surface. The three items carried since #409 are now all
closed: slate tier and mint rationing (#413), the stale `mlbScoreRefresh`
comments (#416), and these two (#416).

## Bundle completeness — noted 2026-08-08

Recorded rather than quietly fixed, because the honest move for a missing evidence
artifact is to say it is missing. Back-dating a `brief.yaml` and a `checklist.md` to
2026-08-06 would manufacture a record of process that did not happen — the exact
failure an evidence bundle exists to prevent.

**Two files the contract requires are absent here:** `brief.yaml` (the filled mission
this was built against) and `checklist.md` (MASTER.md Pre-Delivery Checklist,
item-by-item). See
[`evidence-bundle.md`](../../../.claude/skills/design-federation/references/evidence-bundle.md).

This bundle is the **only** post-federation one missing them. Surveyed on `main`
2026-08-08:

| Bundle | `brief.yaml` | `checklist.md` |
| --- | --- | --- |
| 2026-08-05-feed-card-status-evidence | ✅ | ✅ |
| 2026-08-05-feed-desktop-evidence | ✅ | ✅ |
| 2026-08-05-feed-mobile-evidence | ✅ | ✅ |
| 2026-08-05-splits-desktop-evidence | ✅ | ✅ |
| 2026-08-05-splits-mobile-evidence | ✅ | ✅ |
| 2026-08-06-feed-unplayable-evidence | ✅ | ✅ |
| **2026-08-06-feed-contrast-salience-evidence** | **❌** | **❌** |

(`2026-08-04-parlay-leg-cells` and `2026-07-11-dime-shell` predate the federation and
carry no `summary.md` either, so they are not comparable.)

**What is not lost.** The Lead, surface, PR, owner authorization, scope fence, gate
results and measured before/after all live in this file and in the four artifacts beside
it. What is genuinely missing is the *structured* form of two of them — specifically the
MASTER.md checklist walked item-by-item, which nothing else here substitutes for.

~~**Separately, a contract-vs-practice divergence worth the owner's attention:**
`screenshots/` is listed as required, and no bundle in the repo has one — 0 of 7.~~

**RETRACTED 2026-08-09 — that finding was wrong, and the error was mine.** There is no
divergence. `docs/audits/*-evidence/screenshots/` is **gitignored on purpose**
(`.gitignore:221`, "screenshots live on disk / in the PR body, never in git"), and the
contract says so itself two paragraphs above the contents table, under **PNG law**:
screenshots stay untracked and are attached to the PR body, while the markdown summary
and JSON sidecars are tracked. Confirmed with `git check-ignore`, which ignores
`docs/audits/<any>-evidence/screenshots/*.png`.

So "0 of 7 in git" is the policy working exactly as designed, not seven bundles failing a
gate. I read the contents table and missed the rule directly above it, then reported the
absence as systemic non-compliance without first asking whether it was intentional —
which is the one failure mode an evidence bundle is least allowed to have. Left visible
rather than deleted, because a retraction that erases itself teaches nothing.

**One wording correction in the same pass.** The table above compares *federated UI*
bundles. Two other post-federation bundles also lack `brief.yaml`/`checklist.md` —
`2026-08-06-kprops-sentinel-evidence` and `2026-07-26-nflverse-evidence` — and both are
correctly out of scope: the contract opens "A federated **UI** change is unfinished until
this bundle exists," and those two are an engineering data-integrity fix and a data audit
respectively, with no design Lead or surface. The claim holds for the set the contract
governs; "post-federation bundle" was the imprecise way to say "federated UI bundle".
