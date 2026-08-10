# Edge Defense Runbook — Cloudflare in front of Railway (Phase 4)

> **Owner-executed. Nothing here is live until you do the DNS/Cloudflare steps AND flip `EDGE_MODE`.**
> The supporting code shipped inert (`EDGE_MODE` unset = byte-identical to today). This runbook is
> the anti-scraping edge layer from the maximum-security program; it was designed against a 5-lens
> adversarial review (origin-bypass, IP-spoof, cache-leak, collateral-damage, rollout-safety) and the
> fixes are baked into both the code and the steps below.
>
> **⚠ CURRENT STATE (verified live 2026-08-06).** The domain is **already a Cloudflare zone** —
> nameservers are `clay.ns.cloudflare.com` / `maria.ns.cloudflare.com` (the domain was purchased on
> Cloudflare) — but the DNS **records are grey-clouded (DNS-only)**, so Cloudflare answers DNS yet does
> **not** proxy HTTP: `aisportsbettingmodels.com` responds `server: railway-hikari`, `x-railway-edge`,
> no `cf-ray`. Records today: apex `A 69.46.46.66`, `www CNAME sg3mq9l9.up.railway.app` (a *proxied*
> record would instead resolve to a Cloudflare `104.x/172.64.x` anycast IP). **The zone already exists
> — activation is flipping those records to Proxied (orange), NOT adding the domain (skip step 4's
> "add to Cloudflare"; the delegation is done).** `EDGE_MODE` MUST stay unset/`off` until the records
> are orange-clouded, the secret Transform Rule is live, AND the `log` soak (step 12) proves Cloudflare
> is injecting the secret — flipping `on` before CF actually proxies would 403 every real request (the
> #370-class outage). The new circuit breaker (§6) now *self-heals* that mistake, but the ordering is
> still the law. `EDGE_MODE=on` is a **Railway env change the owner makes** — no PR merge sets it.

## 0. The one thing to understand first

The app already gates model IP behind login (Phase 3) and keys rate limits on the true client
(Phase 1). Cloudflare adds a **hop** in front of Railway. That hop is powerful (WAF, bot management,
edge rate limiting) but it introduces three failure modes this runbook exists to prevent:

1. **Origin bypass** — if a scraper finds the raw `*.up.railway.app` URL, they skip Cloudflare
   entirely. **The edge is worthless without an origin lock.**
2. **IP mis-resolution** — behind Cloudflare the leftmost `X-Forwarded-For` becomes the *Cloudflare
   PoP* IP, not the visitor. Left unhandled, every user behind a PoP collapses onto one rate-limit
   key and the security canary goes blind. The code fixes this by reading `cf-connecting-ip` **only
   when the request proves it came through our edge**.
3. **Collateral damage** — a WAF in Block mode will 403 legitimate Dime Chat text and betting jargon
   at the edge, before the app ever sees it. The WAF must **skip** the JSON/free-text API surface.

## 1. The `EDGE_MODE` state machine (read at request time)

| `EDGE_MODE` | Origin lock | IP resolution | Use |
| --- | --- | --- | --- |
| unset / `off` | pass-through | legacy leftmost-XFF | **default** — inert, byte-identical to pre-Cloudflare |
| `log` | observe-only (never 403) | **`cf-connecting-ip` when the edge proof passes** | staging soak: confirm CF is injecting the secret on real traffic |
| `on` | **403** non-edge traffic (except `/health`) | `cf-connecting-ip` when the edge proof passes | full enforcement |

**Why `log` already switches IP resolution:** keying is *decoupled* from the 403. That makes `log` a
**fully healthy rollback target** — if enforcement misbehaves under `on`, set `EDGE_MODE=log` and the
site is immediately healthy (correct keys, no 403s, no PoP collapse), no DNS change needed. Only `off`
(meaning "Cloudflare is no longer in front") returns to legacy XFF keying.

### Environment variables

- `EDGE_MODE` = `off` | `log` | `on` (unset ⇒ off).
- `EDGE_ORIGIN_SECRET` = 32+ byte hex (`openssl rand -hex 32`). The value Cloudflare injects as the
  `x-dime-edge-secret` request header. **Railway env only — never logged, never in evidence.**
- `EDGE_ORIGIN_SECRET_PREV` = optional; a second accepted secret for zero-downtime rotation.

**Anti-lockout (two independent self-heals):**

1. `EDGE_MODE=on` with *no* secret configured downgrades to observe-only + a CRITICAL log line — it
   will not 403 the whole site. The fail-closed guarantee holds whenever a secret is set.
2. `EDGE_MODE=on` **with** a secret but Cloudflare not actually in front (DNS not orange-clouded /
   secret typo / CF outage) is caught by the **circuit breaker** (§6): after `EDGE_BREAKER_TRIP_WINDOWS`
   consecutive windows with no verified Cloudflare ingress, enforcement auto-downgrades to observe-only
   and fires a CRITICAL line, then auto-resumes when verified traffic returns. A single genuine CF
   request in any window resets the streak, so an attacker cannot force the downgrade while users flow.

## 2. The origin lock — the load-bearing decision (origin-bypass fix)

The code enforces a **shared secret** (`x-dime-edge-secret`, constant-time compared) plus a
Cloudflare-IP-range check. **The IP-range check is defence-in-depth ONLY** — anyone can route your
origin through their *own* free Cloudflare zone and arrive from a real CF PoP IP, so a leaked secret
alone would be enough to bypass. Therefore you MUST add a proof bound to *your* Cloudflare account.
Pick one (in order of preference):

- **A — Cloudflare Tunnel (recommended for Railway).** Run `cloudflared` as a sidecar; it dials
  **outbound** to Cloudflare, so there is **no public origin ingress at all** — the `*.up.railway.app`
  URL stops serving web traffic. This eliminates origin-bypass by construction. Trade-off: a second
  process in the container. This is the strongest option.
- **B — Authenticated Origin Pulls (mTLS).** Cloudflare presents a client certificate the origin
  validates; an attacker's own CF zone cannot present *your* per-zone cert. Requires the origin to be
  able to validate client certs (Railway terminates TLS at its edge — confirm feasibility before
  relying on this; if Railway can't validate the cert at the origin, use option A).
- **C — Shared secret only (interim).** The code's default. **Treat `EDGE_ORIGIN_SECRET` leakage as
  catastrophic** (full bypass + IP spoofing): rotate on any suspicion (set `_PREV`=old, `SECRET`=new,
  update the CF Transform Rule, then clear `_PREV`), add log/response scrubbing, and alert if the
  secret value ever appears in any output. Do **not** treat the IP-range check as a real second factor.

`/health` is always exempt from the lock (Railway's healthcheck probes the origin directly and must
stay green during a Cloudflare-edge outage).

## 3. Owner setup — ordered

1. **Merge the PR.** `EDGE_MODE` unset, no secret → verified inert. Nothing activates on deploy.
2. `openssl rand -hex 32` → store in your password manager.
3. In **Railway → project `stunning-creativity` → production** set `EDGE_ORIGIN_SECRET`. **Leave
   `EDGE_MODE` unset.** Restart. Confirm the app is unchanged.
4. Add `aisportsbettingmodels.com` to Cloudflare. Create apex + `www` DNS records at the Railway
   origin, initially **DNS-only (grey cloud)**.
5. **SSL/TLS = Full (Strict).** Leave Cloudflare HSTS **off** (the origin emits HSTS). Do **not** add
   any Cloudflare www/http redirect rule — the app issues a 308 www→apex itself (a CF 301 would drop
   POST bodies). Keep **Preserve Host Header ON**.
6. Validate the site end-to-end over HTTPS while still grey-clouded. Then set the origin lock
   (option A tunnel, or B mTLS, or accept C). For A: stand up the tunnel and point DNS at it. For
   B/C: flip apex + `www` to **Proxied (orange)**.
7. **Transform Rule** (skip if using a tunnel that injects at the connector): *Modify Request Header →
   Set* `x-dime-edge-secret` = `<EDGE_ORIGIN_SECRET>` (bind from Cloudflare Secrets Store if available
   so the value isn't visible in the dashboard).
8. **WAF** — Managed Ruleset + OWASP core, **low paranoia**. **SKIP (or Log-only, never Block) for the
   free-text / JSON API surface** — this is the collateral-damage fix, non-negotiable:
   - `/api/dime/chat`, `/api/dime/wc2026` (free-form NL → LLM; SSE stream),
   - `/api/trpc/*` (the comma-batched mutation surface: bet notes, titles, searches),
   - plus the existing `/api/stripe/webhook` and `/health`.
   Also **disable WAF response inspection/buffering on `/api/dime/chat`** (it is Server-Sent Events —
   buffering stalls token streaming). Keep OWASP Block on GET/marketing/static only. The app's Zod
   schemas + `sanitizeDimeChatHistory` + login gating + the six rate limiters are the real input
   defense.
9. **Super Bot Fight Mode:** Verified bots = **Allow** (Googlebot/Bingbot/Applebot/social unfurlers);
   Definitely-automated = Block; Likely-automated = **Managed Challenge scoped OUT of `/api/*` and
   `/`** (never challenge the SPA XHR path or the SEO prerender). Do **not** enable legacy Bot Fight
   Mode or "I'm Under Attack".
10. **Edge Rate Limiting** keyed on `cf.connecting_ip`: login 5/15m challenge; `stripe.publicCreate`
    10/15m block; `waitlist.submit` 5/15m block; `/api/*` 200/min block. (These complement, not
    replace, the app-layer limiters.)
11. **Cache Rules — order matters (cache-leak fix):**
    - Turn **ON "Normalize incoming URLs"** (decode `%2e`, collapse dot-segments) so the edge
      cache-key path equals the app's routed path — closes `/assets/..%2f..%2ftrpc/...` path-confusion.
    - Rule order (terminating, top to bottom): **Bypass** `/api*` → **Bypass** when the `app_session`
      cookie is present → **Bypass** `/` and SPA doc routes → **Cache Everything** ONLY for static
      **file extensions** (`.js .css .woff2 .woff .ttf .png .jpg .svg .avif .map`), **never**
      `starts_with /assets/` → **Respect origin Cache-Control** globally.
    - **Never** use "Override/Ignore origin Edge TTL" on any rule whose match can overlap a dynamic
      path — the origin already emits `private, no-store` on gated endpoints and that must stay
      authoritative.
    - Confirm Cloudflare **forwards the `Cookie` header** to the origin on `/api` routes (else authed
      users lose their model data).
12. **Soak in `log`:** set `EDGE_MODE=log`, restart. Watch 15–30 min of real traffic:
    - No `edge_would_deny` on legitimate traffic (⇒ CF is injecting the secret correctly).
    - `edge_origin_ingress_anomaly` events should be ~zero (⇒ all traffic is arriving through CF).
      **This count is a lower bound, not a measurement** — ingress on the `www` hostname is
      redirected before the origin lock and is never counted. Read **§7** before treating a low
      number here as evidence that traffic is arriving through Cloudflare.
    - `cf-connecting-ip` resolves to real client IPs (spot-check limiter behavior).
    - **If legit traffic warns, STOP and fix CF injection before enforcing.**
13. **Enforce:** set `EDGE_MODE=on`, restart. Run §4 verification.
14. **Alerting:** page on the CRITICAL "EDGE_MODE=on with no secret" line and on any spike of
    `edge_origin_ingress_anomaly`. Add an **external synthetic monitor through the Cloudflare
    hostname** (Railway's `/health` probes the origin directly and stays green during a CF outage —
    it will not catch an edge failure). Monitor the **`www` hostname explicitly** — no counter,
    alert, or digest covers it today. See **§7**.

## 4. Verification (run after `EDGE_MODE=on`)

Automated: `SMOKE_EDGE=cloudflare SMOKE_ORIGIN_URL=<direct-railway-origin> node scripts/smoke-deploy.mjs https://aisportsbettingmodels.com`
asserts (a) direct-origin-without-secret → 403, (b) `/health` reachable on the origin, (c) a Dime
Chat POST full of betting jargon / SQLi tokens is **not** edge-blocked (reaches the origin).

Manual spot-checks:

- Direct `*.up.railway.app/api/trpc/games.list` (no secret) → **403**; `/health` direct → **200**.
- Through `aisportsbettingmodels.com` → 200; logged-in user still receives full model fields.
- Anonymous `curl` of `games.list` / `strikeoutProps.getByGame` → commodity only (Phase 3 intact),
  and the response carries `Cache-Control: private, no-store` when authed / `public, max-age=30` when
  anon, `Vary: Cookie` (cache-leak fix).
- `cf-cache-status` is `DYNAMIC`/`BYPASS` for `/api/*` and for an authed request; a path-confusion
  URL (`/assets/..%2f..%2ftrpc%2fgames.list`) never returns model fields to a subsequent anon fetch.
- Googlebot UA on `/` still gets the prerender (`X-Prerender: 1`); Stripe webhook → 200.

## 5. Rollback

- **Enforcement fault (403 spike after `on`):** set `EDGE_MODE=log`. Site is immediately healthy —
  keys stay correct (no PoP collapse), no 403s. Diagnose, then re-arm. *This is the fast path.*
- **Full pre-Cloudflare rollback:** grey-cloud the DNS (remove Cloudflare from the path) **and** set
  `EDGE_MODE=off`. Legacy XFF keying resumes. (A DNS change has propagation lag — the `log` harbor
  above is why you rarely need this.)
- Every env change requires a Railway restart/redeploy; there is no schema/migration coupling, so no
  #370-class deploy-order hazard exists here.

## 6. Documented fast-follows (not in this PR)

- **Stateful auto-downgrade:** ✅ DONE (`server/_core/edgeCircuitBreaker.ts`, hardened against a 4-lens
  adversarial review). If `on` with a secret but Cloudflare stops injecting it (DNS un-orange-clouded /
  secret typo / CF outage), the origin lock judges Cloudflare absent and **auto-downgrades enforcement
  to observe-only** (never 403) + a CRITICAL `edge_breaker_tripped` line, then **auto-recovers**
  (`edge_breaker_recovered`) when `≥ EDGE_BREAKER_RECOVER_FLOOR` (default 3) verified requests return.
  The trip fires **only after `EDGE_BREAKER_TRIP_WINDOWS` (default 3) CONSECUTIVE rolling windows**
  (`EDGE_BREAKER_WINDOW_MS`, default 60 s) each of which closed with `≥ EDGE_BREAKER_MIN_SAMPLE`
  (default 200) requests and `≤ EDGE_BREAKER_VERIFIED_FLOOR` (default 0) verified — i.e. ~3 minutes of
  *sustained, total* Cloudflare absence. This consecutive-window rule is what makes it un-gameable: a
  "verified" request requires the origin secret only *your* Cloudflare forwards, and a **single**
  verified request anywhere in a window marks that window non-starved and **resets the streak**, so an
  attacker flooding the raw origin cannot force a downgrade while real users are reaching the CF-fronted
  domain. A trip degrades only the origin-lock 403 layer — Phase 3 gating + the rate limiters still
  strip/throttle the payload. **Residual:** a *low-traffic* real outage (below `minSample`/window) or a
  genuinely zero-user dead period may not reach the trip threshold or may be trippable by origin noise
  — both are covered by the runbook's external synthetic monitor through the Cloudflare hostname (step
  14), not this passive origin-side breaker. Env knobs (all optional): `EDGE_BREAKER_WINDOW_MS`,
  `EDGE_BREAKER_MIN_SAMPLE`, `EDGE_BREAKER_VERIFIED_FLOOR`, `EDGE_BREAKER_TRIP_WINDOWS`,
  `EDGE_BREAKER_RECOVER_FLOOR`, `EDGE_BREAKER_DISABLED=1` (force unconditional enforcement). Still
  complemented by the mandatory `log` soak + the healthy `log` rollback + loud alerts.
- **CF CIDR snapshot refresh:** ✅ DONE. `CF_CIDR_SNAPSHOT_DATE` + a boot staleness alarm live in
  `server/_core/edgeProxy.ts` (warns when armed and the snapshot is >90d old — observability only,
  never blocks). `scripts/refresh-cf-cidrs.mjs` fetches/validates the published ranges (fail-closed on
  empty/malformed) and rewrites the arrays + date (`--check` for drift detection). The monthly
  read-only `.github/workflows/refresh-cf-cidrs.yml` goes RED on drift (the repo's Actions security
  contract forbids self-mutating/PR-opening workflows); a maintainer then runs the script and opens
  the refresh PR through the normal reviewed flow.
- **Turnstile:** app-embedded widget on `/login` and sensitive forms, verified server-side — never an
  edge HTML interstitial on the XHR path (accessibility).

## 7. Measurement gap — the `www` hostname is not measured (recorded 2026-08-07)

**Every `edge_origin_ingress_anomaly` count this project has ever produced is a lower bound on
direct-origin ingress, not a measurement of it.** Ingress on the `www` hostname is redirected away
before the origin lock runs, so it is neither blocked nor counted.

**Calibrate the size of that undercount — it is bounded, not unknown.** The only requests the
counter misses are those that *both* reach the Railway origin directly (bypassing Cloudflare) *and*
carry a `Host` beginning with `www.`. Everything else — every apex request, and every `www` request
that arrives through Cloudflare — is counted exactly as before. The counter is a floor, not a
fiction: treat it as "true direct-origin ingress ≥ this number", and do not discard a signal it does
report. What is unmeasured is the size of that one intersection, and §4's `www`-Host probe
(recommendation 2 below) is what turns it from unmeasured into gated.

### The mechanism (verified in code, not inferred)

`server/_core/index.ts` registers the `www`→apex 308 redirect **before** the origin lock, and
Express runs middleware in registration order:

```ts
654:  app.use((req, res, next) => {          // www → apex 308
655:    const host = req.headers.host ?? "";
656:    const canonical = wwwRedirectTarget(host);   // null ⇒ fall through to next()
657:    if (canonical) {
...
662:      return res.redirect(308, redirectUrl);   // ← terminates. next() is never called.
```

```ts
694:  app.use(
695:    originLock((kind, req) => {          // ← 40 lines later. Unreachable for a redirected www Host.
```

Only two `app.use` calls precede line 654: the HTTP request logger at `index.ts:603` (which calls
`next()`) and this redirect. The redirect is therefore the **first terminating handler** in the
chain, and for any request it redirects the request ends at line 662.

Since 2026-08-07 the redirect only fires for a `www.` Host whose apex is in the app's own origin
allowlist (`canonicalApexHosts()`, derived from `PUBLIC_ORIGIN` + `ADDITIONAL_ALLOWED_ORIGINS`);
every other `www.*` Host now falls through to `next()` and is locked and counted normally. That
narrows the gap to the hostnames this app actually serves — which is the whole of the live traffic
this section is about, so the gap itself is unchanged for `www.aisportsbettingmodels.com`.

### What that makes invisible

Both call sites that emit the anomaly counter are downstream of the redirect, so both are dead for a
redirected `www` Host (i.e. `www.aisportsbettingmodels.com` — an unallowlisted `www.*` Host reaches
all of them):

| Signal | Source | Reached on a redirected `www` Host? |
| --- | --- | --- |
| `edge_origin_ingress_anomaly` (`edge_deny`, the real 403) | `index.ts:705`, inside `originLock` | **No** |
| `edge_origin_ingress_anomaly` (`/api/trpc` canary, observe-only) | `index.ts:1099`, mounted at `:1058` | **No** |
| Circuit-breaker window sample | the `observe(...)` call inside `originLock.ts` | **No** — absent from both the sample count and the verified count |
| `edge_partial_bypass_suspected` | same `observe(...)` call | **No** |
| `/health` lock exemption | the `req.path === "/health"` early-return in `originLock.ts` | **No** — also downstream |

(`originLock.ts` is cited by symbol rather than line number: it is under active change, and these
anchors moved while this section was being written. The `index.ts` line numbers above were
re-verified against the working tree at the time of writing.)

The partial-bypass detector is the sharpest loss. It exists to catch exactly this shape — a real
client pinned to a hostname that reaches the origin directly — and its own CRITICAL log line tells
the operator to *"check DNS orange-cloud coverage, the **www/apex split**, and any client pinned to
the raw origin host."* It cannot see the `www` side of that split.

**No verification harness closes the gap either.** `scripts/smoke-deploy.mjs` asserts the lock
against `SMOKE_ORIGIN_URL` — the direct `*.up.railway.app` origin, whose `Host` does not begin with
`www.`. §4's automated check passes whether or not this gap exists. (Confirmed across three
different query shapes over `scripts/` and `.github/workflows/`: nothing probes a `www` Host.)

**The one signal that does fire is not usable as-is.** `index.ts:660` logs a `[www→canonical]` line
on every redirected `www` request, so the traffic is not absent from Railway logs. But that line
records only host, path, and target URL — **no upstream IP and no edge-verification result** — so it
cannot distinguish a Cloudflare-fronted `www` request from a direct-origin one. The raw material is
there; the discriminator is not.

### What this does *not* mean

This is a detection gap, **not a content bypass**. For `www.aisportsbettingmodels.com` the origin
serves exactly one thing — a 308 to the apex — and a client that follows it lands on the apex, which
resolves to Cloudflare. No model data is served from the origin over that hostname. Do not restate
this section as an open data leak.

**What that reassurance rested on until 2026-08-07, and did not say.** The redirect target used to
be computed as `host.slice(4)` with **no allowlist**, so "the origin serves exactly one thing" was
true only of *our* `www` host. For any other `www.*` Host it served a 308 to whatever apex the
client's own `Host` header named — `Host: www.evil.com` produced `Location:
https://evil.com/<path>`. Two consequences, neither of which the paragraph above covered:

- **The origin answered unallowlisted Hosts ahead of the lock.** Because this middleware is
  registered before `originLock`, that 308 was served on the raw origin *even under `EDGE_MODE=on`*.
  The lock's promise — "a direct hit on the origin without the Cloudflare secret gets a 403" — did
  not hold for any `www.*` Host.
- **Attacker-controlled values propagated downstream.** Any Host-keyed cache entry, log line, or
  metric label inherited a hostname the attacker chose, including the `[www→canonical]` log line
  above.

**Calibration — this was not a practical phishing open redirect.** Trust laundering requires
redirecting *from* a host the victim trusts; here the redirect target is derived from the attacker's
**own** `Host` header, so a victim would already have to be on `www.evil.com` before the redirect
fired. The real weight is the two bullets above: an unlocked response path and attacker-controlled
values in Host-keyed state.

**Fixed 2026-08-07** (`canonicalApexHosts()` / `wwwRedirectTarget()` in `server/_core/index.ts`).
The redirect now fires only when the stripped host is in the app's own origin allowlist —
`PUBLIC_ORIGIN` plus `ADDITIONAL_ALLOWED_ORIGINS`, the same origins the tRPC CSRF check already
trusts; no new env var. Any other `www.*` Host falls through to `next()` and is handled by the
origin lock and normal routing. It is still a **308**, never a 301: preserving the POST body is why
this middleware exists at all. Regression gate:
`server/_core/wwwCanonicalRedirect.test.ts` — it slices the real middleware text out of `index.ts`,
runs it on real Express over raw `node:http` (WHATWG `fetch()` drops a caller-supplied `Host`), and
carries a negative control that executes the pre-fix `host.slice(4)` text through the identical
harness and asserts the open redirect is observable.

**Operator note — the allowlist is only as wide as the config.** If `PUBLIC_ORIGIN` were ever unset
or wrong, the `www` redirect stops firing (the request falls through to normal routing) rather than
redirecting to an attacker-named host. Production is configured: the boot log for deployment
`3a04e6ff` reads `[CSRF] Allowed origin (PUBLIC_ORIGIN): https://aisportsbettingmodels.com`, with
`ADDITIONAL_ALLOWED_ORIGINS` carrying the apex and `www` forms as well. If you add a second custom
domain, add it to one of those two variables or its `www` form will not redirect.

**Middleware order was deliberately left alone.** Moving the redirect below `originLock` is
recommendation 1 below; it is a separate change with its own blast radius (see its Transform-Rule
precondition), and the measurement gap this section records stands on its own regardless.

### Effect on decisions already made

The arming decision recorded in the as-built (18 requests through Cloudflare + 5 direct) and §3
step 12's stop condition (*"`edge_origin_ingress_anomaly` events should be ~zero"*) were both read
off this counter. Both were therefore read off a **floor**: a number that is too low by exactly the
volume of requests that reached the origin directly *and* carried a `www` Host, and correct for
everything else. Nothing here says the decision was wrong; it says the evidence offered for it does
not carry the weight it was given. Any future arming decision that cites this counter must cite it
as a lower bound and pair it with a `www`-aware check.

Live DNS at the time of this record (`dig`, 2026-08-07): apex and `www` both resolve to
`104.26.9.86 / 104.26.8.86 / 172.67.74.49` — Cloudflare anycast, i.e. **both proxied**. This
supersedes the grey-cloud state described in the header banner. Normal `www` traffic therefore
arrives through Cloudflare today, which narrows the live exposure to (a) a client that reaches the
Railway edge directly with a `www` Host, and (b) any future state where `www` is un-proxied,
re-pointed, or added as a second custom domain. The gap is structural and survives both.

### What would close it — ranked

1. **Move the `www` redirect below the `originLock` mount** (register the lock first). This is the
   fix: `www` ingress then flows through the same lock, counter, breaker, and partial-bypass
   detector as the apex, and Cloudflare-fronted `www` traffic is verified and redirected exactly as
   it is today. It beats every option below because it deletes the gap instead of observing it, and
   it needs no new infrastructure.
   **Precondition — verify before moving:** the `x-dime-edge-secret` Transform Rule (§3 step 7) must
   be **zone-wide**, not scoped to the apex hostname. If it is apex-only, Cloudflare-fronted `www`
   requests carry no secret, and putting the lock first would 403 them under `EDGE_MODE=on`. Confirm
   the rule's scope, then soak the move in `EDGE_MODE=log` and watch for `edge_would_deny` on `www`
   before enforcing.
2. **Add a `www`-hosted probe to §4 and to `smoke-deploy.mjs`:** a direct-origin request with
   `Host: www.aisportsbettingmodels.com` must produce the same outcome as the apex probe. This does
   not close the gap, but it makes the gap fail a gate instead of passing one silently.
3. **Enrich the `[www→canonical]` log line** with the immediate upstream IP and the edge-verification
   result, then alert on `www` redirects arriving from a non-Cloudflare upstream. This measures the
   gap without closing it — the correct move only if #1 is blocked on the Transform Rule scope.
4. **External synthetic monitor through the `www` hostname** (owner action, per §3 step 14). Catches
   a `www`-specific edge failure; it does not see direct-origin `www` ingress at all.

Until #1 ships, treat the `www` hostname as **unmonitored** and every anomaly count as a floor.

> **A note on how this was verified.** The claim arrived from an audit, and audits in this project
> have been wrong before, so the ordering was confirmed two ways: a source-order assertion read off
> the real `index.ts`, negative-tested against a mutated copy with the two mounts swapped (assertion
> flips to FAIL, so it is not vacuous); and a behavioral run on real Express with both orderings —
> `Host: www.…` yields `308` with the counter firing **0×** in the shipped order, versus `403` with
> the counter firing **1×** when the lock is registered first, against a `403`/**1×** apex control.
> The harness's own first run reported a false negative because WHATWG `fetch()` silently drops a
> caller-supplied `Host` header; raw `node:http` is required to exercise this path.

## 8. The arming gate — §3 step 12 is now a mechanical control (added 2026-08-09)

§3 step 12 ("soak 15–30 min, stop if legit traffic warns") was a paragraph. A paragraph cannot
count requests, cannot measure a window, and cannot tell an Azure CI runner from a paying
customer. On 2026-08-06 arming proceeded on **23 requests over ~4 minutes** and real users were
403'd for ~7 hours.

`scripts/edge-soak-report.mjs` was written to make that verdict mechanical. It was correct and
**nothing invoked it**, which is operationally the same as the paragraph. `scripts/edge-arming-gate.mjs`
plus `.github/workflows/edge-arming-gate.yml` are what invoke it.

### 8.1 The gate in one paragraph

Arming is authorised by a **record**, and a record can only come from evidence that clears all
eight soak conditions, is less than 6 hours old, was collected while production was demonstrably
**not** already enforcing, and is bound to the edge-enforcement configuration that produced it.
A daily CI job reads live posture off the raw origin and **fails** if production is enforcing
without such a record. There is no `--force`, no threshold flag, and no override input anywhere.

### 8.2 The one thing that can never happen

**Dropping to `EDGE_MODE=log` is never gated.** §5's fast rollback is untouched, and three
independent properties guarantee it:

1. `evaluateEnforcement()` returns PASS on the `NOT_ARMED` branch **before the record is read**.
   A missing, corrupt, expired or entirely absent record cannot fail a disarmed production. So
   de-arming always *clears* this gate — it can never be blocked by it.
2. The gate holds no credential and calls no mutating API (`permissions: contents: read`, no
   secrets, no Railway token). It cannot set `EDGE_MODE` in either direction.
3. It is not wired to `push`, is not a required status check, and is not in the deploy pipeline.
   Railway deploys on push to `main` whatever this workflow says, so a red gate never blocks
   shipping a fix.

The gate constrains **arming** (`off`/`log` → `on`). It does not constrain **de-arming** and
structurally cannot.

### 8.3 Arming procedure (replaces §3 steps 12–13)

1. Set `EDGE_MODE=log`, restart, and soak **≥ 60 minutes** of real production traffic.
2. Collect the evidence bundle (shape documented in `scripts/edge-soak-report.mjs`'s
   `SOAK_INPUT_SHAPE`) into e.g. `soak.json`. `--db` may *supplement* it with persisted
   `security_events` anomaly rows; it can never replace it.
3. Read the verdict first if you want it in isolation:
   `node scripts/edge-soak-report.mjs --input=soak.json`
4. Request the authorization **within 6 hours of the soak closing**:

   ```bash
   node scripts/edge-arming-gate.mjs authorize \
     --evidence=soak.json \
     --origin=https://ai-sports-betting-dime-ai-production.up.railway.app \
     --actor="<you>" --reason="<why arming now>" \
     --deployment="<railway deployment id>" \
     --out=docs/runbooks/edge-arming-authorization.json
   ```

   Exit 1 and no file written means **do not arm**. There is no second attempt that relaxes
   anything; collect qualifying evidence instead.
5. Land `docs/runbooks/edge-arming-authorization.json` through a reviewed PR. The `validate` job
   in `.github/workflows/edge-arming-gate.yml` re-derives the whole verdict from the evidence the
   record embeds — the stored `"verdict": "AUTHORIZED"` buys nothing.
6. Only now set `EDGE_MODE=on` in Railway and restart. Run §4 verification.

### 8.4 What the gate checks

| # | Condition | Where |
| --- | --- | --- |
| 1 | Real production evidence, not synthetic probes | `evaluateSoak` — CI/operator sources are excluded from the volume and shape counts |
| 2 | Bound to a configuration state | `binding.configFingerprint` = SHA-256 over `edgeProxy.ts` + `originLock.ts` + `edgeCircuitBreaker.ts`; re-checked against the checkout on every run |
| 2b | Bound to a deployment | `/health`'s `commit` must identify the build that produced the evidence |
| 3 | Expiration | evidence ≤ 6 h old at issue (`MAX_EVIDENCE_AGE_MS`); authorization valid 30 days (`AUTHORIZATION_TTL_MS`), then re-soak |
| 4 | Fail closed on malformed evidence | inherited from `evaluateSoak`; a non-array `errors` field is a data error, never coerced to `[]` |
| 5 | Fail closed on query errors | a collector failure in the bundle, an unreadable file, or an unreadable posture all FAIL |
| 6 | Observation duration | ≥ 60 minutes (`MIN_SOAK_MINUTES`) |
| 7 | Request volume | ≥ 500 **real** requests (`MIN_REAL_REQUESTS`) |
| 8 | Distinct sources | ≥ 25 distinct real sources (`MIN_DISTINCT_REAL_SOURCES`) |
| 9 | Source concentration | no real source > 25 % of real requests (`MAX_REAL_SHARE_PER_SOURCE`) |
| 10 | Legitimate would-deny | would-deny from non-CI, non-operator sources must be exactly 0 |
| 11 | Machine-readable | `--json` on every mode; the record is JSON with a `recordSha256` integrity digest |
| 12 | Audit trail | `audit.actor` + `audit.reason` are required to issue; the record lives in git under review, and each CI run is dated |

### 8.5 Reading posture — why the RAW origin, and why an empty body

Posture is inferred from **behaviour**. Environment variables are not readable from CI.

- **Probe the raw `*.up.railway.app` origin, never the Cloudflare host.** Through Cloudflare the
  lock always passes, so a CF-host probe would read `NOT_ARMED` forever and the gate would
  silently never fire.
- **ARMED requires a positive discriminator**, not a bare status code: `/health` 200 **and**
  naming a commit (the origin is up and serving *our* build) **and** the non-exempt path
  returning 403 **with a zero-length body** — `originLock` answers `res.status(403).end()`, which
  sends nothing.
- A 403 **with** a body is somebody else's 403 and classifies as `INDETERMINATE` (fail closed).
  This is not hypothetical: measured 2026-08-09, `curl https://aisportsbettingmodels.com/`
  returns **403 with a 4561-byte body** — Super Bot Fight Mode blocking the CLI, not the origin
  lock. A gate that trusted the status code alone would read that as "armed".
- `INDETERMINATE` always FAILS. "We could not tell" is never "it is fine".

### 8.6 Live posture at the time this section was written

Measured 2026-08-09 against `https://ai-sports-betting-dime-ai-production.up.railway.app`:
`/health` → 200 (`commit 5e70860`), `/` → **200, 12 486 bytes**, `/api/trpc/games.list` → 400.
The raw origin is serving requests itself, so **the origin lock is not enforcing** — the gate
reports `NOT_ARMED` and PASSes.

Read that precisely. `NOT_ARMED` means *the lock is not 403ing*; it does **not** by itself
distinguish `EDGE_MODE=log`, `EDGE_MODE=off`, `on`-with-no-secret (anti-lockout downgrade), or
`on`-with-the-breaker-tripped. All four are states in which the origin lock is not enforcing,
which is exactly what the gate needs to know.

### 8.7 Honest limits

- `enforce` is **detective** for the Railway-dashboard path. Nothing in this repository can stop
  an owner typing `on` into Railway, and the running server consults no repo artifact. What the
  gate guarantees is that arming without qualifying evidence becomes a red, dated, machine-readable
  CI failure within a day instead of an undetected state.
- `recordSha256` is an **integrity checksum, not a signature**. It catches truncation and partial
  edits. Authentication comes from the record living in git under review — and, more importantly,
  from `enforce` re-deriving the soak verdict from the embedded evidence rather than reading it,
  so a forged record must carry evidence that genuinely clears all eight conditions.
- The soak evidence itself still inherits §7's measurement gap: `edge_origin_ingress_anomaly` is
  a **lower bound**, because `www`-Host ingress is redirected before the lock. Cite it as a floor.
