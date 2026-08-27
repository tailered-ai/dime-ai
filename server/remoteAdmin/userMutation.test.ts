/**
 * userMutation.test.ts — unit tests for the Phase 2 tailered write-through
 * endpoint (contract v1-mutation). Pure logic through injected deps; the
 * express registrar is exercised with the fakeApp idiom from
 * customerSyncRoute.test.ts.
 *
 * Contract authority: docs/superpowers/specs/2026-08-27-dime-customer-writethrough-design.md
 * (tailered-os repo).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  MAX_MUTATION_BODY_BYTES,
  MUTATION_SIGNATURE_HEADER,
  REMOTE_MUTATION_PATH,
  executeRemoteMutation,
  registerRemoteAdminRoute,
  verifyTaileredSignature,
  type MutationDeps,
} from "./userMutation";
import type { SnapshotUser } from "../cron/customerSync";

const SECRET = "test-shared-secret";

function sign(rawBody: string, secret: string = SECRET): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

const NOW = Date.parse("2026-08-27T02:00:00.000Z");

function sanitizedUser(overrides: Partial<SnapshotUser> = {}): SnapshotUser {
  return {
    id: 42,
    email: "user@example.com",
    username: "user42",
    role: "user",
    hasAccess: true,
    expiryDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSignedIn: null,
    termsAccepted: true,
    termsAcceptedAt: null,
    discordId: null,
    discordUsername: null,
    discordConnectedAt: null,
    manualDiscordId: null,
    entitled: true,
    pendingSetup: false,
    accessSource: "manual",
    plan: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    cancelAtPeriodEnd: null,
    ...overrides,
  };
}

type DbUser = {
  id: number;
  username: string;
  hasAccess: boolean;
  expiryDate: number | null;
  stripePlanId: string | null;
  deletedAt: number | null;
  discordId?: string | null;
};

function dbUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    id: 42,
    username: "user42",
    hasAccess: true,
    expiryDate: null,
    stripePlanId: null,
    deletedAt: null,
    discordId: null,
    ...overrides,
  };
}

/** Wrap a row as the tri-state lookupUser dep returns it. */
function found(user: DbUser = dbUser()) {
  return { status: "found" as const, user };
}

function makeDeps(overrides: Partial<MutationDeps> = {}) {
  const calls = {
    updates: [] as Array<{ id: number; data: Record<string, unknown> }>,
    logouts: [] as number[],
    events: [] as Array<Record<string, unknown>>,
    manualIds: [] as Array<{ id: number; value: string | null }>,
  };
  const deps: MutationDeps = {
    lookupUser: vi.fn(async () => found()),
    updateUser: vi.fn(async (id: number, data: Record<string, unknown>) => {
      calls.updates.push({ id, data });
    }),
    setManualDiscordId: vi.fn(async (id: number, value: string | null) => {
      calls.manualIds.push({ id, value });
    }),
    findByDiscordSnowflake: vi.fn(async () => null),
    incrementTokenVersion: vi.fn(async (id: number) => {
      calls.logouts.push(id);
      return 7;
    }),
    recordEvent: vi.fn(async (params: Record<string, unknown>) => {
      calls.events.push(params);
    }),
    loadSanitizedUser: vi.fn(async () => sanitizedUser()),
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "user-mutation",
    version: 1,
    sentAt: new Date(NOW).toISOString(),
    id: 42,
    action: "update",
    set: { role: "admin" },
    ...overrides,
  });
}

async function run(
  raw: string,
  sig: string | null,
  deps: MutationDeps
): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = await executeRemoteMutation(raw, sig, deps);
  return out as { status: number; body: Record<string, unknown> };
}

beforeEach(() => {
  process.env.TAILERED_SYNC_SECRET = SECRET;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.TAILERED_SYNC_SECRET;
  vi.restoreAllMocks();
});

describe("verifyTaileredSignature", () => {
  it("accepts a correct signature over the exact raw body", () => {
    const raw = body();
    expect(verifyTaileredSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it("accepts uppercase hex (case-insensitive digest)", () => {
    const raw = body();
    const header = "sha256=" + sign(raw).slice("sha256=".length).toUpperCase();
    expect(verifyTaileredSignature(raw, header, SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const raw = body();
    expect(verifyTaileredSignature(raw, sign(raw, "other"), SECRET)).toBe(
      false
    );
  });

  it("rejects a signature over a different body", () => {
    expect(
      verifyTaileredSignature(body({ id: 43 }), sign(body()), SECRET)
    ).toBe(false);
  });

  it("rejects a missing, unprefixed, or non-hex header", () => {
    const raw = body();
    expect(verifyTaileredSignature(raw, null, SECRET)).toBe(false);
    expect(verifyTaileredSignature(raw, undefined, SECRET)).toBe(false);
    expect(
      verifyTaileredSignature(raw, sign(raw).slice("sha256=".length), SECRET)
    ).toBe(false);
    expect(verifyTaileredSignature(raw, "sha256=zz", SECRET)).toBe(false);
    expect(
      verifyTaileredSignature(raw, "sha256=" + "a".repeat(63), SECRET)
    ).toBe(false);
  });
});

describe("executeRemoteMutation — pre-auth ladder", () => {
  it("404 not_found when TAILERED_SYNC_SECRET is unprovisioned (fail closed)", async () => {
    delete process.env.TAILERED_SYNC_SECRET;
    const { deps, calls } = makeDeps();
    const raw = body();
    const out = await run(raw, sign(raw), deps);
    expect(out).toEqual({
      status: 404,
      body: { ok: false, error: "not_found" },
    });
    expect(calls.updates).toEqual([]);
  });

  it("404 not_found on a missing signature — same body as unprovisioned (no oracle)", async () => {
    const { deps, calls } = makeDeps();
    const out = await run(body(), null, deps);
    expect(out).toEqual({
      status: 404,
      body: { ok: false, error: "not_found" },
    });
    expect(calls.updates).toEqual([]);
  });

  it("404 not_found on a wrong signature", async () => {
    const { deps } = makeDeps();
    const raw = body();
    const out = await run(raw, sign(raw, "wrong"), deps);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ ok: false, error: "not_found" });
  });
});

describe("executeRemoteMutation — post-auth validation", () => {
  it("400 invalid_body on unparseable JSON", async () => {
    const { deps } = makeDeps();
    const raw = "{not json";
    const out = await run(raw, sign(raw), deps);
    expect(out).toEqual({
      status: 400,
      body: { ok: false, error: "invalid_body" },
    });
  });

  it("400 unsupported on a wrong kind or version", async () => {
    const { deps } = makeDeps();
    for (const raw of [body({ kind: "snapshot" }), body({ version: 2 })]) {
      const out = await run(raw, sign(raw), deps);
      expect(out).toEqual({
        status: 400,
        body: { ok: false, error: "unsupported" },
      });
    }
  });

  it("409 stale_request on unparseable, too-old, or too-future sentAt", async () => {
    const { deps } = makeDeps();
    const cases = [
      body({ sentAt: "garbage" }),
      body({ sentAt: new Date(NOW - 6 * 60 * 1000).toISOString() }),
      body({ sentAt: new Date(NOW + 6 * 60 * 1000).toISOString() }),
    ];
    for (const raw of cases) {
      const out = await run(raw, sign(raw), deps);
      expect(out).toEqual({
        status: 409,
        body: { ok: false, error: "stale_request" },
      });
    }
  });

  it("accepts sentAt just inside the ±5min window", async () => {
    const { deps } = makeDeps();
    const raw = body({
      sentAt: new Date(NOW - 4 * 60 * 1000).toISOString(),
    });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
  });

  it("400 invalid_body on structural failures", async () => {
    const { deps } = makeDeps();
    const cases = [
      body({ id: "42" }),
      body({ id: 1.5 }),
      body({ id: -1 }),
      body({ action: "delete" }),
      body({ set: {} }),
      body({ set: { role: "superadmin" } }),
      // "owner" is a valid dime role but NOT settable through this channel:
      // the shared secret must not be able to mint owners.
      body({ set: { role: "owner" } }),
      body({ set: { role: "admin", email: "x@y.z" } }),
      body({ set: { hasAccess: "yes" } }),
      body({ set: { expiryDate: "not-a-date" } }),
      body({ set: { expiryDate: 123 } }),
      body({ action: "update", set: undefined }),
      body({ action: "forceLogout", set: { role: "admin" } }),
    ];
    for (const raw of cases) {
      const out = await run(raw, sign(raw), deps);
      expect(out).toEqual({
        status: 400,
        body: { ok: false, error: "invalid_body" },
      });
    }
  });

  it("404 user_not_found when the target is absent or soft-deleted", async () => {
    for (const lookup of [
      { status: "not_found" as const },
      found(dbUser({ deletedAt: NOW })),
    ]) {
      const { deps, calls } = makeDeps({
        lookupUser: vi.fn(async () => lookup),
      });
      const raw = body();
      const out = await run(raw, sign(raw), deps);
      expect(out).toEqual({
        status: 404,
        body: { ok: false, error: "user_not_found" },
      });
      expect(calls.updates).toEqual([]);
    }
  });

  it("500 internal_error when the lookup is unavailable — a DB fault is not a 404", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => ({ status: "unavailable" as const })),
    });
    const raw = body();
    const out = await run(raw, sign(raw), deps);
    expect(out).toEqual({
      status: 500,
      body: { ok: false, error: "internal_error" },
    });
    expect(calls.updates).toEqual([]);
  });
});

describe("executeRemoteMutation — update action", () => {
  it("role-only change writes {role} and records NO entitlement event", async () => {
    const { deps, calls } = makeDeps();
    const raw = body({ set: { role: "handicapper" } });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
    expect(calls.updates).toEqual([{ id: 42, data: { role: "handicapper" } }]);
    expect(calls.events).toEqual([]);
  });

  it("access revoke records manual_revoke with before/after and actor tailered-console", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () =>
        found(
          dbUser({ hasAccess: true, expiryDate: 1000, stripePlanId: "plan-x" })
        )
      ),
    });
    const raw = body({ set: { hasAccess: false } });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
    expect(calls.updates).toEqual([{ id: 42, data: { hasAccess: false } }]);
    expect(calls.events).toEqual([
      {
        userId: 42,
        stripeEventId: null,
        eventType: "admin.update_user",
        reason: "manual_revoke",
        actor: "tailered-console",
        before: { hasAccess: true, planId: "plan-x", expiryDate: 1000 },
        after: { hasAccess: false, planId: "plan-x", expiryDate: 1000 },
      },
    ]);
  });

  it("access grant records manual_grant", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => found(dbUser({ hasAccess: false }))),
    });
    const raw = body({ set: { hasAccess: true } });
    await run(raw, sign(raw), deps);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0].reason).toBe("manual_grant");
  });

  it("no event when hasAccess is set to its current value (parity with updateUser)", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => found(dbUser({ hasAccess: true }))),
    });
    const raw = body({ set: { hasAccess: true } });
    await run(raw, sign(raw), deps);
    expect(calls.updates).toEqual([{ id: 42, data: { hasAccess: true } }]);
    expect(calls.events).toEqual([]);
  });

  it("expiry change converts ISO to ms, records manual_expiry_change", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => found(dbUser({ expiryDate: 1000 }))),
    });
    const iso = "2026-12-31T00:00:00.000Z";
    const raw = body({ set: { expiryDate: iso } });
    await run(raw, sign(raw), deps);
    expect(calls.updates).toEqual([
      { id: 42, data: { expiryDate: Date.parse(iso) } },
    ]);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0].reason).toBe("manual_expiry_change");
    expect(calls.events[0].after).toEqual({
      hasAccess: true,
      planId: null,
      expiryDate: Date.parse(iso),
    });
  });

  it("expiryDate null clears to lifetime and records the change", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => found(dbUser({ expiryDate: 1000 }))),
    });
    const raw = body({ set: { expiryDate: null } });
    await run(raw, sign(raw), deps);
    expect(calls.updates).toEqual([{ id: 42, data: { expiryDate: null } }]);
    expect(calls.events[0].reason).toBe("manual_expiry_change");
  });

  it("no event when expiryDate is set to its current value", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => found(dbUser({ expiryDate: null }))),
    });
    const raw = body({ set: { expiryDate: null } });
    await run(raw, sign(raw), deps);
    expect(calls.events).toEqual([]);
  });

  it("returns the freshly sanitized user on success", async () => {
    const fresh = sanitizedUser({ role: "admin" });
    const { deps } = makeDeps({
      loadSanitizedUser: vi.fn(async () => fresh),
    });
    const raw = body();
    const out = await run(raw, sign(raw), deps);
    expect(out).toEqual({ status: 200, body: { ok: true, user: fresh } });
  });
});

describe("executeRemoteMutation — forceLogout action", () => {
  it("increments tokenVersion and returns the sanitized user", async () => {
    const { deps, calls } = makeDeps();
    const raw = body({ action: "forceLogout", set: undefined });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
    expect(calls.logouts).toEqual([42]);
    expect(calls.updates).toEqual([]);
    expect((out.body as { user: SnapshotUser }).user.id).toBe(42);
  });
});

describe("executeRemoteMutation — faults", () => {
  it("500 internal_error when a collaborator throws (detail not leaked)", async () => {
    const { deps } = makeDeps({
      updateUser: vi.fn(async () => {
        throw new Error("db exploded with PII");
      }),
    });
    const raw = body();
    const out = await run(raw, sign(raw), deps);
    expect(out).toEqual({
      status: 500,
      body: { ok: false, error: "internal_error" },
    });
  });

  it("500 internal_error when the sanitized reload comes back empty", async () => {
    const { deps } = makeDeps({
      loadSanitizedUser: vi.fn(async () => null),
    });
    const raw = body();
    const out = await run(raw, sign(raw), deps);
    expect(out).toEqual({
      status: 500,
      body: { ok: false, error: "internal_error" },
    });
  });
});

describe("registerRemoteAdminRoute", () => {
  function fakeApp() {
    const registrations: Array<{ path: string; middlewares: number }> = [];
    const handlers = new Map<string, (req: unknown, res: unknown) => unknown>();
    return {
      registrations,
      handlers,
      app: {
        post: (path: string, ...fns: Array<(...a: unknown[]) => unknown>) => {
          registrations.push({ path, middlewares: fns.length - 1 });
          handlers.set(`POST ${path}`, fns[fns.length - 1] as never);
        },
      } as never,
    };
  }

  function fakeRes() {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status: (code: number) => {
        captured.status = code;
        return {
          json: (b: unknown) => {
            captured.body = b;
          },
        };
      },
    };
    return { captured, res };
  }

  it("registers POST with a raw-body middleware in front of the handler", () => {
    const { app, registrations } = fakeApp();
    registerRemoteAdminRoute(app);
    expect(registrations).toEqual([
      { path: REMOTE_MUTATION_PATH, middlewares: 1 },
    ]);
    expect(REMOTE_MUTATION_PATH).toBe("/api/admin/remote/user-mutation");
    expect(MUTATION_SIGNATURE_HEADER).toBe("x-tailered-signature");
    expect(MAX_MUTATION_BODY_BYTES).toBe(64 * 1024);
  });

  it("mounts the rate limiter ahead of the raw-body middleware when given one", () => {
    const { app, registrations } = fakeApp();
    const limiter = ((_req: unknown, _res: unknown, next: () => void) =>
      next()) as never;
    registerRemoteAdminRoute(app, limiter);
    // limiter + raw-body middleware = 2 middlewares before the handler.
    expect(registrations).toEqual([
      { path: REMOTE_MUTATION_PATH, middlewares: 2 },
    ]);
  });

  it("wires header + raw body through to the ladder (bad signature → 404)", async () => {
    const { app, handlers } = fakeApp();
    registerRemoteAdminRoute(app);
    const h = handlers.get(`POST ${REMOTE_MUTATION_PATH}`)!;
    const { captured, res } = fakeRes();
    await h(
      {
        body: Buffer.from(body()),
        headers: { [MUTATION_SIGNATURE_HEADER]: "sha256=bad" },
      },
      res
    );
    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ ok: false, error: "not_found" });
  });
});

describe("executeRemoteMutation — setManualDiscordId (v1.1 identity write)", () => {
  const SNOW = "123456789012345678"; // 18 digits
  // A different fake snowflake for the "already has a live connection" case.
  // Held in a const (not an inline `discordId: "…"` literal) so the gitleaks
  // discord-client-id rule does not false-positive on a test fixture.
  const LIVE_SNOW = "999888777666555444";

  function manualBody(overrides: Record<string, unknown> = {}): string {
    return body({
      action: "setManualDiscordId",
      manualDiscordId: SNOW,
      set: undefined,
      ...overrides,
    });
  }

  it("sets a valid snowflake and returns the sanitized user", async () => {
    const { deps, calls } = makeDeps({
      loadSanitizedUser: vi.fn(async () =>
        sanitizedUser({ manualDiscordId: SNOW })
      ),
    });
    const raw = manualBody();
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
    expect(calls.manualIds).toEqual([{ id: 42, value: SNOW }]);
    expect((out.body.user as { manualDiscordId: string }).manualDiscordId).toBe(
      SNOW
    );
  });

  it("clears the manual id when given an empty string", async () => {
    const { deps, calls } = makeDeps();
    const raw = manualBody({ manualDiscordId: "" });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
    expect(calls.manualIds).toEqual([{ id: 42, value: null }]);
    // A clear never runs the uniqueness/connected guards.
    expect(deps.findByDiscordSnowflake).not.toHaveBeenCalled();
  });

  it("rejects a non-snowflake id with 400 invalid_discord_id", async () => {
    const { deps, calls } = makeDeps();
    for (const bad of [
      "12345",
      "abcdefghijklmnopqr",
      "123456789012345678901",
    ]) {
      const raw = manualBody({ manualDiscordId: bad });
      const out = await run(raw, sign(raw), deps);
      expect(out.status).toBe(400);
      expect(out.body).toEqual({ ok: false, error: "invalid_discord_id" });
    }
    expect(calls.manualIds).toEqual([]);
  });

  it("refuses to overwrite a user who already has a live discordId (409 already_connected)", async () => {
    const { deps, calls } = makeDeps({
      lookupUser: vi.fn(async () => found(dbUser({ discordId: LIVE_SNOW }))),
    });
    const raw = manualBody();
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ ok: false, error: "already_connected" });
    expect(calls.manualIds).toEqual([]);
  });

  it("rejects a snowflake already held by another user (409 discord_id_taken)", async () => {
    const { deps, calls } = makeDeps({
      findByDiscordSnowflake: vi.fn(async () => ({
        id: 7,
        username: "someone-else",
      })),
    });
    const raw = manualBody();
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ ok: false, error: "discord_id_taken" });
    expect(calls.manualIds).toEqual([]);
  });

  it("allows re-setting the SAME user's own snowflake (clash id === target id)", async () => {
    const { deps, calls } = makeDeps({
      findByDiscordSnowflake: vi.fn(async () => ({
        id: 42,
        username: "user42",
      })),
    });
    const raw = manualBody();
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(200);
    expect(calls.manualIds).toEqual([{ id: 42, value: SNOW }]);
  });

  it("rejects a stray `set` on the action (400 invalid_body)", async () => {
    const { deps } = makeDeps();
    const raw = body({
      action: "setManualDiscordId",
      manualDiscordId: SNOW,
      set: { role: "admin" },
    });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ ok: false, error: "invalid_body" });
  });

  it("rejects a stray manualDiscordId on an update action (400 invalid_body)", async () => {
    const { deps } = makeDeps();
    const raw = body({
      action: "update",
      set: { role: "admin" },
      manualDiscordId: SNOW,
    });
    const out = await run(raw, sign(raw), deps);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ ok: false, error: "invalid_body" });
  });
});
