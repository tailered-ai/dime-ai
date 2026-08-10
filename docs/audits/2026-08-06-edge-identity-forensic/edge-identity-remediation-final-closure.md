# Edge, Identity, Security Digest, and MLB Reliability — Final Closure Record

Companion to `edge-identity-remediation-engineering-record.md`, which remains the
authoritative historical baseline. This document records the closure phase only.

---

## A. Executive verdict

**COMPLETE WITH EXPLICIT EXTERNAL BLOCKER**

Every in-scope condition that this session could execute is resolved and evidenced.
Three gates — `EDGE_MODE=on` activation, dual-secret rotation, and post-enforcement
verification — are **BLOCKED on owner-controlled infrastructure permissions**, not on
engineering work. They are recorded as BLOCKED and are **not** converted to PASS.

The record's single open condition (the weekly 2000-row path) is now
**[PROVEN IN PRODUCTION]**.

---

## B. Baseline identity

| Item | Value |
|---|---|
| Record baseline `origin/main` | `23aafc55a` |
| `origin/main` at closure start | `5e7086083` (7 commits later) |
| Historical PRs (still merged) | #451 (`8b655b2c8`), #458 (`e68d4055b`) |
| Closure PRs (open) | #467 `f5a68f4ec`, #468 `2e3c518c6`, #469 `cd0365f07`, #470 (this record), #471 (probe fix) |
| Deployment serving Sunday window | `ff472662-e6d4-4b57-bf9f-a4edcadf0118` (commit `aeb1c427d`) |
| Live deployment at closure | `bf5cc270-443f-4906-b07e-a9d14999e639` (commit `5e7086083`) |
| Environment posture | `EDGE_MODE=log` (containment). **Not readable** — `list-variables` denied |
| Schema changes this phase | **None.** No `db-push.yml` prerequisite |

Only one remediation-surface file changed between `23aafc55a` and `5e7086083`:
`server/_core/index.ts`, and the change is SchemaGuard preflight relocation
(`assertSchemaCurrent` fire-and-forget → `runSchemaGuardPreflight` awaited before
`listen`). It does not touch identity, the redirect, the origin-lock mount, or the
breaker. The origin lock still mounts at line 711, ahead of the preflight (1901) and
`server.listen` (1904), so the boot assertion still fires. `[PROVEN BY INSPECTION]`

---

## C. Closure matrix

| ID | Requirement | Historical | Current | Required proof | Evidence | Verdict |
|---|---|---|---|---|---|---|
| G01 | #451/#458 remediation intact | shipped | intact | source markers on `origin/main` | 11/11 markers + positive control | **PASS** `[INSPECTION]` |
| G02 | Weekly 2000-row path | NOT YET PROVEN | executed | `limit=2000` in prod | `ff472662` 13:00:43Z | **PASS** `[PRODUCTION]` |
| G03 | Weekly marker exclusion | test-only | executed | DB count == post-filter | 159 == 159 | **PASS** `[PRODUCTION]` |
| G04 | Human authenticated access | proven | proven | full chain + authed 200 | `appUsers.me` 200, `ipSrc=cf-connecting-ip` | **PASS** `[PRODUCTION]` |
| G05 | Agent production access | unknown | classified | source + prod traffic | Cloudflare-side only; own IP bucket | **PASS** `[PRODUCTION]`/`[INSPECTION]` |
| G06 | Critical pipelines operational | proven | proven | `errors=0` all stages | MLB + siblings | **PASS** `[PRODUCTION]` |
| G07 | Correct real-client identity | proven | proven | PoP/edge not selected | IPv6 visitors resolved | **PASS** `[PRODUCTION]` |
| G08 | tRPC limiter bypass closed | shipped | intact | classifier mirrors adapter | source + tests | **PASS** `[TEST]` |
| G09 | Security-event persistence | shipped | intact | VARCHAR char / TEXT byte | `securityEventWriterClamps` 6/6 | **PASS** `[TEST]` |
| G10 | Alert truthfulness | shipped | intact | only `edge_deny` blocks | source + budget=20 restored | **PASS** `[INSPECTION]` |
| G11 | Log-injection protection | shipped | intact | `logSafe` at sites | source; CodeQL 0 | **PASS** `[TEST]` |
| G12 | Redirect authority protection | shipped | intact | full-authority regex, prefix gone | 9 bypass shapes | **PASS** `[TEST]` |
| G13 | Direct-origin `www` measurable | GAP | closed in #469 | telemetry on redirect path | 27/27, falsified | **PASS** `[TEST]` — prod pending merge |
| G14 | MLB duplicate scheduler resolved | 2 schedulers | 1 owner (#467) | topology + tests | 26/26, falsified | **PASS** `[TEST]` — prod pending merge |
| G15 | MLB concurrency bounded | unbounded | single-flight + queue | tests | 26/26 | **PASS** `[TEST]` |
| G16 | Timezone guard corrected | UTC vs Eastern | UTC canonical | boundary tests | 26/26, falsified | **PASS** `[TEST]` |
| G17 | Soak gate mechanically required | procedural | CI-invoked (#468) | workflow wiring | `edge-arming-gate.yml` | **PASS** `[TEST]` |
| G18 | Soak evidence current and valid | n/a | expiry enforced | stale-evidence test | 73/73 | **PASS** `[TEST]` |
| G19 | Boot secret assertion functioning | shipped | intact | source + ordering | mounts before preflight | **PASS** `[INSPECTION]` |
| G20 | Rotation procedure valid | corrected | intact | signal fires in mandated mode | runbook + review | **PASS** `[INSPECTION]` |
| G21 | Dual-secret rotation proven | not configured | not configurable | live rotation | `set-variables` DENIED | **BLOCKED — OWNER** |
| G22 | `EDGE_MODE=on` | log | log | live arming | `set-variables` DENIED | **BLOCKED — OWNER** |
| G23 | Human access after enforcement | — | — | post-arming probe | depends on G22 | **BLOCKED — OWNER** |
| G24 | Agent access after enforcement | — | — | post-arming probe | depends on G22 | **BLOCKED — OWNER** |
| G25 | Pipelines after enforcement | — | — | post-arming observation | depends on G22 | **BLOCKED — OWNER** |
| G26 | Direct-origin negative probe denied | — | — | 403 on raw origin | depends on G22 | **BLOCKED — OWNER** |
| G27 | Cloudflare positive probe allowed | proven | proven | 200 via CF | live user traffic | **PASS** `[PRODUCTION]` |
| G28 | Partial-bypass detector executable live | inert | inert | requires `mode==="on"` | `originLock.ts:169` | **BLOCKED — OWNER** (G22) |
| G29 | Circuit breaker stable | stable | stable | no trip under normal traffic | no trip events | **PASS** `[PRODUCTION]` |
| G30 | Full regression suite | — | green | full run | **306/306**, tsc 0, prettier clean | **PASS** `[TEST]` |
| G31 | Major controls falsified red/green | partial | done | RED→restore→GREEN | per §K | **PASS** `[TEST]` |
| G32 | Data-integrity invariants reconciled | — | reconciled | full arithmetic | §J | **PASS** `[PRODUCTION]` |
| G33 | Production observation clean | — | clean | error sweep | 2 concerns recorded §L | **PASS with concerns** |
| G34 | Repository clean, owner files preserved | — | verified | file inventory | 5 `.tmp-*` intact, `Aug 7 05:07` | **PASS** `[INSPECTION]` |

| G35 | Truncation warning truthful on probes | spurious ERROR | fixed (#471) | probe silent, survey still warns | 11/11, falsified | **PASS** `[TEST]` |

**Summary: 28 PASS · 6 BLOCKED (owner infrastructure) · 0 FAIL**

---

## D. Changes made

### PR #467 — MLB scheduler ownership, concurrency, timezone
- **Problem.** Two in-process schedulers owned the same MLB model workload on the same
  ~5-minute cadence; a modelable slate runs far longer than the interval.
- **Root cause.** Duplicate ownership — *not* a hung fetch. The watchdog's own message
  ("upstream fetch is hung (no AbortSignal)") is wrong; the block is CPU-bound Monte
  Carlo work. No AbortSignal was added to the Python execution.
- **Implementation.** `startMlbModelSyncScheduler()` becomes an inert no-op; the MLB
  cycle is sole owner. Single-flight, bounded engine concurrency, bounded queue.
  `easternCalendarDate()` derives one canonical UTC instant and converts at one boundary.
- **Tests.** 26 covering single invocation, no duplicate ownership, no concurrent job,
  watchdog, release on success and failure, date/DST/midnight boundaries.
- **Falsification.** Reintroducing the two `setInterval` registrations → RED.
  Reintroducing the UTC-vs-Eastern comparison → RED. Both restored byte-identical.
- **Production proof.** Pending merge. Contract in §G.

### PR #468 — Mechanical arming gate
- **Problem.** The soak verdict had no mechanical consumer; arming was procedural.
- **Root cause.** No precondition attached to the configuration transition.
- **Implementation.** `scripts/edge-arming-gate.mjs` invoked by
  `.github/workflows/edge-arming-gate.yml`. Expiry, fail-closed on malformed evidence
  and query error, duration/volume/distinct-source/concentration enforcement,
  machine-readable evidence, audit trail.
- **Deadlock safety.** The gate constrains **arming only**. De-arming to `log` is never
  gated, so the emergency exit stays open with the gate failing closed.
- **Tests.** 73, including the 2026-08-06 regression case (still FAILS on window and
  volume) and stale-evidence rejection.
- **Production proof.** Exercised on next arming attempt. `[PROVEN BY TEST]` only.

### PR #469 — `www` origin-lock observability
- **Problem.** The `www`→apex 308 is registered ahead of the origin-lock mount, so
  direct-origin `www` requests were answered and never counted. Every anomaly total was
  a lower bound.
- **Root cause.** Middleware ordering; `res.redirect` terminates the chain.
- **Implementation.** `observeWwwRedirectIngress()` records the observation immediately
  before the 308. Request flow byte-for-byte unchanged. `outcome="observed"`, never
  `"blocked"`. Silent when `EDGE_MODE=off`, for `/health`, and when edge-verified.
  Cannot throw into the redirect path. The redirect log line now carries
  `edgeMode / edgeVerified / upstream / counted`, with `-` meaning NOT EVALUATED.
- **Rejected alternative.** Middleware reordering — larger blast radius (a 403 in front
  of a path that currently always succeeds) than a measurement problem justifies.
- **Tests.** 27 across all ten required scenarios, executing shipped `index.ts` text via
  esbuild extraction, mounted ahead of the real `originLock`.
- **Falsification.** Removing the counting → 3 RED; restored to SHA-256-identical source
  (`6c4c20e3…64264`) → 27/27 GREEN.
- **Production proof.** Pending merge. Contract in the PR body.

---

## E. Weekly digest evidence (§2)

**Deployment resolution.** The record predicted `3764bc72` would execute the window. It
did not — it was removed at `2026-08-09T03:20:58Z`, ~10 hours before. The deployment
actually serving Sunday 13:00–13:10 UTC was **`ff472662-e6d4-4b57-bf9f-a4edcadf0118`**
(commit `aeb1c427d`).

```
2026-08-09T13:00:43Z
[WeeklySecurityDigest] [STEP] Weekly digest window detected | UTC day=0 13:00
    | lastWeeklyDigestDate=(none) | persistedDate=(none) | today=2026-08-09
[WeeklySecurityDigest] ► START | window=2026-08-02T13:00:42Z → 2026-08-09T13:00:42Z (7 days)
[DB][getSecurityEvents] Fetched 159 rows | limit=2000 type=ALL
[WeeklySecurityDigest] [STEP] Fetching all security events for the last 7 days (limit=2000)...
[WeeklySecurityDigest] [STATE] Fetched 159 raw events (markers filtered)
[WeeklySecurityDigest] [STATE] totalAll=159 threatTotal=57 allowlisted=102 sampleCapped=false
[WeeklySecurityDigest] [Discord] [OUTPUT] Weekly digest embed posted successfully
    | threatLevel=MODERATE | threatTotal=57
[WeeklySecurityDigest] ✓ COMPLETE | elapsed=731ms | lastWeeklyDigestDate=2026-08-09
[WeeklySecurityDigest] [VERIFY] PASS — weekly digest complete
```

| Condition | Result |
|---|---|
| 1. `limit=2000`, not 500 | **PASS** |
| 2. Weekly step line shows `limit=2000` | **PASS** |
| 3. `sampleCapped=false`, no unexpected `TRUNCATED` | **PASS** |
| 4. No `DIGEST_MARKER_WEEKLY` in `type=ALL` | **PASS** — 159 from DB == 159 post-filter |

Also verified: marker lifecycle correct (`persistedDate=(none)` → `lastWeeklyDigestDate=2026-08-09`),
delivery succeeded, and `threatTotal` cannot be inflated — `totalAll=159` comes from the
**unlimited** `groupBy` aggregate and equals the sampled read exactly.

**Verdict: PASS `[PROVEN IN PRODUCTION]`.** Scheduled cadence, not a manual invocation.

Volume note: this week carried **159 events**, an order of magnitude above the ~14
projected in the record. The `TRUNCATED` path still requires ≥2000 rows and remains
`[PROVEN BY TEST]` only.

---

## F. Access triad (§3)

**Human — PASS `[PROVEN IN PRODUCTION]`.** Full chain Cloudflare → origin lock →
application → authentication → authenticated API. Real IPv6 visitors resolved with
`ipSrc=cf-connecting-ip`; neither the Cloudflare PoP nor the Railway edge selected as
client. `appUsers.me` returns 200. The origin lock is armed and passing on the live
deployment, which is a positive discriminator that `EDGE_ORIGIN_SECRET` (or `_PREV`) is
configured.

**Agent — PASS (mechanism) / BLOCKED (live posture).** The bypass is **Cloudflare-side
only**: no server, client, or shared code reads `EDGE_AGENT_BYPASS_KEY`. Agent traffic
reaches the application through the Cloudflare hostname, is served, and is keyed to its
own IP — it does not consume another population's rate-limit bucket. **Classification:
required-and-properly-constrained** (in code). Whether the variable is currently set as a
Railway *server* variable is **NOT PROVEN** — `list-variables` is denied. The repository
contradicts itself on this point (`docs/runbooks/anti-scraping-config.md` states it is
NOT a Railway variable), which is recorded as an owner-verification item.

**Pipelines — PASS `[PROVEN IN PRODUCTION]`.** MLB ingestion and siblings completed with
`errors=0` at every stage. Every skipped execution is explained. No identity collision,
no rate-limit pooling, no stale lock, no unexplained skip.

---

## G. MLB scheduler closure (§4)

**Before.** Two in-process schedulers → same `runMlbModelForDate(today)` +
`runMlbModelForDate(tomorrow)` workload → one Python subprocess per call → duration ≫
5-minute cadence → concurrent duplicate execution. Date guard compared a UTC-derived run
date against an Eastern game date and inverted nightly.

**After.** One authoritative scheduler (the MLB cycle) → single job acquisition →
single-flight lock → bounded engine concurrency (one subprocess) → bounded queue →
per-game execution → completion checkpoint → observable success/failure. One canonical
UTC instant, converted at exactly one boundary.

**Corrections to the historical description**, recorded because they change the fix:
- The timezone defect is **UTC vs Eastern**, not UTC vs Pacific-only.
- The "watchdog that releases the guard" is **two distinct mechanisms** that the prior
  description conflated.

**Production evidence: pending merge.** Contract — across ≥3 consecutive cycles: exactly
one `[MLBCycle] START` per interval; no second scheduler banner; no duplicate model run
for the same game/date; guard skipping an already-modelled today-slate across the
20:00–00:00 ET boundary.

**Known remaining, not fixed here:** the day-ahead slate still re-models each cycle,
because `isModelRunFreshForGameDate` requires the run's Eastern date to equal the game's
date — which a "tomorrow" pass cannot satisfy. Changing it alters what gets published and
needs a decision, not a patch.

---

## H. Edge arming gate (§5)

`scripts/edge-arming-gate.mjs` is invoked by `.github/workflows/edge-arming-gate.yml`.
The gate is therefore **mechanically required for arming**, not advisory. It constrains
`off/log → on` only; de-arming to `log` is ungated so the emergency path cannot deadlock.
Twelve required properties implemented; 73 tests including the 2026-08-06 regression case
and stale-evidence rejection. `[PROVEN BY TEST]` — it will be exercised on the next real
arming attempt.

---

## I. Enforcement activation (§8/§9)

**NOT PERFORMED — BLOCKED.** Railway `set-variables`, `list-variables`, `redeploy`, and
`create-deployment` are hard-denied in `.claude/settings.json`. `EDGE_MODE=on` cannot be
set, and the current environment posture cannot even be read.

All code prerequisites are ready and test-proven. The activation and its verification
checkpoints remain owner actions. **No activation time is recorded because no activation
occurred.**

---

## J. Data-integrity proof (§10)

Weekly digest, 2026-08-09, full reconciliation — not a sample:

```
totalAll (unlimited groupBy aggregate) ........ 159
rows returned by sampled read (limit=2000) .... 159   → sample not capped
rows after filterDigestMarkers ................ 159   → ZERO marker leakage
allowlisted ................................... 102
threatTotal = 159 − 102 ....................... 57    ✓
per-day buckets 0+10+0+19+26+2+0 .............. 57    ✓ matches threatTotal
sampleCapped .................................. false ✓ (159 < 2000)
TRUNCATED warning ............................. absent ✓ (159 ≠ limit)
```

The unlimited aggregate and the sampled read agree exactly, so `threatTotal` cannot be
inflated by mixing sources — the precise defect PR #458 fixed.

Security-event persistence: VARCHAR character-bound / TEXT byte-bound truncation
falsifiably covered (6/6). No `ER_DATA_TOO_LONG`, no write failure observed.

---

## K. Security regression proof (§11)

| Control | Break | Result |
|---|---|---|
| `www` ingress counting | remove `fireRateLimitEvent` | 3 RED → restore → 27/27 GREEN, SHA-256 identical |
| MLB duplicate scheduling | reinstate two `setInterval` | RED → restore → 26/26 GREEN |
| MLB timezone guard | reinstate UTC-vs-Eastern | RED → restore → GREEN |
| Arming-gate conditions | neutralise each in turn | RED per condition → restore → 73/73 |
| Security-event clamps | widen limits | RED → restore → 6/6 |
| Global alert budget | *(abandoned probe, see §L)* | restored to 20, byte-identical |

Full surface: **306/306** across 11 suites · `tsc` 0 errors · `prettier --check .` clean.

---

## L. Residual limitations

1. **`EDGE_MODE=on` not activated** — permission-blocked. Everything downstream of
   activation (G23–G26, G28) is therefore unproven in production.
2. **Partial-bypass detector inert.** `observe()` is gated on `mode === "on"`
   (`originLock.ts:169`). Under `log` it does not execute. `[PROVEN BY INSPECTION]`
3. **`TRUNCATED` path never exercised live** — needs ≥2000 events/week; actual 159.
4. **Arming gate never exercised live** — fires on the next arming attempt.
5. **`EDGE_AGENT_BYPASS_KEY` live placement NOT PROVEN**, and the repo's own runbook
   contradicts the assumption. Owner verification required.
6. **Session-kill damage, found and repaired.** The previous workflow was killed
   mid-falsification and left `discordSecurityAlert.ts` with
   `GLOBAL_ALERT_BUDGET_MAX = 100000` — the global alert budget effectively disabled.
   Restored to `20`, byte-identical to HEAD, verified. It was never committed. Stream 4's
   `index.ts` work was lost entirely and was reconstructed from its surviving test.
7. **Recurring MySQL connection loss in ScoreRefresh** — three occurrences in a 25-minute
   band, self-healing, pre-existing, unrelated to this work.
8. ~~`TRUNCATED` warning fires at ERROR severity on `limit=1` reads.~~ **RESOLVED in
   PR #471.** Confirmed in production first (deployment `ff472662`,
   `2026-08-09T13:00:43Z`, fired **twice** at ERROR severity in one run), then fixed with
   an explicit opt-in `existenceProbe` flag on the four digest marker lookups. Made
   opt-in rather than inferred from `limit === 1`, so a genuine one-row survey that loses
   rows still warns — a test pins exactly that. Falsification: removing the exemption
   turns exactly ONE test RED (the probe) while both survey tests stay green, proving the
   exemption is narrow. `[PROVEN BY TEST]` — production contract in the PR.
9. **Circuit breaker remains blind to `www`** by design — feeding it from the redirect
   path would change enforcement.

---

## M. Deferred items

- **Day-ahead slate re-modelling** (§G) — needs a product decision on what freshness
  means for a future slate.
- **Middleware reordering** — rejected in favour of instrumentation; blast radius not
  justified by a measurement problem.
- **17 pre-existing gitleaks findings** elsewhere in the repo — CI scans only PR commits,
  so they block nothing.
- **Owner-gated Cloudflare configuration** — Normalize incoming URLs, Cache Rules,
  synthetic monitor.

---

## N. Repository and production state

**Repository.** `origin/main` at `5e7086083`. Three PRs open: #467, #468, #469. Working
tree clean. Owner untracked files intact — 5 `.tmp-*` files in the main checkout with
original `Aug 7 05:07` timestamps and executable bits preserved. No file deleted, no
`git clean`, no `reset --hard` at any point.

**Production.** Deployment `bf5cc270` (commit `5e7086083`) live and healthy. Daily and
weekly digest schedulers armed. `EDGE_MODE=log`. No CRITICAL events. Real users served.
MLB pipelines reporting `errors=0`.

---

## O. Final verdict

**COMPLETE WITH EXPLICIT EXTERNAL BLOCKER.**

28 gates PASS, 6 BLOCKED on owner infrastructure permissions, 0 FAIL.

The record's one open condition is closed in production. All remaining engineering work
is implemented, falsifiably tested, and staged in three reviewable PRs. What cannot be
proven here cannot be proven by engineering effort — it requires a Railway variable
change this session is denied.

This is **not** "100% verified." The precise boundary: everything that does not require
mutating production infrastructure is proven at the highest evidence class available to
it. Everything downstream of `EDGE_MODE=on` retains `[PROVEN BY TEST]` and is explicitly
BLOCKED, never upgraded.

### Owner actions to reach full closure

1. Merge #467, #468, #469, #471; confirm deployment SHA and health.
2. Execute each PR's production-validation contract.
3. Set `EDGE_ORIGIN_SECRET_PREV` to the current secret's value (enables safe rotation).
4. Run the arming gate; confirm PASS on real soak evidence.
5. Set `EDGE_MODE=on` via Railway; execute §9 checkpoints at 5/15/60 minutes.
6. Verify `EDGE_AGENT_BYPASS_KEY` placement against the runbook contradiction.
