# T24 — P09 HARDENING acceptance evidence

Base `249bf314` · candidate `6aabf13c8fb7` (HEAD `fa70eeadd`) · contract
`b594ebd9` unchanged. HARDENING results carry `class:"HARDENING"` end to end
and are never merged into the PARITY verdict (registry law, AUD01).

## The four gates — every control green, every negative reddening

| Gate | Control | Negative | The class it closes |
| --- | --- | --- | --- |
| T02 deploy-order (**BLOCKING**, DEC-002) | PASS | NEG01: synthetic `drizzle/9999_*.sql` committed in a disposable candidate → FAIL naming the file and the db-push law | the 2026-08-05 #370 40-minute auth outage (migration-dependent code merged before the migration) |
| T03 schema-type-drift | PASS — drizzle-kit `generate` proven a genuine no-op | NEG02: one varchar length widened → FAIL with the emitted ALTER | migration-0134 (SchemaGuard checks column presence, not TYPE) |
| T04 knip @5.44.0 (ratchet) | PASS over `scripts/ci/**` | NEG03: a new unreferenced file → FAIL | dead files/exports/types; the verifier polices itself first |
| T05 a11y (ratchet) | PASS — 0 fresh serious/critical on the BUILT client, WCAG 2.0 A/AA | NEG04: injected low-contrast element → FAIL on `color-contrast` | accessibility regressions on public routes |

## What the gates' own bring-up caught (the negatives-first discipline)

1. **The drift gate's first control PASS was vacuous** — drizzle-kit mangles
   absolute `out` paths (`.//abs/...` ENOENT) and the crash read as a no-op.
   NEG02 refused to redden, exposing it. Fixed (worktree-relative out);
   control re-proven with tool output recorded.
2. **knip via dlx resolved TypeScript 7** (which drops
   `ts.getDefaultLibFilePath`) — both packages now version-pinned
   (`knip@5.44.0`, `typescript@5.9.3` = the repo devDependency).
3. **knip's drizzle plugin loads `drizzle.config.ts`**, which throws without
   `DATABASE_URL` — a syntactically-valid stub keeps the load side-effect-free
   (no DB contacted); NEG03's redden only counted after the control was green.
4. **DEF-064 (LOW, OPEN)**: the a11y gate's first honest run found a REAL
   pre-existing WCAG AA miss — `.state-pill--pass` landing-page contrast
   (serious, 1 node). Baselined under the documented ratchet
   (`a11y-baseline.json`: recorded, never hidden, new violations still red),
   queued in `GRADUATION-RISK-QUEUE.md` for UI-brand-law remediation.

## Identity discipline

axe-core 4.10.3 vendored and sha256-pinned
(`880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb`,
`vendor/VENDOR.md`); knip + typescript dlx-pinned; drizzle-kit is the repo's
own devDependency; Playwright is the repo's own dependency. No FROM, no
workflow, no required check, and no PARITY semantics were touched.

## AUD01

`hardening-registry.json` declares the law; every gate result object carries
`class: "HARDENING"`; the P03 reporter's class table keeps HARDENING in its
own row (visible in every roster summary since P06). No code path merges a
HARDENING verdict into a PARITY verdict.
