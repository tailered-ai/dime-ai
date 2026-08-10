# Session #5 — Final Operational Closure Amendment

**Amends, does not rewrite,** `session-5-terminal-closeout.md` (PR #474, merged
`2026-08-10T05:07:20Z` → `4459a2fa3`). That record's verdict was accurate when written and
remains historically accurate. This amendment records the state after the merge, the further
evidence gathered, and one gate **reclassified on new evidence**.

Evidence classes are never interchanged: `[PROD]` observed in production · `[TEST]` proven by a
test shown to fail against its defect · `[INSPECT]` read from shipped source/config ·
`[BLOCKED]` an actual external control prevents execution · `[NOT PROVEN]` not established.

---

## A. Verdict

# COMPLETE WITH EXPLICIT EXTERNAL BLOCKER

**32 PASS · 7 BLOCKED · 0 NOT PROVEN · 0 FAIL** (39 gates, denominator unchanged).

The target of `39 PASS / 0 BLOCKED` was not reached, and is not reachable from this agent's
authority. Seven gates require four Railway production operations that are hard-denied, plus a
credential path refused by an independently-administered provenance control. Per §39 of the
contract, `COMPLETE` would be false. It is not claimed.

**Movement since PR #474:** one gate moved `NOT PROVEN → BLOCKED` (§E). That is a *more precise*
classification on new evidence, not a regression and not a defect.

---

## B. Identity

| Field | Value |
| --- | --- |
| Previous final `origin/main` | `9020f5c3742253445e672bd534b614500c923abc` |
| **Final `origin/main`** | `4459a2fa30fa1a83d2c311364e869dd40adb7084` |
| **Production SHA** (`/health`) | `4459a2fa30fa1a83d2c311364e869dd40adb7084` — **matches** |
| **Deployment ID** | `2ba256e8-7a03-470c-8ac6-3f8a30d99d13` (SUCCESS, created `2026-08-10T05:07:21.875Z`) |
| Superseded deployment | `9e803b06-…` (REMOVED `2026-08-10T05:08:18.890Z`) |
| Schema head | `0134_widen_unit_probability_precision` (journal idx 134) — unchanged |
| `EDGE_MODE` | **`log`** — not armed |
| Health | `status: ok` · `schema: ok` · `db.state: CLOSED` · `dbOk=true` |
| PRs #467–#471 | MERGED |
| **PR #474** | **MERGED** `2026-08-10T05:07:20Z` → `4459a2fa3` · 22/22 checks pass |
| Open PRs (repo-wide) | **0** |
| Owner worktree tracked modifications | **0** |
| Owner worktree untracked | **23 — preserved** |

Code identity, deployment identity, and configuration identity are recorded separately and never
collapsed. The #474 merge produced a **new deployment** (`2ba256e8`) even though it changed only
a markdown file — the §10 principle, observed rather than assumed.

---

## C. Previous terminal baseline

```
32 PASS · 6 BLOCKED · 1 NOT PROVEN · 0 FAIL      (PR #474, verdict as merged)
```

Preserved verbatim. Not rewritten.

---

## D. Owner infrastructure actions

| Action | State |
| --- | --- |
| Railway `EDGE_AGENT_BYPASS_KEY` copy removed | **NO** — still configured on the app service |
| `EDGE_ORIGIN_SECRET_PREV` configured | **NO** — absent; rotation remains a hard cutover |
| Rotation-safe posture | **NO** |
| Fresh qualifying soak | **NO** — see §I |
| `EDGE_MODE=on` | **NO** — production is `log` |

No secret value appears anywhere in this record. Posture was read via Railway
`get-service-config`, which returns variable **names** only.

---

## E. Pre-enforcement authenticated human proof — **BLOCKED** (reclassified)

The contract requires one authenticated production flow before enforcement. **It could not be
executed**, and the reason is an external control, not an absence of effort:

```
$ pnpm agent:doctor
Dime agent access failed: node execution is blocked:
  independent root-owned provenance is unavailable

$ pnpm platform:auth:user
Dime production auth failed: Railway credential execution is blocked:
  independent immutable provenance is unavailable
```

Source: `scripts/lib/dime-trusted-executables.mjs:53`. This is the control CLAUDE.md describes —
credential execution fails closed unless each sensitive executable and the Railway broker match
**independently administered** signing or root-owned hash provenance, and *same-user and ad-hoc
signatures are insufficient*. Satisfying it from this session would mean supplying exactly the
same-user signature the control exists to reject. **No bypass was attempted.**

Per contract §5 — "Do not label it BLOCKED unless an actual external permission prevents
execution" — an actual external permission prevents execution. The flow did not fail; it could
not be started. **`NOT PROVEN → BLOCKED`.**

**This is not a product defect.** Nothing here suggests production login is broken for real
users. What is blocked is this agent's ability to drive it.

**Second route, still open and requiring no owner action:** a genuine user login observed in
production logs closes this gate outright. None occurred in the observation window — verified
with two query shapes (§24): a `HTTP_REQUEST` filter returned empty, and an `ipSrc` filter (which
*does* return rows) showed only the Railway healthcheck and this agent's probes. The absence is
low overnight traffic, ~22:00 PDT Sunday — not a broken path.

---

## F. Enforcement activation

**Not performed.** `EDGE_MODE` remains `log`, confirmed two independent ways on deployment
`2ba256e8`:

1. Application-emitted: `… | edgeMode=log edgeVerified=false upstream=47.152.167.182 …`
2. Network-probed, independent mechanism — `edge-arming-gate.mjs enforce`:
   `Live posture: NOT_ARMED — raw origin: /health 200 plus non-exempt path 200 → the origin is
   serving the request itself, so the lock is not enforcing`

---

## G. Human under enforcement · H. Agent under enforcement · I. Pipelines under enforcement

All three **BLOCKED**. Enforcement is not active, so no observation of behaviour under
enforcement is possible. Nothing was inferred from the pre-enforcement state.

---

## I-bis. Fresh soak — BLOCKED, verified empirically

```
$ node scripts/edge-soak-report.mjs --db --since=2026-08-10T04:00:00Z
  - --db requested but DATABASE_URL is not set
FAIL — DO NOT set EDGE_MODE=on. Fix the failed conditions and re-soak.

$ node scripts/edge-arming-gate.mjs validate
  [FAIL] record_present — an authorization record exists and parses as a JSON object   (exit 1)
```

The gate **fails closed** on missing evidence — demonstrated, not assumed. The production
`DATABASE_URL` exists only in Actions secrets and was not sought. Per contract §12, no synthetic
traffic was generated to inflate request count, source count, or concentration.

---

## J. Edge positive / negative discriminator

| Path | Result | Class |
| --- | --- | --- |
| Cloudflare apex `/health` | **200** | `[PROD]` |
| Cloudflare `www` `/health` | **308** → apex, path preserved | `[PROD]` |
| Direct origin, `Host: www.<apex>`, non-health | 308 + counted (§K) | `[PROD]` |
| **Direct origin DENIED** | **BLOCKED** — impossible in `log` mode | `[TEST]` only |

The negative half of the pair cannot exist until enforcement is armed. It is not claimed.

---

## K. `www` accounting — re-proven on the new deployment

Deployment `2ba256e8`, `2026-08-10T05:10:08Z`, verbatim:

```
[RateLimit][EDGE_ORIGIN_INGRESS_ANOMALY] OBSERVED (not blocked) | IP=47.152.167.182
    path=/__amend-probe-20260810T051008Z method=GET ua="curl/8.7.1"
[DiscordSecurity][RATE_LIMIT] Posting security alert to channel 1492280227567501403 …
[www→canonical] 308 redirect: www.aisportsbettingmodels.com/__amend-probe-20260810T051008Z → …
    | edgeMode=log edgeVerified=false upstream=47.152.167.182 counted=true reason=direct-origin
[DB][insertSecurityEvent] Inserted | type=RATE_LIMIT ip=47.152.167.182 path=/__amend-probe-… origin=N/A
```

Both branches remain correct after the #474 merge: edge-verified → `counted=false
reason=edge-verified`; direct-origin → `counted=true reason=direct-origin`. **One** anomaly event
per probe — no duplicate emission.

### Identity resolver — all three branches now production-observed

New evidence, attached to the existing identity gate rather than a new gate (§36):

| `ipSrc` | Observation | Meaning |
| --- | --- | --- |
| `cf-connecting-ip` | `ip=47.152.167.182`, `05:08:43Z` | through Cloudflare with valid proof |
| `xff-leftmost` | `05:08:…` direct-origin `/health` | no CF header → documented fallback |
| `req.ip` | `ip=::ffff:100.64.0.2`, `05:08:03Z` | Railway's internal healthcheck, no CF header and no XFF → last resort |

The complete branch set of `clientIdentity.ts` is now exercised in production.

---

## L. Partial-bypass detector

- Present in the deployed code — `[INSPECT]` on the production SHA.
- **Live executability: BLOCKED.** The observation path does not execute while `EDGE_MODE=log`.
- Threshold emission semantics: `[TEST]` (falsification F9).

No abusive production traffic was manufactured to force a signal.

---

## M. Circuit-breaker state

Normal-state stability holds: no trip and no flap across the observation window, under real
traffic plus controlled probes. Failure modes remain `[TEST]` (falsification F10 — the trip
invariant is `verified <= verifiedFloor`, starvation not fraction, so attacker-generated
unverified traffic cannot reach it). No Cloudflare outage was manufactured.

---

## N. Weekly digest — preserved unchanged

```
2026-08-09T13:00:43Z · executing deployment ff472662 · 159 rows · limit=2000
102 allowlisted + 57 threat = 159
day buckets 0 + 10 + 0 + 19 + 26 + 2 + 0 = 57
sampleCapped=false · marker leakage 0
```

The previously predicted deployment `3764bc72` was removed `2026-08-09T03:20:58.721Z` — **9 h
39 m** before execution. It is not cited as the executing deployment anywhere.

---

## O. #471 production execution — **not yet due**

The relevant caller is scheduled for `2026-08-10T13:00:00Z` (`06:00 PDT`). Current time at
closeout is ~`05:15Z`. The window has **not occurred**.

Both schedulers are registered on the live deployment, which is the positive discriminator
distinguishing "not yet due" from "broken":

```
[SecurityDigest]       Scheduler started | fires daily in UTC 13:00–13:10 | poll interval=60s
[WeeklySecurityDigest] Scheduler started | fires every Sunday in UTC 13:00–13:10 | poll interval=60s
```

The gate remains PASS at `[TEST]` class — its evidence class is pending enrichment, not its
verdict. At the window, resolve the deployment **then serving** (do not assume `2ba256e8`), and
verify: intentional `limit=1` marker lookups emit **no** `TRUNCATED` line, the lookups still
function, and genuine capped queries still warn. A scheduler miss caused by deployment churn is
**not** a #471 defect and must not be recorded as one.

---

## P. MLB closure — preserved

Single authoritative scheduler · overlap blocked twice (`04:37:17`, `04:42:17`) · **guard
released**, next tick admitted at `04:47:17` · bounded concurrency (60.32 s / 61.37 s / 60.37 s
serialized) · `ScheduleSync … unchanged=119 missing=0` · slate reconciliation
`eligible = processed + explicitly classified`, remainder 0 · duplicate outputs 0 · timezone
misclassification 0 · errors 0.

The guard-release proof is load-bearing and retained: a guard that blocks but never releases
silently halts all MLB processing while looking healthy.

---

## Q. Data-integrity ledger

| Dataset | Expected | Observed | Difference | Explained | Unexplained |
| --- | --- | --- | --- | --- | --- |
| Weekly digest rows | 159 | 159 | 0 | — | **0** |
| allowlisted + threat | 159 | 102 + 57 | 0 | — | **0** |
| Σ day buckets vs threatTotal | 57 | 57 | 0 | — | **0** |
| Marker leakage | 0 | 0 | 0 | — | **0** |
| Hidden sample cap | none | `sampleCapped=false` | 0 | — | **0** |
| MLB eligible vs processed+classified | 0 remainder | 0 remainder | 0 | — | **0** |
| MLB duplicate outputs | 0 | 0 | 0 | — | **0** |
| MLB missing eligible | 0 | 0 | 0 | `missing=0` | **0** |
| Controlled edge probes (this amendment) | 4 | 4 | 0 | 3 CF/origin logged, 1 anomaly event | **0** |
| Security-event writes from probes | 1 | 1 | 0 | only the direct-origin `www` case qualifies | **0** |
| Alert-budget constant on production SHA | 20 | 20 | 0 | §S.1 | **0** |
| Production SHA vs final `origin/main` | equal | equal | 0 | `/health` | **0** |
| Protected owner files | 5 identical | 5 identical | 0 | §T | **0** |
| Schema head vs journal | idx 134 | idx 134 | 0 | no Session-5 schema change | **0** |

**Unexplained difference: 0**, across every defined in-scope invariant for the closure interval.
This is not a claim of universal certainty over systems outside that scope.

---

## R. Falsification

**14/14 controls sensitive**, retained from PR #474. No code changed since — the #474 merge
altered one markdown file, and the two implementation blobs underpinning the falsified controls
are **byte-identical** on the new production SHA:

| File | Blob on `4459a2fa3` |
| --- | --- |
| `server/_core/index.ts` | `86fa996976e59eb24f5442d1288ee5ee8b2bf718` |
| `server/discord/discordSecurityAlert.ts` | `52bbde3e96507d9911acccfb16ed4b3e94889ec7` |

No re-run was required. Repository residue: **0**.

### §29 re-verification — alert budget, by history and deployment, not by reading the file

| Check | Result |
| --- | --- |
| Constant on the **production SHA** blob | `const GLOBAL_ALERT_BUDGET_MAX = 20;` (line 115) |
| `100000` anywhere in that blob | **0 occurrences** |
| *Positive control for that grep* | 3 references to the constant found — the search works |
| Commits on **any ref** introducing the probe value | **0** |
| Commits that ever touched the constant | **1** (`2096729f5`, the commit that introduced it) |
| Commits touching the file across the Session-5 merge range | **0** |
| Deployment chain | `/health` reports `4459a2fa3` = the SHA carrying that blob |

The probe value never entered history, never entered a PR, never deployed.

### §30 re-verification — reconstructed `index.ts`

On the production SHA: `observeWwwRedirectIngress` at line 284; invoked at line 748 **before**
`res.redirect`; `counted=true reason=direct-origin` at line 308. The test drives shipped text —
`wwwCanonicalRedirect.test.ts:97` calls `extractFunction("observeWwwRedirectIngress")`, slicing
the real function out of `index.ts` rather than re-implementing it. Mutating it turns the suite
RED (F7, F8). Live behaviour re-confirmed on the new deployment (§K).

The loss is retained in the record. It was recovered, not undone.

---

## S. Tooling corrections — preserved, plus one new

1. **`tsc | tail` exit code.** A pipeline reported the exit status of `tail`, not `tsc`. Both the
   original and this amendment's runs use direct invocation: `TSC_EXIT=0`, `output_lines=0`.
2. **Persisted `cd` false missing-file report.** A `cd` that survived into a later command made
   the owner's `.tmp-*` files appear absent. Every filesystem assertion here resolves an absolute
   path and prints `pwd`.
3. **False absence from result limiting.** A `limit=20` log window crowded out the signal. The
   two-query-shape rule is applied throughout (§E, §O, §K).
4. **NEW — zsh `$VAR:path` mangling produced a false zero.** `git show "$PROD:server/…"` was
   parsed by zsh as a parameter modifier, so `git` errored, `grep` received empty input, and the
   count printed **0 occurrences** of the probe value — the right answer for the wrong reason. Had
   it been trusted, §29 would have rested on a broken command. Fixed with `"${PROD}:path"` bracing
   **and** a positive control proving the query resolves (1308 lines returned) before any zero was
   accepted. This is the same failure class as correction 1: a zero that came from a broken
   pipeline rather than from the world.

---

## T. Repository state

| Item | Value |
| --- | --- |
| Owner worktree tracked modifications | **0** |
| Owner worktree untracked | **23 — all preserved** |
| Open PRs | **0** |
| Session #5 branches awaiting merge | **0** |

Protected owner files — re-hashed at terminal closure, **byte-identical** to the Session-5
baseline:

| File | SHA-256 | Mode | Size | mtime |
| --- | --- | --- | --- | --- |
| `.tmp-health.mts` | `79b85ba631a8cdb3cf3b684adec328c9c4e4387f620671e279ef129dcae79cb1` | `-rw-r--r--` | 352 | `2026-08-07T05:07:49` |
| `.tmp-load-driver.sh` | `eae1836e69c9788430e4d5d42736b05e4ad9fbd0aeeef44f0e619890dbeb24da` | `-rwxr-xr-x` | 302 | `2026-08-07T05:07:49` |
| `.tmp-load-driver2.sh` | `05fcb11c33de15f79b5634ab617ab017ad0e25726a872b44a6919ebe441c5f65` | `-rwxr-xr-x` | 302 | `2026-08-07T05:07:49` |
| `.tmp-load-driver3.sh` | `f048f1d7c6ad982dbc071e961d05f71a4eadd1dadfb1e7428b1574d2588f2b4c` | `-rwxr-xr-x` | 763 | `2026-08-07T05:07:49` |
| `.tmp-load-driver4.sh` | `ca5ae48f9a3a3bc07d7d77e4dac704e5be1cc8ddc8d2e39551361fd2f094824d` | `-rwxr-xr-x` | 585 | `2026-08-07T05:07:49` |

Content differences 0 · permission differences 0 · timestamp differences 0.

No `git clean`, no `git reset --hard`, no broad `rm`, no destructive globbing was used during
this closure. One throwaway falsification worktree remains in the session scratchpad, outside the
repository; its removal was declined by the permission layer and was not retried.

### Final regression suite, against `4459a2fa3`

| Gate | Result |
| --- | --- |
| `tsc --noEmit` (direct invocation) | **exit 0**, 0 output lines |
| `prettier --check .` | **exit 0** |
| 19 relevant suites | **373 / 373 pass**, 0 fail |
| `gitleaks` over the Session-5 merge range | **no leaks found** |

---

## U. Production state

| Field | Value |
| --- | --- |
| Deployment ID | `2ba256e8-7a03-470c-8ac6-3f8a30d99d13` (SUCCESS) |
| SHA | `4459a2fa3` = final `origin/main` |
| `EDGE_MODE` | `log` |
| Health | `ok` · `dbOk=true` · `schema=ok` · `db.state=CLOSED` |
| MLB pipeline | healthy, 0 errors |
| Critical alerts | none |
| Authenticated human traffic in window | none observed (two query shapes) |

---

## V. Residual blockers

**Not NONE.** Seven gates blocked; four Railway operations plus one credential-provenance control.

### OWNER ACTION PACKET

Execute in this order. Each step is minimal and independently reversible.

#### OA-1 · Remove **only** the obsolete Railway bypass copy

- **Where:** Railway → project `stunning-creativity` (`8dd7341d-…`) → service
  `ai-sports-betting-dime-ai` (`a46ea921-…`) → environment production.
- **Do:** delete the variable `EDGE_AGENT_BYPASS_KEY`.
- **Do NOT touch:** the Cloudflare Skip-rule value, or the GitHub Actions repo secret. Both are
  required. Only the app-service copy is obsolete — the server never reads it (0 hits in
  `server/`, 0 hits for `x-dime-agent`, positive control confirms the search works).
- **Then:** resolve the **new deployment ID** (a variable change creates one), verify `/health`
  returns `status ok`, `schema ok`, `dbOk true`, and SHA `4459a2fa3`.
- **Evidence:** new deployment ID · `/health` body · one green `deploy-smoke.yml` run proving the
  supported agent path still works without the server-side copy.

#### OA-2 · Establish safe dual-secret posture

- **Step A:** copy the **current** `EDGE_ORIGIN_SECRET` value into `EDGE_ORIGIN_SECRET_PREV`,
  leaving the primary unchanged.
- **Step B:** redeploy; confirm normal Cloudflare traffic still succeeds and a `www` log line
  shows `edgeVerified=true`.
- **Step C:** generate a new primary secret outside any transcript.
- **Step D:** set `EDGE_ORIGIN_SECRET` = new generation, keeping `EDGE_ORIGIN_SECRET_PREV` = old.
- **Step E:** redeploy **while Cloudflare still sends the old generation**. Expect zero legitimate
  403s — traffic verifies through `PREV`.
- **Step F:** switch Cloudflare to send the new primary. Expect success on the new generation;
  the old one is still accepted.
- **Step G:** confirm positive traffic on the new generation. **Do not clear
  `EDGE_ORIGIN_SECRET_PREV` during Session #5** — the requirement is safe rotation *capability*,
  not removal of the transition secret.
- **Evidence:** per-step deployment IDs · `edgeVerified=true` at steps B and F · zero legitimate
  403s across the whole sequence. No secret value in any artifact.

#### OA-3 · Fresh qualifying soak

- Run `scripts/edge-soak-report.mjs --db --since=<ISO>` from a **Production-environment**
  workflow (the production `DATABASE_URL` exists only in Actions secrets), over a window meeting
  every non-waivable condition: ≥60 min, ≥500 real requests, ≥25 distinct sources, concentration
  below ceiling, query succeeded, evidence well-formed, **zero legitimate would-deny traffic**.
- Then `node scripts/edge-arming-gate.mjs authorize --evidence=<bundle>
  --origin=https://ai-sports-betting-dime-ai-production.up.railway.app --actor=<who> --reason=<why>`.
- **Do not** generate synthetic traffic to reach the thresholds. If real traffic does not qualify,
  `BLOCKED ON QUALIFYING SOAK` is the correct outcome. There is no `--force`, `--skip`, or
  threshold flag, by design.
- **Evidence:** the authorization record, bound to deployment ID, SHA, edge-config fingerprint,
  and observation window — **the deployment produced by OA-1 and OA-2**, not an earlier one.

#### OA-4 · Arm `EDGE_MODE=on`

- **Preconditions:** OA-1, OA-2, OA-3 all complete; a pre-enforcement authenticated human flow
  observed (OA-5 or real user traffic); rollback understood — `EDGE_MODE=log` is never gated by
  the arming gate and is always available.
- **Do:** change `EDGE_MODE` from `log` to `on`. **Bundle no other change.**
- **Record:** exact timestamp · operator · deployment ID before and after · SHA.
- **STOP conditions:** any legitimate 403, failed login, blocked pipeline, health failure,
  `dbOk != true`, schema mismatch, missing origin secret, unexpected breaker trip. On any of
  these, drop to `EDGE_MODE=log`. **Do not weaken the lock, the limiter, or an alert threshold to
  make the rollout look green.**

#### OA-5 · Unblock the authenticated-flow gate (either route)

- **Route A — provenance:** grant the credential harness independently-administered (root-owned)
  provenance so `pnpm platform:auth:user` can execute. Same-user signatures will not satisfy it,
  by design, and this agent will not attempt to supply one.
- **Route B — observation (no owner action):** perform one ordinary login yourself, or wait for a
  real user. The gate closes from production logs alone. Required evidence: `ipSrc=cf-connecting-ip`,
  true visitor selected (not the Cloudflare PoP, not the Railway edge), authentication succeeds,
  authenticated API succeeds, no limiter collision.
- Repeat after OA-4 for the separate under-enforcement gate.

---

## W. Final gate matrix

Denominator unchanged at 39. No gate was added or removed to shape the verdict.

| Gate | State | Class |
| --- | --- | --- |
| #467 · #468 · #469 merged and present | PASS ×3 | `[INSPECT]` + `[PROD]` |
| #470 preserved · #471 merged and deployed | PASS ×2 | `[INSPECT]` |
| **#474 merged and deployed** | PASS | `[PROD]` — 22/22 CI, SHA on `/health` |
| Aug 9 weekly 2000-row path · 159-row reconciliation | PASS ×2 | `[PROD]` |
| Marker exclusion | PASS | `[PROD]` + `[TEST]` |
| False TRUNCATED warning fixed | PASS | `[TEST]`; live caller due `13:00Z` (§O) |
| Alert budget restored, never shipped altered | PASS | `[INSPECT]` history + deployment chain |
| Lost `index.ts` reconstructed correctly | PASS | `[INSPECT]` + `[TEST]` + `[PROD]` |
| **Human access before enforcement** | **BLOCKED** | reclassified — §E |
| Agent path characterized | PASS | `[INSPECT]` ×3 shapes + control |
| Pipelines healthy (pre-enforcement) | PASS | `[PROD]` |
| Environment posture known | PASS | `[PROD]` |
| Dual-secret posture safe | **BLOCKED** | OA-2 |
| Agent bypass resolved (classification) | PASS | `[INSPECT]` + `[PROD]` |
| Agent bypass removed from app service | **BLOCKED** | OA-1 |
| Fresh mechanical soak gate | **BLOCKED** | OA-3 — verified empirically |
| `EDGE_MODE=on` | **BLOCKED** | OA-4 |
| Human / agent / pipelines under enforcement | **BLOCKED** ×3 | OA-4 → OA-5 |
| Direct-origin negative probe | **BLOCKED** | needs enforcement |
| Cloudflare positive probe | PASS | `[PROD]` on `2ba256e8` |
| Partial-bypass detector live-executable | **BLOCKED** | needs enforcement |
| Circuit breaker stable (normal state) | PASS | `[PROD]` — no trip, no flap |
| `www` ingress observed | PASS | `[PROD]` both branches, re-proven |
| MLB one-scheduler · bounded concurrency · date guard | PASS ×3 | `[PROD]` + `[TEST]` |
| Security-event · MLB · edge-telemetry reconciliation | PASS ×3 | `[PROD]` |
| Final regression suite | PASS | tsc 0 · prettier 0 · 373/373 · gitleaks clean |
| Falsification suite | PASS | 14/14 sensitive |
| Final production SHA verified | PASS | `[PROD]` |
| Protected owner files intact | PASS | `[INSPECT]` hashes re-verified |
| Repository terminal state | PASS | 0 mods · 0 open PRs |

```
PASS 32 · BLOCKED 7 · NOT PROVEN 0 · FAIL 0
```

---

## X. Final verdict

The code is correct, merged, and deployed: production runs the exact final `main`, every
in-scope invariant reconciles with zero unexplained difference, all 14 critical controls have
demonstrated sensitivity to their own defect, and the full suite is green.

The system is **not enforcing**. Seven gates depend on four Railway operations this agent is
denied and one credential path refused by an independently-administered provenance control. Each
has an exact instruction and exact required evidence in §V.

One gate moved `NOT PROVEN → BLOCKED` on new evidence. That is a sharpening of the record, not a
regression: the flow was never attempted and never failed — it was refused by a security control
working as designed.

`COMPLETE WITH EXPLICIT EXTERNAL BLOCKER`.

Not claimed: "100% verified", "fully proven", "bulletproof", "complete in production". A
production-verifiable mandatory condition remains blocked, so none of those would be true.
