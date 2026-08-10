/**
 * originLockObservability.test.ts
 *
 * Closes the §7 measurement gap recorded in
 * docs/runbooks/edge-defense-cloudflare.md.
 *
 * THE GAP. server/_core/index.ts registers the `www.` → apex 308 redirect
 * BEFORE the `originLock` mount, and Express runs middleware in registration
 * order. A `www` Host whose apex is allowlisted is therefore terminated by
 * `res.redirect(308, …)` and never reaches the lock — so it is neither blocked
 * nor counted, and every `edge_origin_ingress_anomaly` number this project has
 * produced is a LOWER BOUND on direct-origin ingress rather than a measurement
 * of it. The one signal that did fire, the `[www→canonical]` log line, carried
 * host / path / target only: no upstream IP and no edge-verification result, so
 * it could not distinguish a Cloudflare-fronted `www` request from a
 * direct-origin one.
 *
 * WHAT IS UNDER TEST. `observeWwwRedirectIngress()` in index.ts, invoked from
 * inside the redirect branch immediately before the 308 is issued. It is the
 * §7 "what would close it" recommendation 3 (explicit instrumentation), NOT
 * recommendation 1 (reordering): reordering is gated on a Cloudflare
 * Transform-Rule precondition that cannot be verified from this repo, and if
 * that rule turns out to be apex-scoped, putting the lock first would 403 every
 * Cloudflare-fronted `www` request. Request flow is therefore UNCHANGED — the
 * assertions below pin that as hard as they pin the new telemetry.
 *
 * HOW IT IS TESTED. index.ts self-executes `startServer()` at import time
 * (binds a port, connects to the DB, starts the Discord bot and every
 * background scheduler), so — per the precedent in wwwCanonicalRedirect.test.ts,
 * originLockAlertRouting.test.ts and clientIdentityCallSites.test.ts — it
 * cannot be imported. The three helper functions and the `app.use` redirect
 * block are sliced out of the real source, type-stripped with esbuild, and
 * evaluated onto a real Express app served over real `node:http`, mounted in
 * the SHIPPED order ahead of the REAL `originLock` middleware imported from
 * ./originLock. Nothing here re-implements the logic under test.
 *
 * `edgeMode`, `edgeProofPasses`, `immediateUpstreamIp` and `resolveClientIp`
 * are the real modules. Only `fireRateLimitEvent` is a spy — the real one
 * writes to `security_events` and posts to Discord. Because a spy could make
 * this whole file a lie, a source-contract `describe` at the end asserts the
 * SHIPPED call passes the `edge_origin_ingress_anomaly` slug with
 * outcome="observed", so the spy cannot be recording arguments the real call
 * site does not use.
 *
 * Requests use raw `node:http`, not `fetch()` — WHATWG fetch silently drops a
 * caller-supplied `Host` header, the exact footgun that produced a false
 * negative while §7 was being written.
 *
 * NOTE ON COVERAGE: tsconfig excludes `**\/*.test.ts`, so `tsc --noEmit` does
 * NOT type-check this file. It is a vitest-only gate. Every config object below
 * therefore sets every field EXPLICITLY — a field omitted from a config object
 * reads as `undefined` at runtime and silently disables the branch under test.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { transformSync } from "esbuild";
import express from "express";
import type { Express, RequestHandler } from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { edgeMode, edgeProofPasses, immediateUpstreamIp } from "./edgeProxy";
import { resolveClientIp } from "./trpcRateLimitPolicy";
import { originLock, type OriginLockEvent } from "./originLock";
import type { EdgeBreakerConfig } from "./edgeCircuitBreaker";

const INDEX_SRC = readFileSync(
  path.join(import.meta.dirname, "index.ts"),
  "utf8"
);

const APEX = "aisportsbettingmodels.com";
const EDGE_SECRET = "test-edge-secret-originlock-observability";
/** Inside CF_IPV4_CIDRS (104.16.0.0/13) — a Cloudflare PoP egress. */
const CF_UPSTREAM = "104.16.5.5";
/** TEST-NET-3, deliberately NOT in any Cloudflare range — a direct-origin hit. */
const DIRECT_UPSTREAM = "203.0.113.9";
/** The visitor Cloudflare asserts in cf-connecting-ip. */
const TRUE_CLIENT = "198.51.100.7";

// ─── Source extraction (the shipped text, not a reduction) ───────────────────

/** Slice a top-level `function <name>(...) { … }` declaration out of the source. */
function extractFunction(name: string): string {
  const start = INDEX_SRC.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(
      `function ${name}() not found in index.ts — has the www redirect / origin-lock observation been restructured?`
    );
  }
  const bodyStart = INDEX_SRC.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < INDEX_SRC.length; i++) {
    if (INDEX_SRC[i] === "{") depth++;
    else if (INDEX_SRC[i] === "}") {
      depth--;
      if (depth === 0) return INDEX_SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

/** Slice the `app.use(...)` block that performs the www→apex redirect. */
function extractRedirectMiddleware(): string {
  const marker = "─── www → non-www canonical redirect (308) ";
  const markerAt = INDEX_SRC.indexOf(marker);
  if (markerAt === -1) {
    throw new Error("www→canonical section marker not found in index.ts");
  }
  const start = INDEX_SRC.indexOf("app.use(", markerAt);
  const end = INDEX_SRC.indexOf("\n  });", start);
  if (start === -1 || end === -1) {
    throw new Error("www→canonical app.use block not found in index.ts");
  }
  return INDEX_SRC.slice(start, end + "\n  });".length);
}

const SHIPPED_HELPERS = [
  extractFunction("canonicalApexHosts"),
  extractFunction("wwwRedirectTarget"),
  extractFunction("observeWwwRedirectIngress"),
].join("\n\n");
const SHIPPED_MIDDLEWARE = extractRedirectMiddleware();

// ─── Telemetry spies ─────────────────────────────────────────────────────────

type FiredEvent = {
  ip: string;
  path: string;
  method: string;
  limitType: string;
  ua: string | null;
  outcome: string | undefined;
};

const fired: FiredEvent[] = [];
const lockEvents: OriginLockEvent[] = [];

function fireRateLimitEventSpy(
  ip: string,
  reqPath: string,
  method: string,
  limitType: string,
  ua: string | null,
  outcome?: string
): void {
  fired.push({ ip, path: reqPath, method, limitType, ua, outcome });
}

/**
 * Breaker config with EVERY field set explicitly and `disabled: true`, so
 * enforcement is unconditional for the whole suite. Left to the env defaults,
 * a run of unverified requests could trip the breaker mid-suite and silently
 * convert a 403 assertion into a 200 — the exact "a missing field disables the
 * branch under test" trap this repo has been burned by.
 */
const STABLE_BREAKER: EdgeBreakerConfig = {
  windowMs: 60_000,
  minSample: 1_000_000,
  verifiedFloor: 0,
  tripWindows: 1_000_000,
  recoverFloor: 1,
  bypassAlertFraction: 1,
  bypassAlertWindows: 1_000_000,
  disabled: true,
};

// ─── Harness ─────────────────────────────────────────────────────────────────

/**
 * Mounts, in the SHIPPED registration order:
 *   1. the extracted www→apex redirect middleware (which calls the extracted
 *      observeWwwRedirectIngress),
 *   2. the REAL originLock middleware,
 *   3. `/health` (registered after the lock, exactly as index.ts does — the
 *      exemption lives inside originLock, keyed on req.path),
 *   4. a terminal handler proving the request reached normal routing.
 */
function buildApp(lockMw: RequestHandler): Express {
  const js = transformSync(
    `${SHIPPED_HELPERS}\n\n` +
      `const app = expressFn();\n` +
      `app.set("trust proxy", 1);\n` +
      `${SHIPPED_MIDDLEWARE}\n` +
      `app.use(originLockMw);\n` +
      `app.get("/health", (req, res) => { res.status(200).send("HEALTH_OK"); });\n` +
      `app.use((req, res) => { res.status(200).send("ORIGIN_CONTENT"); });\n` +
      `return app;`,
    { loader: "ts" }
  ).code;
  const factory = new Function(
    "expressFn",
    "logSafe",
    "edgeMode",
    "edgeProofPasses",
    "immediateUpstreamIp",
    "resolveClientIp",
    "fireRateLimitEvent",
    "originLockMw",
    js
  ) as (
    expressFn: typeof express,
    logSafe: (v: unknown) => string,
    edgeModeFn: typeof edgeMode,
    edgeProofPassesFn: typeof edgeProofPasses,
    immediateUpstreamIpFn: typeof immediateUpstreamIp,
    resolveClientIpFn: typeof resolveClientIp,
    fireRateLimitEventFn: typeof fireRateLimitEventSpy,
    originLockMwArg: RequestHandler
  ) => Express;
  return factory(
    express,
    v => String(v),
    edgeMode,
    edgeProofPasses,
    immediateUpstreamIp,
    resolveClientIp,
    fireRateLimitEventSpy,
    lockMw
  );
}

type Probe = { status: number; location: string | null; body: string };

function request(
  port: number,
  hostHeader: string,
  reqPath: string,
  headers: Record<string, string> = {},
  method = "GET"
): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: { Host: hostHeader, ...headers },
      },
      res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", c => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: (res.headers.location as string | undefined) ?? null,
            body,
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Headers of a genuine Cloudflare-fronted request (passes edgeProofPasses). */
const VIA_CLOUDFLARE: Record<string, string> = {
  "x-dime-edge-secret": EDGE_SECRET,
  "x-forwarded-for": CF_UPSTREAM,
  "cf-connecting-ip": TRUE_CLIENT,
  "user-agent": "cf-fronted-agent/1.0",
};

/** Headers of a raw direct-origin hit (no secret, non-CF upstream). */
const DIRECT_ORIGIN: Record<string, string> = {
  "x-forwarded-for": DIRECT_UPSTREAM,
  "user-agent": "direct-origin-agent/1.0",
};

async function listen(app: Express): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port bound");
  return {
    port: addr.port,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

const anomalies = (): FiredEvent[] =>
  fired.filter(e => e.limitType === "edge_origin_ingress_anomaly");

// ─── ARMED (EDGE_MODE=on, secret configured) ─────────────────────────────────

describe("origin-lock observability — EDGE_MODE=on, secret configured (shipped index.ts text + real originLock)", () => {
  let port = 0;
  let close: () => Promise<void>;
  const saved: Record<string, string | undefined> = {};
  let logLines: string[] = [];

  beforeAll(async () => {
    for (const k of [
      "EDGE_MODE",
      "EDGE_ORIGIN_SECRET",
      "EDGE_ORIGIN_SECRET_PREV",
      "PUBLIC_ORIGIN",
      "ADDITIONAL_ALLOWED_ORIGINS",
    ]) {
      saved[k] = process.env[k];
    }
    process.env.EDGE_MODE = "on";
    process.env.EDGE_ORIGIN_SECRET = EDGE_SECRET;
    delete process.env.EDGE_ORIGIN_SECRET_PREV;
    process.env.PUBLIC_ORIGIN = `https://${APEX}`;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;

    const lockMw = originLock(
      kind => {
        lockEvents.push(kind);
      },
      { breakerConfig: STABLE_BREAKER }
    );
    const started = await listen(buildApp(lockMw));
    port = started.port;
    close = started.close;
  });

  afterAll(async () => {
    await close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    fired.length = 0;
    lockEvents.length = 0;
    logLines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(a => String(a)).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Cloudflare-fronted traffic: unchanged, and correctly NOT flagged ──────

  it("canonical apex via Cloudflare is served and fires no anomaly", async () => {
    const res = await request(port, APEX, "/x", VIA_CLOUDFLARE);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ORIGIN_CONTENT");
    expect(anomalies()).toHaveLength(0);
    expect(lockEvents).not.toContain("edge_deny");
  });

  it("www via Cloudflare still 308s to the apex and fires no anomaly, but the log line now proves it was edge-verified", async () => {
    const res = await request(port, `www.${APEX}`, "/x", VIA_CLOUDFLARE);
    expect(res.status).toBe(308);
    expect(res.location).toBe(`http://${APEX}/x`);
    expect(anomalies()).toHaveLength(0);

    // The §7 complaint about the old log line was that it carried no upstream
    // IP and no verification result. Both must now be present.
    const line = logLines.find(l => l.includes("[www→canonical]"));
    expect(line, "no [www→canonical] log line emitted").toBeDefined();
    expect(line).toContain("edgeVerified=true");
    expect(line).toContain(`upstream=${CF_UPSTREAM}`);
    expect(line).toContain("counted=false");
    expect(line).toContain("edgeMode=on");
  });

  // ── Direct-origin traffic: apex is blocked+counted, www is now counted ────

  it("direct origin with the apex Host is 403'd by the lock and counted (the pre-existing path, unchanged)", async () => {
    const res = await request(port, APEX, "/x", DIRECT_ORIGIN);
    expect(res.status).toBe(403);
    expect(lockEvents).toContain("edge_deny");
  });

  it("THE GAP CLOSURE — direct origin with a www Host still 308s (flow unchanged) AND now emits origin-lock telemetry", async () => {
    const res = await request(
      port,
      `www.${APEX}`,
      "/api/trpc/appUsers.me",
      DIRECT_ORIGIN
    );

    // Flow is UNCHANGED: same status, same target, still method-preserving.
    expect(res.status).toBe(308);
    expect(res.location).toBe(`http://${APEX}/api/trpc/appUsers.me`);

    // …and it is no longer invisible.
    const hits = anomalies();
    expect(
      hits,
      "direct-origin www request produced no edge_origin_ingress_anomaly — the §7 gap is open again"
    ).toHaveLength(1);
    expect(hits[0].ip).toBe(DIRECT_UPSTREAM);
    expect(hits[0].path).toBe("/api/trpc/appUsers.me");
    expect(hits[0].method).toBe("GET");
    expect(hits[0].ua).toBe("direct-origin-agent/1.0");
    // NEVER "blocked": the request was served a 308, not a 403. Claiming
    // "blocked" here is the 2026-08-07 defect (a 200-served request posting an
    // "IP Blocked / 429" embed).
    expect(hits[0].outcome).toBe("observed");

    const line = logLines.find(l => l.includes("[www→canonical]"));
    expect(line).toContain("edgeVerified=false");
    expect(line).toContain(`upstream=${DIRECT_UPSTREAM}`);
    expect(line).toContain("counted=true");
  });

  it("a legitimate POST redirect is still a 308 (body-preserving), and is measured", async () => {
    const res = await request(
      port,
      `www.${APEX}`,
      "/api/login",
      DIRECT_ORIGIN,
      "POST"
    );
    expect(res.status).toBe(308);
    expect(res.status).not.toBe(301);
    expect(res.location).toBe(`http://${APEX}/api/login`);
    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0].method).toBe("POST");
  });

  // ── No double counting ───────────────────────────────────────────────────

  it("an unallowlisted www Host is NOT redirected, falls through to the lock, and is counted ONCE — by the lock, not by the observer", async () => {
    const res = await request(port, "www.evil.com", "/x", DIRECT_ORIGIN);
    expect(res.location).toBeNull();
    expect(res.status).toBe(403);
    expect(lockEvents).toContain("edge_deny");
    // The observer must not have fired: only the lock's own edge_deny path is
    // allowed to count this request, or the counter double-counts.
    expect(anomalies()).toHaveLength(0);
    expect(logLines.some(l => l.includes("[www→canonical]"))).toBe(false);
  });

  it("an unallowlisted non-www Host is 403'd by the lock", async () => {
    const res = await request(port, "evil.com", "/x", DIRECT_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.location).toBeNull();
    expect(anomalies()).toHaveLength(0);
  });

  // ── Redirect safety must remain intact (the 2026-08-07 authority fix) ────

  const PROHIBITED_AUTHORITIES: Array<[string, string]> = [
    ["userinfo via empty password", `www.${APEX}:@evil.com`],
    ["userinfo via credentials", `www.${APEX}:pw@evil.com`],
    ["bare userinfo at-sign", `www.${APEX}@evil.com`],
    ["path delimiter", `www.${APEX}/evil.com`],
    ["backslash delimiter", `www.${APEX}\\evil.com`],
    ["query delimiter", `www.${APEX}?x=evil.com`],
    ["fragment delimiter", `www.${APEX}#evil.com`],
    ["non-numeric port", `www.${APEX}:evil.com`],
    ["port overflow", `www.${APEX}:99999`],
  ];

  for (const [label, hostHeader] of PROHIBITED_AUTHORITIES) {
    it(`malformed/prohibited redirect authority is still refused and falls to the lock — ${label}`, async () => {
      const res = await request(port, hostHeader, "/x", DIRECT_ORIGIN);
      expect(res.location).toBeNull();
      expect(res.status).not.toBe(308);
      // Not redirected ⇒ reaches the lock ⇒ 403 on a direct-origin hit.
      expect(res.status).toBe(403);
      expect(anomalies()).toHaveLength(0);
    });
  }

  // ── Health must stay reachable and lock-exempt ───────────────────────────

  it("/health on the origin Host stays 200 and lock-exempt (Railway's probe kills the deploy otherwise)", async () => {
    const res = await request(
      port,
      "dime-ai.up.railway.app",
      "/health",
      DIRECT_ORIGIN
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("HEALTH_OK");
    expect(lockEvents).not.toContain("edge_deny");
    expect(anomalies()).toHaveLength(0);
  });

  it("/health on the apex Host, direct origin, stays 200 and generates no security event", async () => {
    const res = await request(port, APEX, "/health", DIRECT_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toBe("HEALTH_OK");
    expect(anomalies()).toHaveLength(0);
  });

  it("/health on a www Host redirects (unchanged) but the observer stays silent, mirroring originLock's own /health exemption", async () => {
    const res = await request(port, `www.${APEX}`, "/health", DIRECT_ORIGIN);
    expect(res.status).toBe(308);
    expect(res.location).toBe(`http://${APEX}/health`);
    expect(
      anomalies(),
      "the health probe must never be able to generate a security event"
    ).toHaveLength(0);
    const line = logLines.find(l => l.includes("[www→canonical]"));
    expect(line).toContain("counted=false");
  });
});

// ─── DORMANT (EDGE_MODE unset) ───────────────────────────────────────────────

describe("origin-lock observability — EDGE_MODE off: the observation is inert", () => {
  let port = 0;
  let close: () => Promise<void>;
  const saved: Record<string, string | undefined> = {};
  let logLines: string[] = [];

  beforeAll(async () => {
    for (const k of [
      "EDGE_MODE",
      "EDGE_ORIGIN_SECRET",
      "PUBLIC_ORIGIN",
      "ADDITIONAL_ALLOWED_ORIGINS",
    ]) {
      saved[k] = process.env[k];
    }
    delete process.env.EDGE_MODE;
    delete process.env.EDGE_ORIGIN_SECRET;
    process.env.PUBLIC_ORIGIN = `https://${APEX}`;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;

    const lockMw = originLock(
      kind => {
        lockEvents.push(kind);
      },
      { breakerConfig: STABLE_BREAKER }
    );
    const started = await listen(buildApp(lockMw));
    port = started.port;
    close = started.close;
  });

  afterAll(async () => {
    await close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    fired.length = 0;
    lockEvents.length = 0;
    logLines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(a => String(a)).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a direct-origin www request redirects and fires nothing while the feature is dormant", async () => {
    const res = await request(port, `www.${APEX}`, "/x", DIRECT_ORIGIN);
    expect(res.status).toBe(308);
    expect(res.location).toBe(`http://${APEX}/x`);
    expect(anomalies()).toHaveLength(0);
    const line = logLines.find(l => l.includes("[www→canonical]"));
    expect(line).toContain("edgeMode=off");
    expect(line).toContain("edgeVerified=-");
    expect(line).toContain("counted=false");
  });

  it("a direct-origin apex request is passed straight through by the dormant lock", async () => {
    const res = await request(port, APEX, "/x", DIRECT_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ORIGIN_CONTENT");
    expect(lockEvents).toHaveLength(0);
  });
});

// ─── Source contract: the spy is not a lie ───────────────────────────────────

describe("source contract — the SHIPPED observation call, not the injected spy", () => {
  const OBSERVER_SRC = extractFunction("observeWwwRedirectIngress");

  it('fires the edge_origin_ingress_anomaly slug with outcome="observed" (never the "blocked" default)', () => {
    expect(OBSERVER_SRC).toMatch(
      /fireRateLimitEvent\(\s*upstream \|\| resolveClientIp\(req\),\s*req\.path,\s*req\.method,\s*"edge_origin_ingress_anomaly",\s*\(req\.headers\["user-agent"\][^;]*?,\s*"observed"\s*\)/
    );
    expect(OBSERVER_SRC).not.toMatch(/"blocked"/);
  });

  it("is a hard no-op when edge mode is off, so the merge is inert while the feature is dormant", () => {
    expect(OBSERVER_SRC).toMatch(/if \(mode === "off"\)/);
  });

  it("mirrors originLock's /health exemption", () => {
    expect(OBSERVER_SRC).toMatch(/req\.path === "\/health"/);
  });

  it("cannot throw into the redirect path — the whole body is wrapped", () => {
    expect(OBSERVER_SRC).toMatch(/try \{/);
    expect(OBSERVER_SRC).toMatch(/\} catch \(err\) \{/);
  });

  it("is invoked from inside the redirect branch, BEFORE res.redirect terminates the chain", () => {
    const mw = extractRedirectMiddleware();
    const callAt = mw.indexOf("observeWwwRedirectIngress(req)");
    const redirectAt = mw.indexOf("res.redirect(308");
    expect(
      callAt,
      "observeWwwRedirectIngress is not called by the middleware"
    ).toBeGreaterThan(-1);
    expect(redirectAt).toBeGreaterThan(callAt);
  });

  it("still registers the redirect ahead of the origin-lock mount — this change measures the gap, it does not reorder middleware", () => {
    const redirectAt = INDEX_SRC.indexOf(
      "─── www → non-www canonical redirect (308) "
    );
    const lockAt = INDEX_SRC.indexOf("Origin lock (Phase 4 edge defense)");
    expect(redirectAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(redirectAt);
  });
});
