/**
 * wwwCanonicalRedirect.test.ts
 *
 * The `www.` → apex 308 redirect in server/_core/index.ts used to derive its
 * target as `host.slice(4)` with NO allowlist, so ANY Host beginning with
 * "www." was echoed back as the redirect target:
 *
 *   Host: www.evil.com  →  308  Location: https://evil.com/<path>
 *
 * and because that middleware is registered BEFORE `originLock`, the origin
 * answered those unallowlisted Hosts even under EDGE_MODE=on.
 *
 * These tests drive the REAL middleware text out of index.ts. index.ts
 * self-executes `startServer()` at import time (binds a port, connects to the
 * DB, starts the Discord bot and every background scheduler), so — per the
 * precedent in originLockAlertRouting.test.ts / clientIdentityCallSites.test.ts
 * — it cannot be imported. Instead the two helper functions and the `app.use`
 * block are sliced out of the source, type-stripped with esbuild (the same
 * esbuild vitest itself runs on), and evaluated onto a real Express app served
 * over real `node:http`. Nothing here re-implements the logic under test: if
 * the shipped text changes, this file executes the changed text.
 *
 * Requests use raw `node:http`, not `fetch()` — WHATWG fetch silently drops a
 * caller-supplied `Host` header, which is the exact footgun that produced a
 * false negative while §7 of docs/runbooks/edge-defense-cloudflare.md was
 * being written.
 *
 * The final `describe` is a NEGATIVE CONTROL: it runs the pre-fix
 * implementation through the identical harness and asserts the harness sees
 * the open redirect. Without it, "www.evil.com is not redirected" could pass
 * for a harness that never reached the middleware at all.
 *
 * NOTE ON COVERAGE: tsconfig excludes test files, so `tsc --noEmit` does not
 * type-check this file. It is a vitest-only gate.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { transformSync } from "esbuild";
import express from "express";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeMode, edgeProofPasses, immediateUpstreamIp } from "./edgeProxy";
import { resolveClientIp } from "./trpcRateLimitPolicy";

const INDEX_SRC = readFileSync(
  path.join(import.meta.dirname, "index.ts"),
  "utf8"
);

const APEX = "aisportsbettingmodels.com";

/** Slice a top-level `function <name>(...) { … }` declaration out of the source. */
function extractFunction(name: string): string {
  const start = INDEX_SRC.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(
      `function ${name}() not found in index.ts — has the www redirect been restructured?`
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

/**
 * The origin-lock observation the redirect middleware now calls immediately
 * before issuing its 308 (docs/runbooks/edge-defense-cloudflare.md §7
 * recommendation 3). It is extracted and executed here too — not stubbed —
 * because this file's whole premise is that it runs the shipped text. Every
 * suite below pins `EDGE_MODE=off`, which is a hard no-op inside the observer,
 * so it cannot perturb the redirect assertions in this file. Its BEHAVIOUR
 * under `EDGE_MODE=on` is the subject of originLockObservability.test.ts.
 */
const SHIPPED_OBSERVER = extractFunction("observeWwwRedirectIngress");

/**
 * Build an Express app carrying `helpersSrc` + `middlewareSrc`, followed by a
 * terminal handler that reports the request reached normal routing. A `www`
 * Host that is NOT redirected must land there.
 */
function buildApp(helpersSrc: string, middlewareSrc: string): Express {
  const js = transformSync(
    `${SHIPPED_OBSERVER}\n\n${helpersSrc}\n\nconst app = expressFn();\n${middlewareSrc}\napp.use((req, res) => { res.status(200).send("ORIGIN_CONTENT"); });\nreturn app;`,
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
    js
  ) as (
    expressFn: typeof express,
    logSafe: (v: unknown) => string,
    edgeModeFn: typeof edgeMode,
    edgeProofPassesFn: typeof edgeProofPasses,
    immediateUpstreamIpFn: typeof immediateUpstreamIp,
    resolveClientIpFn: typeof resolveClientIp,
    fireRateLimitEventFn: (...args: unknown[]) => void
  ) => Express;
  return factory(
    express,
    v => String(v),
    edgeMode,
    edgeProofPasses,
    immediateUpstreamIp,
    resolveClientIp,
    (...args: unknown[]) => {
      firedFromRedirect.push(args);
    }
  );
}

/**
 * Anything the observer fires while this file's suites run. Asserted EMPTY:
 * with `EDGE_MODE=off` the observation must be completely inert, so a
 * regression that makes it fire regardless of mode fails here as well as in
 * originLockObservability.test.ts.
 */
const firedFromRedirect: unknown[][] = [];

const SHIPPED_HELPERS = `${extractFunction("canonicalApexHosts")}\n\n${extractFunction("wwwRedirectTarget")}`;
const SHIPPED_MIDDLEWARE = extractRedirectMiddleware();

// Pin EDGE_MODE for the WHOLE file, explicitly, both directions. Leaving it to
// whatever the ambient environment happens to hold would make the observer's
// inertness (and therefore every assertion here) depend on an unstated value.
const SAVED_EDGE_MODE = process.env.EDGE_MODE;
beforeAll(() => {
  process.env.EDGE_MODE = "off";
});
afterAll(() => {
  if (SAVED_EDGE_MODE === undefined) delete process.env.EDGE_MODE;
  else process.env.EDGE_MODE = SAVED_EDGE_MODE;
});

/**
 * The implementation as it stood BEFORE the allowlist, reconstructed for the
 * negative control only. Never executed by the app.
 */
const PRE_FIX_HELPERS = `
function wwwRedirectTarget(host: string): string | null {
  return host.startsWith("www.") ? host.slice(4) : null;
}
`;

type Probe = { status: number; location: string | null; body: string };

function request(
  port: number,
  hostHeader: string,
  reqPath: string,
  method = "GET"
): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: { Host: hostHeader },
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

describe("www→apex 308 redirect (shipped index.ts middleware)", () => {
  let port = 0;
  let close: () => Promise<void>;
  const savedPublicOrigin = process.env.PUBLIC_ORIGIN;
  const savedAdditional = process.env.ADDITIONAL_ALLOWED_ORIGINS;

  beforeAll(async () => {
    process.env.PUBLIC_ORIGIN = `https://${APEX}`;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
    const started = await listen(buildApp(SHIPPED_HELPERS, SHIPPED_MIDDLEWARE));
    port = started.port;
    close = started.close;
  });

  afterAll(async () => {
    await close();
    if (savedPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = savedPublicOrigin;
    if (savedAdditional === undefined)
      delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
    else process.env.ADDITIONAL_ALLOWED_ORIGINS = savedAdditional;
  });

  it("still 308s the real www host to the apex, preserving the path", async () => {
    const res = await request(port, `www.${APEX}`, "/api/trpc/appUsers.me");
    expect(res.status).toBe(308);
    expect(res.location).toBe(
      `http://${APEX}/api/trpc/appUsers.me` // req.protocol is http on the raw test socket
    );
  });

  it("still 308s (not 301) a POST, so the body survives the redirect", async () => {
    const res = await request(port, `www.${APEX}`, "/api/login", "POST");
    expect(res.status).toBe(308);
    expect(res.status).not.toBe(301);
  });

  it("does NOT redirect an unallowlisted www host — falls through to routing", async () => {
    const res = await request(port, "www.evil.com", "/api/trpc/appUsers.me");
    expect(res.location).toBeNull();
    expect(res.status).not.toBe(308);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ORIGIN_CONTENT");
  });

  it("does not redirect a www host that merely SUFFIXES the apex", async () => {
    const res = await request(port, `www.evil-${APEX}.attacker.test`, "/");
    expect(res.location).toBeNull();
    expect(res.status).toBe(200);
  });

  it("is case-insensitive on the allowlisted host (Host headers are)", async () => {
    const res = await request(port, `WWW.${APEX.toUpperCase()}`, "/x");
    expect(res.status).toBe(308);
    expect(res.location).toBe(`http://${APEX}/x`);
  });

  it("leaves a non-www host alone", async () => {
    const res = await request(port, APEX, "/x");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ORIGIN_CONTENT");
  });

  it("keeps the port suffix on an allowlisted host", async () => {
    const res = await request(port, `www.${APEX}:8080`, "/x");
    expect(res.status).toBe(308);
    expect(res.location).toBe(`http://${APEX}:8080/x`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Authority-delimiter bypasses of the allowlist.
  //
  // The first version of this allowlist validated `stripped.split(":")[0]` but
  // returned the unvalidated `stripped`. That is an open redirect that launders
  // itself THROUGH the allowlist: `www.<apex>:@evil.com` strips to
  // `<apex>:@evil.com`, whose split(":")[0] is the allowlisted apex, while the
  // returned string parses as userinfo `<apex>:` against host `evil.com`.
  //
  // Every case below must NOT redirect. Asserting `status !== 308` alone is too
  // weak — a redirect to the wrong host would satisfy some of those — so each
  // also asserts the Location header is absent and the origin served its own
  // content.
  // ───────────────────────────────────────────────────────────────────────────
  const BYPASS_SHAPES: Array<[string, string]> = [
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

  for (const [label, hostHeader] of BYPASS_SHAPES) {
    it(`refuses to redirect — ${label}`, async () => {
      const res = await request(port, hostHeader, "/x");
      expect(res.location).toBeNull();
      expect(res.status).not.toBe(308);
      expect(res.body).toBe("ORIGIN_CONTENT");
    });
  }

  it("redirects nothing when PUBLIC_ORIGIN is unset (empty allowlist)", async () => {
    const saved = process.env.PUBLIC_ORIGIN;
    delete process.env.PUBLIC_ORIGIN;
    try {
      const res = await request(port, `www.${APEX}`, "/x");
      expect(res.status).toBe(200);
      expect(res.location).toBeNull();
    } finally {
      process.env.PUBLIC_ORIGIN = saved;
    }
  });

  it("fires no origin-lock telemetry at all while EDGE_MODE is off (the observation is a hard no-op when the feature is dormant)", async () => {
    firedFromRedirect.length = 0;
    await request(port, `www.${APEX}`, "/x");
    await request(port, APEX, "/x");
    await request(port, "www.evil.com", "/x");
    expect(firedFromRedirect).toHaveLength(0);
  });

  it("honours ADDITIONAL_ALLOWED_ORIGINS, the other origin set the app already declares", async () => {
    process.env.ADDITIONAL_ALLOWED_ORIGINS = "https://preview.example.test";
    try {
      const res = await request(port, "www.preview.example.test", "/x");
      expect(res.status).toBe(308);
      expect(res.location).toBe("http://preview.example.test/x");
    } finally {
      delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
    }
  });
});

describe("negative control — the pre-fix implementation IS an open redirect", () => {
  let port = 0;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const started = await listen(buildApp(PRE_FIX_HELPERS, SHIPPED_MIDDLEWARE));
    port = started.port;
    close = started.close;
  });

  afterAll(async () => {
    await close();
  });

  it("proves the harness can see the defect: host.slice(4) 308s www.evil.com to evil.com", async () => {
    const res = await request(port, "www.evil.com", "/api/trpc/appUsers.me");
    expect(res.status).toBe(308);
    expect(res.location).toBe("http://evil.com/api/trpc/appUsers.me");
  });
});
