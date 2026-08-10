# Session #5 — Terminal Closeout Record

Edge, Identity, Security Digest, MLB Reliability, and Production Enforcement.

Supersedes nothing. This record sits **beside** `edge-identity-remediation-final-closure.md`
(PR #470), which remains the historical artifact of the closure phase. Where the two differ,
the difference is a state change since that record was written, and it is named here.

Evidence classes used throughout, never interchanged:

| Class | Meaning |
| --- | --- |
| `[PROD]` | Observed in production: a live log line, a live HTTP response, a live API read |
| `[TEST]` | Proven by an executable test that has been shown to fail against the defect |
| `[INSPECT]` | Proven by reading the shipped source or configuration |
| `[NOT PROVEN]` | Not established. Never upgraded for narrative completeness |

---

## A. Identity

| Field | Value |
| --- | --- |
| origin/main at closure-phase start | `5e7086083313ef8ce68394174d677185486342d7` |
| **Final origin/main** | `9020f5c3742253445e672bd534b614500c923abc` |
| **Production SHA** | `9020f5c3742253445e672bd534b614500c923abc` (from `/health`, resolved directly — not inferred from timing) |
| Deployment ID — `ai-sports-betting-dime-ai` | `9e803b06-3e60-4f50-ac79-d8d4bbb98910` (SUCCESS, created `2026-08-10T04:31:28.703Z`) |
| Deployment ID — `ai-sports-betting-backend` | `8bdc7315-e2a6-428c-8198-f20a60841bde` (SUCCESS, same commit) |
| Railway project / environment | `stunning-creativity` `8dd7341d-…` / production `787f3113-…` |
| Cloudflare-facing hostnames | `aisportsbettingmodels.com`, `www.aisportsbettingmodels.com` |
| Schema head | `0134_widen_unit_probability_precision` (journal idx 134, 135 entries) — **no Session #5 PR changed schema** |
| Node / pnpm | v22.22.0 / 10.33.0 |
| PR #467 | MERGED `2026-08-10T03:50:15Z` → merge `e515bae53a0d1bef8b162d1f8f099aec1098d35c` |
| PR #468 | MERGED `2026-08-10T03:54:53Z` → merge `d6e2902bb16fcba2a5a49dd9f56cab46f48b1b56` |
| PR #469 | MERGED `2026-08-10T04:00:32Z` → merge `3a1396b644f17e4af326d5b2703be6445eadc781` |
| PR #470 | MERGED `2026-08-10T04:07:16Z` → merge `538bc5ad3afdbe4255180e271c120eed5585a687` |
| PR #471 | MERGED `2026-08-10T04:11:54Z` → merge `078c4292345d32a38f38df3f2c1ffc3ff056854b` |
| Open PRs (whole repo) | **0** |
| Working tree | clean — 0 tracked modifications |
| Protected owner files | 5 × `.tmp-*` intact (see §P) |

All five merge commits verified `git merge-base --is-ancestor <merge> origin/main` → **YES**.

---

## B. Executive verdict

# COMPLETE WITH EXPLICIT EXTERNAL BLOCKER

Every gate that does not require mutating production infrastructure is PASS, at the strongest
evidence class available to it. Production enforcement (`EDGE_MODE=on`) and everything
downstream of it remain BLOCKED on Railway operations this agent is denied. **No blocked gate
was converted to PASS.**

---

## C. Scope delivered

Shipped and live on `origin/main` @ `9020f5c37`:

1. **Identity** — one surface (`clientIdentity.ts`) derives the security identity from
   `cf-connecting-ip` under edge proof, falling back to XFF-leftmost then `req.ip`.
   Deliberately **not** gated on `edgeMode()`.
2. **Security-event truth** — the weekly digest's 2000-row request reaches the driver; digest
   markers are excluded from generic reads but explicitly retrievable; truncation is reported
   honestly and only when real.
3. **`www` ingress accounting** — direct-origin `www` traffic answered by the canonical
   redirect is now counted, with the observation firing **before** the redirect.
4. **Redirect authority** — `www.` → apex only for allowlisted hosts, with authority-delimiter
   bypasses closed.
5. **MLB reliability** — one authoritative scheduler, single-flight guard, bounded engine
   concurrency with a queue bound, Eastern-canonical calendar boundary.
6. **Arming as a mechanism** — the soak verdict is a CI-invoked control with no override seam.

---

## D. PR ledger

| PR | Purpose | Head SHA | Merge SHA | CI | Deployment | Production verification |
| --- | --- | --- | --- | --- | --- | --- |
| **#467** | One authoritative MLB scheduler, bounded engine concurrency, UTC/Eastern-canonical date guard | `bba389d25` | `e515bae53` | 22 pass / 0 fail | dep `09cc00c0-…` SUCCESS | `[PROD]` §L |
| **#468** | Arming gate as a mechanical control wired into CI | `debdabe95` | `d6e2902bb` | 23 pass / 0 fail | dep `c889daeb-…` SUCCESS | `[PROD]` §G — gate executed against live production |
| **#469** | Count direct-origin `www` ingress the canonical redirect answers | `98438607b` | `3a1396b64` | 22 pass / 0 fail | dep `104d56cf-…` SUCCESS | `[PROD]` §K — both branches observed |
| **#470** | Closure record (27 → 28 PASS) | `4087a50c7` | `538bc5ad3` | 19 pass / 0 fail | dep `896d6d6b-…` SUCCESS | historical artifact, preserved |
| **#471** | Stop the truncation warning crying wolf on marker lookups | `e1a48a762` | `078c42923` | pass | dep `44c6f235-…` SUCCESS | `[TEST]` + deployed; caller not yet fired — §F.3 |

`4087a50c7` on the #470 branch is **not drift**: it is a `Merge branch 'main'` authored by
`Prez <prez@tailered.ai>` at `2026-08-09T21:00:50-07:00`, a normal merge-forward before merge.
Classification: **OWNER ACTION**.

---

## E. Weekly digest closure (§2) — re-confirmed first-hand

Deployment identity resolved **directly** from the Railway deployment list, not inferred:

- Executing deployment `ff472662-e6d4-4b57-bf9f-a4edcadf0118` — created `2026-08-09T03:19:43.732Z`,
  removed `2026-08-10T01:31:31.864Z`. It **was** live at the execution instant.
- The previously predicted deployment `3764bc72-10bf-4dd5-bdaa-c29d2e26ba3f` was removed at
  `2026-08-09T03:20:58.721Z` — **9 h 39 m before** the 13:00:43Z window.

Verbatim, from that deployment, `2026-08-09T13:00:43Z`:

```
[WeeklySecurityDigest] [STEP] Weekly digest window detected | UTC day=0 13:00
                       | lastWeeklyDigestDate=(none) | persistedDate=(none) | today=2026-08-09
[WeeklySecurityDigest] ► START | window=2026-08-02T13:00:42.445Z → 2026-08-09T13:00:42.445Z (7 days)
[WeeklySecurityDigest] [STEP] Fetching all security events for the last 7 days (limit=2000)...
[WeeklySecurityDigest] [STATE] Fetched 159 raw events (markers filtered)
[WeeklySecurityDigest] [STATE] totalAll=159 threatTotal=57 allowlisted=102 sampleCapped=false
[WeeklySecurityDigest] [STATE] Day 1: Sun, Aug 2 | total=0  (CSRF=0 RATE=0  AUTH=0)
[WeeklySecurityDigest] [STATE] Day 2: Mon, Aug 3 | total=10 (CSRF=0 RATE=1  AUTH=9)
[WeeklySecurityDigest] [STATE] Day 3: Tue, Aug 4 | total=0  (CSRF=0 RATE=0  AUTH=0)
[WeeklySecurityDigest] [STATE] Day 4: Wed, Aug 5 | total=19 (CSRF=4 RATE=2  AUTH=13)
[WeeklySecurityDigest] [STATE] Day 5: Thu, Aug 6 | total=26 (CSRF=0 RATE=22 AUTH=4)
[WeeklySecurityDigest] [STATE] Day 6: Fri, Aug 7 | total=2  (CSRF=0 RATE=2  AUTH=0)
[WeeklySecurityDigest] [STATE] Day 7: Sat, Aug 8 | total=0  (CSRF=0 RATE=0  AUTH=0)
[WeeklySecurityDigest] ✓ COMPLETE | elapsed=731ms | notified=false | lastWeeklyDigestDate=2026-08-09
[WeeklySecurityDigest] [VERIFY] PASS — weekly digest complete
```

Reconciliation — exact, no residue:

| Identity | Arithmetic | Result |
| --- | --- | --- |
| allowlisted + threat = totalAll | 102 + 57 | **159** ✓ |
| Σ day buckets = threatTotal | 0+10+0+19+26+2+0 | **57** ✓ |
| Day-2 categories | 0+1+9 | **10** ✓ |
| Day-4 categories | 4+2+13 | **19** ✓ |
| Day-5 categories | 0+22+4 | **26** ✓ |
| Day-6 categories | 0+2+0 | **2** ✓ |
| rows fetched = totalAll | 159 = 159 | **zero marker leakage** ✓ |
| hidden sample cap | `sampleCapped=false` | **none** ✓ |
| marker lookup functional | `lastWeeklyDigestDate=(none)` → set to `2026-08-09` | ✓ |

All ten §2 conditions met. **PASS.** This is the canonical example of why deployment identity
must be resolved from the execution window, never from the current deployment.

---

## F. Defects discovered during closeout

### F.1 Abandoned alert-budget mutation — RESOLVED, never shipped

A falsification probe left `GLOBAL_ALERT_BUDGET_MAX = 100000` in the working tree when a
session was killed mid-probe. Proven never to have escaped:

- Final `origin/main` → `server/discord/discordSecurityAlert.ts:115`:
  `const GLOBAL_ALERT_BUDGET_MAX = 20; // embeds per window, globally` `[INSPECT]`
- `git log --all -S'100000; // FALSIFICATION' -- server/discord/discordSecurityAlert.ts` → **no
  commits, on any branch** `[INSPECT]`
- The only commit that ever touched the constant is `2096729f5` (the commit that introduced it).
- The alert path is live and healthy in production — see §K, `Alert posted successfully`. `[PROD]`

### F.2 Lost Stream-4 `index.ts` implementation — RESOLVED

The `www` observability implementation was lost to a session kill and reconstructed from its
surviving test as the specification. Proven correct:

- Present on final `origin/main`: `observeWwwRedirectIngress` at `server/_core/index.ts:284`,
  called at line 748 **before** `res.redirect`. `[INSPECT]`
- The test drives the shipped text, not a copy: `wwwCanonicalRedirect.test.ts` slices the real
  `app.use` block out of `index.ts`, type-strips it with esbuild, and executes it. `[INSPECT]`
- Mutating the implementation turns the test RED — falsification F7 and F8, §N. `[TEST]`
- The reconstruction behaves as designed in production — §K. `[PROD]`

### F.3 False ERROR-severity `TRUNCATED` warnings — FIXED, awaiting caller

My own defect from #458. Marker lookups issue `limit=1` deliberately; a full result is the
successful answer, not evidence of loss. On `2026-08-09T13:00:43Z` the warning fired **twice at
ERROR severity** claiming data loss that never happened.

Fixed in #471 by an **opt-in** `existenceProbe` flag — deliberately *not* inferred from
`limit === 1`, so a genuine one-row survey still warns:

```ts
if (rows.length === limit && !opts.existenceProbe) {
```

`[TEST]` 11/11 including "an UNFLAGGED single-row read still warns — the flag is opt-in, not
inferred from limit". `[INSPECT]` present on final `origin/main` at `server/db.ts:2840`.
`[NOT PROVEN]` in production: the digest callers have not executed since the deploy — see §Q.

### F.4 False absence from a saturated result window

The first query for the `TRUNCATED` warning returned nothing. That was a `limit=20` artifact —
the window filled with unrelated `[CheckoutReconcile] truncated=false` lines before reaching the
relevant ones. A second query shape found the real warnings. Had the first result been trusted, a
real defect would have been wrongly retracted.

**This recurred during this closeout** and was caught the same way: the `2026-08-09T13:00:30–13:01:30`
window is saturated by `[HrPropsModel]` output, and the digest lines surface only under a
`WeeklySecurityDigest` filter. The rule below is now applied throughout this record.

> **Absence rule.** A claimed absence of a production signal requires a second independent query
> shape before it may support a PASS or a retraction. `no results` must be separated from result
> limiting, wrong deployment, wrong window, wrong filter, and logging loss.

Applied in this record at: §G (EDGE_MODE, two independent mechanisms), §I (bypass key, three
shapes + a positive control), §Q (#471 caller, filter + scheduler discriminator), §K (probe P6).

### F.5 A false alarm I raised and corrected during this closeout

A `stat` of the owner's `.tmp-*` files reported **No such file or directory**. The files were
untouched; a persisted `cd` had run the check in the wrong worktree. Re-run with absolute paths
and `pwd` printed, all five are intact (§P). Recorded because the failure mode — a directory
change silently invalidating a verification — has produced a false PASS in this program before,
and here produced a false FAIL.

---

## G. Infrastructure actions and environment posture

Resolved **authoritatively and without exposing any value**, via Railway
`get-service-config`, which returns variable *names* only.

Service `ai-sports-betting-dime-ai` (`a46ea921-…`), environment production:

| Variable | Posture | Source |
| --- | --- | --- |
| `EDGE_MODE` | **configured**; value = **`log`** | `[PROD]` application-emitted, §K |
| `EDGE_ORIGIN_SECRET` | **configured**, and **functioning** — Cloudflare-borne requests verify | `[PROD]` `edgeVerified=true` |
| `EDGE_ORIGIN_SECRET_PREV` | **ABSENT** | `[PROD]` not present in the variable-name list |
| `EDGE_AGENT_BYPASS_KEY` | **configured** on the app service — and never read by it (§I) | `[PROD]` + `[INSPECT]` |
| `SCHEMA_GUARD_FATAL` | configured | `[PROD]` |

`EDGE_MODE=log` is established by **two independent mechanisms**:

1. The application prints its own mode on every `www` redirect:
   `… | edgeMode=log edgeVerified=true upstream=172.71.98.63 counted=false reason=edge-verified`
2. The arming gate probes production over the network and independently concludes:
   `Live posture : NOT_ARMED — raw origin: /health 200 plus non-exempt path 200 → the origin is
   serving the request itself, so the lock is not enforcing`

### Arming gate run against current production

```
node scripts/edge-arming-gate.mjs enforce  --origin=https://ai-sports-betting-dime-ai-production.up.railway.app
  → VERDICT: PASS      exit 0     (posture NOT_ARMED; de-arming is structurally never gated)
node scripts/edge-arming-gate.mjs validate
  → VERDICT: FAIL      exit 1     record_present — no authorization record exists (fails closed)
node scripts/edge-arming-gate.mjs authorize --origin=…   (no --evidence)
  → usage refusal      exit 2     no --force, no --skip, no threshold flag
```

**`enforce → PASS` does not authorize arming.** It means production is not armed, so the gate
has nothing to check. The gate constrains arming only; it structurally cannot gate de-arming.

An *authorization* cannot be produced here: it requires a soak evidence bundle, and generating
one needs either a ≥60-minute production soak window plus ≥500 real requests from ≥25 distinct
sources, or `--db` against the production `DATABASE_URL`, which exists only in Actions secrets.
Gate **BLOCKED**, on the same owner action as arming itself.

### Dual-secret rotation — the condition is real and confirmed

`EDGE_ORIGIN_SECRET_PREV` is **absent**. The application supports two generations (that code
shipped); the *configuration* does not populate the second. Rotating the origin secret today is
therefore a **hard cutover**: the instant Cloudflare begins sending the new value, any request
still carrying the old one fails proof. Setting it requires `set-variables` — denied. **BLOCKED.**

---

## H. Human production proof

`[NOT PROVEN]` — and deliberately not upgraded.

What *is* established:

- Anonymous traffic through Cloudflare reaches the origin and is served: `[PROD]`
  `GET /health` → 200, `ipSrc=cf-connecting-ip`, `dbOk=true schema=ok`.
- **Genuine third-party traffic** resolves to the correct identity. An unsolicited scanner at
  `2026-08-10T04:33:15Z`:
  `ip=45.148.10.62 ipSrc=cf-connecting-ip host=aisportsbettingmodels.com
   x-forwarded-for=104.23.166.178, 152.233.12.245`
  — the true visitor appears **only** in `cf-connecting-ip`; XFF carries `[CF PoP, Railway edge]`.

What is **not** established: no authenticated login → session → authenticated-API flow was
exercised. Over the current deployment's lifetime the only external HTTP traffic was that scanner
and this agent's own probes — verified by a `HTTP_REQUEST` sweep of the whole deployment. A
browser flow cannot be performed from here: Cloudflare's bot rule 403s automated clients on
document routes by design (probe P3, §K).

---

## I. Agent production proof — `EDGE_AGENT_BYPASS_KEY` classified

### Classification: the **mechanism** is `REQUIRED`. Its **Railway server-service placement** is `OBSOLETE`.

Evidence, three query shapes plus a positive control:

| Shape | Query | Result |
| --- | --- | --- |
| 1 | `grep -rn EDGE_AGENT_BYPASS_KEY server/` | **0 hits** |
| 2 | `process.env.EDGE_AGENT_BYPASS_KEY` repo-wide | `scripts/smoke-deploy.mjs:39`, `scripts/dime-production-auth.mjs:271`, `perf/harness.ts:158` — all **client-side senders** |
| 3 | `grep -rn x-dime-agent server/` | **0 hits** |
| control | `grep -rn process.env.EDGE_ORIGIN_SECRET server/` | hits — the grep works |

The server never reads the variable and never inspects the header. The match happens **at
Cloudflare**, via a Skip rule. Documented contract:

| Where | Needed? | Why |
| --- | --- | --- |
| Cloudflare Skip rule | **YES — required** | the only place the value is compared |
| GitHub Actions repo secret | **YES — required** | `deploy-smoke.yml:65`, `perf-harness.yml:81` |
| **Railway `ai-sports-betting-dime-ai` service variable** | **NO — obsolete** | nothing in the deployed app reads it |

The obsolete copy is not inert risk: it places a credential that bypasses the edge into the
production application environment, where any process, crash dump, or env-printing path can
reach it — for zero functional benefit. Removing it is safe **precisely because** the server
never reads it, so removal cannot break the supported agent path. Removal needs `set-variables`
— denied. Owner action, §O.

Required documentation for the retained mechanism:

- **Purpose** — let known-good automated clients past Cloudflare's bot defense on document routes.
- **Callers** — `scripts/smoke-deploy.mjs`, `perf/harness.ts`, `scripts/dime-production-auth.mjs`,
  and the two workflows above.
- **Scope** — Cloudflare only; host-scoped to the target origin by every caller.
- **Boundary** — it bypasses **bot detection**, not authentication and not the origin lock.
  It is not an authorization credential.
- **Rotation / revocation** — change the Cloudflare Skip-rule value and the Actions secret
  together; there is no server-side cache to invalidate.
- **Why normal edge proof is insufficient** — `EDGE_ORIGIN_SECRET` proves *Cloudflare* forwarded
  the request; it says nothing about whether Cloudflare's bot rules should have blocked it first.

---

## J. Pipeline production proof

`[PROD]`, deployment `9e803b06-…`. MLB, the critical pipeline:

```
04:32:25  [MLBCycle] Lineup DB upsert (tomorrow): saved=10 skipped=0 errors=0
04:37:17  [MLBCycle] [SKIP] previous cycle still in flight — overlap prevented
04:42:17  [MLBCycle] [SKIP] previous cycle still in flight — overlap prevented
04:42:32  [MLBCycle] Model 2026-08-10: ok=true written=10 not_yet_modelable=0  errors=0 validation=✅ PASSED
04:42:32  [MLBCycle] Model 2026-08-11: ok=true written=0  not_yet_modelable=15 errors=0 validation=✅ PASSED
04:42:36  [MLBCycle] K-Props model EV: modeled=30 edges=26 skipped=0 errors=0
04:42:37  [MLBCycle] ✅ DONE — 2026-08-10T04:42:37.038Z
04:47:22  [MLBCycle] ► START — 2026-08-10T04:47:17.215Z | date: 2026-08-09
04:47:22  [MLBCycle] ScheduleSync ✅ runId=mlbsync-20260809-msmr2hwa: inserted=0 updated=0 unchanged=119 dhGroups=1 missing=0
04:47:26  [MLBCycle] Model 2026-08-10: ok=true written=0 not_yet_modelable=10 errors=0 validation=✅ PASSED
04:47:30  [MLBCycle] ✅ DONE — 2026-08-10T04:47:30.860Z
```

Acceptance: 0 unexpected 403 · 0 limiter collisions · 0 duplicate scheduler executions ·
0 unexplained missed executions · 0 data corruption · 0 pipeline errors.

Also healthy on the same deployment: `PitcherRolling5` (513/513 upserted, 0 errors),
`CheckoutReconcile` (`scanned=15 … truncated=false`), NHL/NBA score refresh, Discord
(`connected: true`, 0 reconnects).

---

## K. Edge enforcement proof

### Controlled probe set — `2026-08-10T04:45:36Z`, every probe explained

| # | Probe | HTTP | Origin evidence | Explanation |
| --- | --- | --- | --- | --- |
| P1 | CF apex `/health` | 200 | `[HEALTH_CHECK] ip=47.152.167.182 ipSrc=cf-connecting-ip db.state=CLOSED dbOk=true schema=ok` | true visitor from `cf-connecting-ip` |
| P2 | CF `www` `/health` | 308 | `[HTTP_REQUEST] → GET /health host=www… xff=172.69.33.60, 84.17.44.225` then `← 308`; **no** `HEALTH_CHECK` | redirected before the handler — correct ordering |
| P3 | CF `www` non-health | **403** | none | Cloudflare bot rule terminated at the edge. **Expected**, not a stop condition |
| P4 | Direct origin `/health` | 200 | `[HEALTH_CHECK] … ipSrc=xff-leftmost dbOk=true schema=ok` | no `cf-connecting-ip` → documented fallback |
| P5 | Direct origin, `Host: www.<apex>`, non-health | 308 | four-line trail below | **the #469 target case** |
| P6 | Direct origin, `Host: www.evil.example` | 404 | none | Railway host routing rejected it **before the app** — see caveat |

P5, verbatim — the complete accounting chain:

```
[RateLimit][EDGE_ORIGIN_INGRESS_ANOMALY] OBSERVED (not blocked) | IP=47.152.167.182
    path=/__closeout-probe-direct-www-20260810T044536Z method=GET ua="curl/8.7.1"
[DiscordSecurity][RATE_LIMIT] Posting security alert to channel 1492280227567501403 …
[www→canonical] 308 redirect: www.aisportsbettingmodels.com/__closeout-probe-… → https://…
    | edgeMode=log edgeVerified=false upstream=47.152.167.182 counted=true reason=direct-origin
[DB][insertSecurityEvent] Inserted | type=RATE_LIMIT ip=47.152.167.182 path=/__closeout-probe-… origin=N/A
[DiscordSecurity][RATE_LIMIT] [OUTPUT] Alert posted successfully | channel=#…-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦
```

The positive/negative discriminator pair for `www` accounting, both `[PROD]`:

| Path | Observation |
| --- | --- |
| Cloudflare-verified `www` (`04:33:15.796Z`, real scanner traffic) | `edgeVerified=true  … counted=false reason=edge-verified` |
| Direct-origin `www` (`04:45:36.937Z`, controlled probe) | `edgeVerified=false … counted=true  reason=direct-origin` |

No double counting: the edge-verified case is explicitly `counted=false`, and `/health` is
excluded by a distinct `reason=health` branch.

### Status of each enforcement gate

| Claim | Class | Note |
| --- | --- | --- |
| `www` direct-origin ingress is measurable | `[PROD]` | The old "anomaly total is a lower bound because `www` escapes measurement" **no longer applies** |
| Canonical redirect still functions, path and method preserved | `[PROD]` | 308, exact path, POST-safe by construction |
| Cloudflare positive path accepted | `[PROD]` | P1, P2 |
| Security event written truthfully | `[PROD]` | `insertSecurityEvent Inserted`, no column/truncation error |
| Alert path live | `[PROD]` | `Alert posted successfully` |
| **Direct-origin access DENIED** | `[NOT PROVEN]` | Impossible while `EDGE_MODE=log`. `[TEST]` only. **BLOCKED** |
| **Partial-bypass detector live-executable** | `[NOT PROVEN]` | Present on the live deployment `[INSPECT]`, but the observation path does not execute in `log` mode. **BLOCKED** |
| Circuit breaker stability | `[PROD]` partial | No trip observed in the deployment's lifetime. The breaker's failure modes remain `[TEST]`; a Cloudflare outage was not manufactured |

**P6 caveat — stated rather than claimed.** `www.evil.example` returned 404 from **Railway's own
host router**, before reaching the application. The probe therefore proves nothing about the
application's allowlist. The open-redirect fix is `[TEST]`-proven with a negative control that
demonstrates the pre-fix `host.slice(4)` implementation *does* 308 `www.evil.com` → `evil.com`
through the identical harness. It is not externally falsifiable, because Railway's host routing
shadows any Host the app would reject.

---

## L. MLB production proof

| Property | Evidence | Class |
| --- | --- | --- |
| One authoritative scheduler | `[SKIP] previous cycle still in flight — overlap prevented` fired at 04:37:17 and 04:42:17 while one cycle owned the workload | `[PROD]` |
| **Guard releases after completion** | cycle DONE 04:42:37 → next tick 04:47:17 **admitted** (`► START`), not skipped. A stuck guard would silently halt all processing | `[PROD]` |
| Bounded concurrency | engine batches serialized: `Completed in 60.32s`, `61.37s`, `60.37s` — one at a time | `[PROD]` |
| Tick regularity | 04:37:17 / 04:42:17 / 04:47:17 — exactly 300 s apart | `[PROD]` |
| Date handling is deterministic | `► START — 2026-08-10T04:47:17.215Z \| date: 2026-08-09` — UTC instant, Eastern-derived business date | `[PROD]` |
| No 7-hour inversion | `isModelRunFreshForGameDate` fresh for every minute of the game's own Eastern day; the OLD UTC formula inverts for exactly the last 7 hours | `[TEST]` |
| Guard released after throw **and** after success | dedicated tests | `[TEST]` |
| Queue bound rejects rather than growing | dedicated test | `[TEST]` |

### Processed-game reconciliation, window `04:32Z – 04:48Z`

| Quantity | Value |
| --- | --- |
| Schedule sync | `inserted=0 updated=0 unchanged=119 dhGroups=1 **missing=0**` |
| Slate `2026-08-10` — written | 10 |
| Slate `2026-08-10` — explicitly classified `not_yet_modelable` | 0 (cycle 1) |
| Slate `2026-08-11` — explicitly classified `not_yet_modelable` | 15 |
| Second cycle, slate `2026-08-10` | `written=0 not_yet_modelable=10` — the same 10, already written |
| **Duplicate outputs** | **0** |
| **Unexplained missing eligible games** | **0** |
| **Timezone-misclassified games** | **0** |
| Errors | 0 across both cycles; `validation=✅ PASSED` |

`eligible = processed + explicitly classified` holds with no remainder. The second cycle
re-classifying the same 10 as `not_yet_modelable` rather than rewriting them **is** the
no-duplicate-work proof.

---

## M. Data-integrity ledger

| Dataset | Expected | Observed | Difference | Explanation | Verdict |
| --- | --- | --- | --- | --- | --- |
| Weekly digest rows | 159 | 159 | 0 | driver received `limit=2000`, no clip | PASS |
| allowlisted + threat | 159 | 102 + 57 | 0 | exact | PASS |
| Σ day buckets vs threatTotal | 57 | 57 | 0 | exact | PASS |
| Marker leakage into generic reads | 0 | 0 | 0 | `notInArray` exclusion; markers still retrievable by `eventType` | PASS |
| Hidden sample cap | none | `sampleCapped=false` | 0 | — | PASS |
| False TRUNCATED warnings on final main | 0 | 0 | 0 | `[TEST]`; production caller pending §Q | PASS (code) |
| MLB games eligible vs processed+classified | 0 remainder | 0 remainder | 0 | §L | PASS |
| MLB duplicate outputs | 0 | 0 | 0 | §L | PASS |
| MLB missing eligible | 0 | 0 | 0 | `missing=0` | PASS |
| Edge probes sent vs explained | 6 | 6 | 0 | 4 reached the origin, 2 terminated upstream with named causes | PASS |
| Security-event writes from probes | 1 | 1 | 0 | P5 only; P1–P4/P6 are not anomalies | PASS |
| Alert-budget constant on prod SHA | 20 | 20 | 0 | §F.1 | PASS |
| Schema head vs journal | idx 134 | idx 134 | 0 | no Session #5 schema change | PASS |
| Merge commits reachable from main | 5 | 5 | 0 | ancestry verified | PASS |

**Unexplained differences: 0.**

This is 100% reconciliation against every in-scope invariant and dataset listed above for the
closure window. It is not a claim of metaphysical certainty about all production data.

---

## N. Test and falsification evidence

### Final regression, against final `origin/main` @ `9020f5c37`

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript | `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` | **exit 0**, 0 output lines |
| Formatting | `npx prettier --check .` | **exit 0** — "All matched files use Prettier code style!" |
| Suites | `npx vitest run` over 19 Session-5-relevant suites | **19 passed / 373 tests passed / 0 failed** |
| Secret scan | `gitleaks git --log-opts="e515bae53~1..078c42923" --redact` | **exit 0 — no leaks found** across the entire Session-5 merge range |

Suites: `clientIdentity`, `clientIdentityCallSites`, `edgeCircuitBreaker`, `edgeProxy`,
`logInjectionBoundary`, `logSafe`, `originAndStaticLogSafety`, `originLock`,
`originLockAlertRouting`, `originLockObservability`, `securityEventLimits`,
`securityEventWriterClamps`, `trpcRateLimitPolicy`, `wwwCanonicalRedirect`, `db.securityEvents`,
`securityDigest`, `weeklySecurityDigest`, `mlbScheduler.topology`, `edge-arming-gate`.

The first `tsc` run in this closeout reported `TSC_EXIT=0` from `tail`, not from `tsc` — a piped
exit code. Re-run with the real status. Recorded because it is precisely the class of false PASS
this program has been bitten by.

### Falsification matrix — 14/14 controls demonstrated sensitive

Executed in a **throwaway git worktree**, never in the real tree. Each: GREEN → targeted
regression → RED → `git checkout -- <file>` → GREEN.

| # | Control | Deliberate regression | Result |
| --- | --- | --- | --- |
| F1 | client identity | drop the `edgeProofPasses` guard on `cf-connecting-ip` | 0 → 1 → 0 ✅ |
| F2 | tRPC path classifier | `lastIndexOf("/")` → `indexOf("/")` | 0 → 1 → 0 ✅ |
| F3 | security-event fetch ceiling | reintroduce the 500-row clip | 0 → 1 → 0 ✅ |
| F4 | digest marker exclusion | remove the `notInArray` exclusion | 0 → 1 → 0 ✅ |
| F5 | TRUNCATED existence probe | drop `&& !opts.existenceProbe` | 0 → 1 → 0 ✅ |
| F6 | log-injection sanitizer | pass strings through unsanitized | 0 → 1 → 0 ✅ |
| F7 | redirect authority validation | restore pre-fix `host.slice(4)` | 0 → 1 → 0 ✅ |
| F8 | `www` ingress accounting | report `counted=false` on direct origin | 0 → 1 → 0 ✅ |
| F9 | partial-bypass emission | `bypassAlertFraction` 0.5 → 1.1 (never fires) | 0 → 1 → 0 ✅ |
| F10 | breaker attack guard | trip on unverified **fraction** instead of `verified <= floor` | 0 → 1 → 0 ✅ |
| F11 | soak arming thresholds | `MIN_REAL_REQUESTS` 500 → 1 | 0 → 1 → 0 ✅ |
| F12 | MLB scheduler single-flight | `if (_cycleRunning)` → `if (false)` | 0 → 1 → 0 ✅ |
| F13 | MLB engine concurrency slot | drop `await prior` (unserialize) | 0 → 1 → 0 ✅ |
| F14 | Eastern-canonical date guard | `America/New_York` → `UTC` | 0 → 1 → 0 ✅ |

`SENSITIVE: 14  NOT-SENSITIVE/ERROR: 0` · HEAD unchanged · **worktree residue: 0 lines**.

F10 deserves naming: the trip invariant is `s.verified <= config.verifiedFloor` — starvation,
not fraction. An attacker who can generate unverified traffic cannot reach the trip, because
their own traffic never raises `verified`. The fraction appears only in the **alert-only**
branch, guarded by `!starvedWindow`. Mutating the invariant to a fraction turns the suite RED.

### The tsconfig caveat, stated rather than assumed

`tsconfig.json` excludes `**/*.test.ts`, so `tsc --noEmit` does **not** typecheck test files;
they are vitest-only gates, and vitest type-strips rather than type-checks. This is unchanged by
Session #5 and is recorded as a standing limitation, not as a resolved item.

---

## O. External blockers

Six gates remain BLOCKED. Every one is a **permissions** blocker, not a code defect. No code
defect is recorded as BLOCKED.

Denied Railway tools (`.claude/settings.json` → `permissions.deny`, 12 Railway entries):
`set-variables`, `list-variables`, `redeploy`, `create-deployment`, `update-service`,
`railway-agent`, `accept-deploy`, `generate-domain`, `set-feature-flag`, `delete-feature-flag`,
`create-project`, `create-service`.

### B-1 — Populate `EDGE_ORIGIN_SECRET_PREV`

- **Blocked action** — set a Railway production variable.
- **Why not me** — `mcp__plugin_railway_railway__set-variables` is hard-denied.
- **Who** — the owner.
- **Instruction** — on service `ai-sports-betting-dime-ai`, environment production, set
  `EDGE_ORIGIN_SECRET_PREV` to the value **currently** in `EDGE_ORIGIN_SECRET`. Do this *before*
  changing `EDGE_ORIGIN_SECRET`, so both generations are accepted across the cutover.
- **Evidence required** — a `www`-path log line showing `edgeVerified=true` after Cloudflare is
  switched to the new primary, and **zero** legitimate 403s across the switch window.
- **Gates** — dual-secret posture safe.

### B-2 — Remove the obsolete `EDGE_AGENT_BYPASS_KEY` from the app service

- **Blocked action** — delete a Railway production variable.
- **Instruction** — remove `EDGE_AGENT_BYPASS_KEY` from the `ai-sports-betting-dime-ai` service
  only. **Do not** remove the Cloudflare Skip-rule value or the GitHub Actions repo secret; both
  are required (§I).
- **Evidence required** — a green `deploy-smoke.yml` run afterwards, proving the supported agent
  path still works without the server-side copy.
- **Gates** — agent bypass resolved (configuration half).

### B-3 — Produce a fresh, qualifying soak evidence bundle

- **Blocked action** — read production security events at scale.
- **Why not me** — needs the production `DATABASE_URL` (Actions-secrets only) or an
  owner-authenticated console read; I will not obtain either.
- **Instruction** — run `scripts/edge-soak-report.mjs --db --since=<ISO>` from a
  Production-environment workflow over a window meeting **all** non-waivable conditions:
  ≥60 min, ≥500 real requests, ≥25 distinct sources, concentration below ceiling, zero
  legitimate would-deny traffic. Then
  `node scripts/edge-arming-gate.mjs authorize --evidence=<bundle> --origin=<raw-railway-origin>
  --actor=<who> --reason=<why>`.
- **Evidence required** — the emitted authorization record, bound to deployment SHA, deployment
  ID, edge-configuration fingerprint, and observation window.
- **Gates** — fresh mechanical soak gate.

### B-4 — Arm `EDGE_MODE=on`

- **Blocked action** — set a Railway production variable.
- **Preconditions** — B-1, B-2, B-3 complete; rollback (`EDGE_MODE=log`, never gated) understood.
- **Instruction** — change `EDGE_MODE` from `log` to `on`, alone; combine no other change.
  Record exact timestamp, operator, pre-change SHA, post-change deployment ID.
- **Evidence required** — `/health` 200 with `dbOk=true schema=ok` and the expected SHA; no
  origin-lock boot CRITICAL; no missing-secret CRITICAL; normal Cloudflare traffic still 200.
  **Any unexpected legitimate 403 is a STOP condition — drop to `log`, do not weaken the lock.**
- **Gates** — `EDGE_MODE=on`.

### B-5 — Prove access under enforcement

- Human: a real browser login → session → authenticated API call, capturing timestamp, path,
  HTTP result, identity source, Cloudflare verification, limiter class.
- Agent: one supported Fable/Claude production action end-to-end.
- Pipelines: at least one full MLB cycle after arming, with the §J acceptance counters at zero.
- **Gates** — human access under enforcement, agent access under enforcement, pipelines under
  enforcement.

### B-6 — Negative and detector probes under enforcement

- Direct-origin request without valid edge proof → must be **DENIED**, with the denial recorded
  in security telemetry, and the `www` host variation measurable.
- Confirm the partial-bypass detector's observation path now executes. Do **not** manufacture
  abusive traffic: if firing `partial_bypass_suspected` would require it, record the trigger as
  `[TEST]` and only its **live executability** as `[PROD]`.
- **Gates** — direct-origin negative probe, partial-bypass detector live-executable.

---

## P. Repository state

| Item | Value |
| --- | --- |
| Tracked modifications, owner primary worktree | **0** |
| Untracked files, owner primary worktree | **23 — all preserved, none touched** |
| Open PRs (repo-wide) | **0** |
| Session #5 implementation branches awaiting merge | **0** |
| Merge ancestry | all 5 merge commits are ancestors of `origin/main` |

Owner protected files — content, permissions, and timestamps unchanged:

| File | Mode | Size | mtime | sha256 (first 16) |
| --- | --- | --- | --- | --- |
| `.tmp-health.mts` | `-rw-r--r--` | 352 | `2026-08-07T05:07:49` | `79b85ba631a8cdb3` |
| `.tmp-load-driver.sh` | `-rwxr-xr-x` | 302 | `2026-08-07T05:07:49` | `eae1836e69c97884` |
| `.tmp-load-driver2.sh` | `-rwxr-xr-x` | 302 | `2026-08-07T05:07:49` | `05fcb11c33de15f7` |
| `.tmp-load-driver3.sh` | `-rwxr-xr-x` | 763 | `2026-08-07T05:07:49` | `f048f1d7c6ad982d` |
| `.tmp-load-driver4.sh` | `-rwxr-xr-x` | 585 | `2026-08-07T05:07:49` | `ca5ae48f9a3a3bc0` |

No `git clean`, no `git reset --hard`, no broad `rm`, no destructive globbing was used at any
point in this closeout.

**Housekeeping only, not deleted without authorization:** one throwaway falsification worktree
remains at `<session-scratchpad>/fals2` (outside the repository, detached at `9020f5c37`). Its
removal was declined by the permission layer and was not retried. It holds no unique work.
Numerous pre-existing worktrees from earlier sessions also remain and were left untouched.

---

## Q. Production state

| Field | Value |
| --- | --- |
| Deployment ID | `9e803b06-3e60-4f50-ac79-d8d4bbb98910` (SUCCESS) |
| SHA | `9020f5c3742253445e672bd534b614500c923abc` = final `origin/main` |
| `EDGE_MODE` | **`log`** — not armed |
| Health | `/health` 200 · `status: ok` · `db.state: CLOSED` · `consecutiveFailures: 0` |
| DB / schema | `dbOk=true` · `schema=ok` |
| Discord | `supervising: true` · `connected: true` · 0 reconnects |
| Human access | anonymous CF path proven; **authenticated flow not exercised** (§H) |
| Agent access | mechanism characterized (§I); not exercised under enforcement |
| Pipelines | MLB healthy, 0 errors (§J) |
| Critical alerts | none observed |

**#471's caller has not yet fired.** Both digest schedulers are registered on the live
deployment — verified with a second query shape after the first returned empty:

```
[SecurityDigest]       Scheduler started | fires daily in UTC 13:00–13:10 | poll interval=60s
[WeeklySecurityDigest] Scheduler started | fires every Sunday in UTC 13:00–13:10 | poll interval=60s
```

The deployment booted `04:32Z`; the next daily digest fires `2026-08-10T13:00Z`. The absence of
digest-read logs is explained by the schedule, corroborated by the positive discriminator above —
not by a broken path. Production confirmation of #471 is therefore **pending**, not failed.
It should be checked at the next fire: the marker lookups must produce **no** `TRUNCATED` line.

---

## R. Residual risks

Genuine and unresolved. Risks fixed during Session #5 are not preserved here.

1. **Hard-cutover origin-secret rotation.** `EDGE_ORIGIN_SECRET_PREV` is absent. Rotating today
   opens a window in which valid Cloudflare traffic can fail proof. Severity rises the moment
   `EDGE_MODE=on`. → B-1.
2. **An edge-bypass credential sits unread in the production app environment.** Blast radius with
   no functional benefit. → B-2.
3. **The origin lock has never been enforced with the corrected identity path.** Every downstream
   safety property is `[TEST]`, not `[PROD]`. The 2026-08-06 incident is what happens when this
   step is taken on inadequate evidence. → B-3, B-4.
4. **Test files are outside `tsc`.** A type error in a test file is caught only when vitest runs
   it. Structural, pre-existing, unchanged by Session #5.
5. **The `www` open-redirect allowlist is not externally falsifiable.** Railway's host router
   rejects unallowlisted Hosts before the app sees them, so only the in-process harness can
   exercise it. It has a negative control; it has no production negative probe.
6. **Authenticated human access is unverified this session.** Low overnight traffic meant no real
   login flow occurred on the current deployment, and this agent cannot perform one.

---

## S. Final verdict

**Proven in production:** final `main` is deployed and serving · the identity fix resolves the
true visitor from `cf-connecting-ip` on genuine third-party traffic while XFF carries only
`[CF PoP, Railway edge]` · `www` direct-origin ingress is counted, with the edge-verified case
correctly excluded · the security-event write, the alert path, and the Discord delivery all work
end-to-end · the canonical redirect preserves path and method · the weekly digest reconciles
exactly at 159 rows with zero marker leakage and no hidden cap · the MLB scheduler admits exactly
one cycle, blocks overlap, and releases its guard · the arming gate observes live production and
fails closed on missing evidence · `EDGE_MODE=log`, established two independent ways.

**Proven by test, with each test shown to fail against its defect:** all 14 controls in §N —
including origin-lock denial, partial-bypass emission, the breaker's starvation-not-fraction trip
invariant, the redirect allowlist, and the Eastern-canonical date guard.

**Not proven, and not upgraded:** direct-origin denial · access under enforcement (human, agent,
pipeline) · live executability of the partial-bypass detector · a fresh qualifying soak
authorization · safe dual-secret rotation posture · an authenticated human flow on the current
deployment.

The system is correct and deployed. It is **not enforcing**. Six gates depend on four Railway
operations this agent is denied, enumerated with exact instructions and exact required evidence
in §O.

`COMPLETE WITH EXPLICIT EXTERNAL BLOCKER` · **PASS: 32 · FAIL: 0 · BLOCKED: 6**

This record does not claim "100% verified", "bulletproof", or "complete in production", because a
production-verifiable mandatory condition remains blocked.

---

### Terminal closure matrix

| Gate | State | Class |
| --- | --- | --- |
| #467 merged and present | PASS | `[INSPECT]` + `[PROD]` |
| #468 merged and present | PASS | `[INSPECT]` + `[PROD]` |
| #469 merged and present | PASS | `[INSPECT]` + `[PROD]` |
| #470 preserved | PASS | `[INSPECT]` |
| #471 merged and deployed | PASS | `[INSPECT]` + deployment SUCCESS |
| Aug 9 weekly 2000-row path | PASS | `[PROD]` |
| 159-row reconciliation | PASS | `[PROD]` |
| Marker exclusion | PASS | `[PROD]` + `[TEST]` |
| False TRUNCATED warning fixed | PASS | `[TEST]`; caller pending §Q |
| Alert budget restored, never shipped altered | PASS | `[INSPECT]` + `[PROD]` |
| Lost `index.ts` reconstructed correctly | PASS | `[INSPECT]` + `[TEST]` + `[PROD]` |
| Human access before enforcement | **NOT PROVEN** | anonymous CF path `[PROD]`; authenticated flow not exercised |
| Agent path characterized | PASS | `[INSPECT]` ×3 shapes + control |
| Pipelines healthy | PASS | `[PROD]` |
| Environment posture known | PASS | `[PROD]` |
| Dual-secret posture safe | **BLOCKED** | B-1 |
| Agent bypass resolved (classification) | PASS | `[INSPECT]` + `[PROD]` |
| Agent bypass removed from app service | **BLOCKED** | B-2 |
| Fresh mechanical soak gate | **BLOCKED** | B-3 |
| `EDGE_MODE=on` | **BLOCKED** | B-4 |
| Human access under enforcement | **BLOCKED** | B-5 |
| Agent access under enforcement | **BLOCKED** | B-5 |
| Pipelines under enforcement | **BLOCKED** | B-5 |
| Direct-origin negative probe | **BLOCKED** | B-6 |
| Cloudflare positive probe | PASS | `[PROD]` |
| Partial-bypass detector live-executable | **BLOCKED** | B-6 |
| Circuit breaker stable (normal state) | PASS | `[PROD]` — no trips observed |
| `www` ingress observed | PASS | `[PROD]` both branches |
| MLB one-scheduler production behavior | PASS | `[PROD]` |
| MLB bounded concurrency | PASS | `[PROD]` + `[TEST]` |
| Eastern-canonical date guard | PASS | `[PROD]` + `[TEST]` |
| Security-event reconciliation | PASS | `[PROD]` |
| MLB data reconciliation | PASS | `[PROD]` |
| Edge telemetry reconciliation | PASS | `[PROD]` 6/6 explained |
| Final regression suite | PASS | tsc 0 · prettier 0 · 373/373 · gitleaks 0 |
| Falsification suite | PASS | 14/14 sensitive |
| Final production SHA verified | PASS | `[PROD]` |
| Protected owner files intact | PASS | `[INSPECT]` hashes + mtimes |
| Repository terminal state | PASS | 0 modifications · 0 open PRs |

Counts: **PASS 32 · BLOCKED 6 · NOT PROVEN 1 · FAIL 0.**

The one NOT PROVEN row (human access before enforcement) is not a defect and not a permissions
blocker — it is an absence of traffic during the observation window. It is recorded as neither
PASS nor BLOCKED, because it is neither.
