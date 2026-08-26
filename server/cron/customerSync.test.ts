/**
 * customerSync.test.ts — unit tests for the tailered.ai customer-mirror
 * snapshot builder, HMAC signer, and push client (Phase 1, contract v1).
 *
 * Contract authority: docs/superpowers/specs/2026-08-26-dime-customer-mirror-design.md
 * (tailered-os repo). Everything here runs against injected fixtures — no DB,
 * no network. The default DB-backed loaders are exercised only in production.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  buildCustomerSnapshot,
  signSnapshot,
  pushCustomerSnapshot,
  type BillingCatalogue,
  type CustomerSourceRow,
} from "./customerSync";

// ─── Default-loader collaborators, mocked so the DB-unavailable / breaker-open
// paths of loadRowsFromDb can be exercised without a real pool. The mocks are
// inert for every test that injects loadRows/loadCatalogue (nothing imports
// ../db in those paths).
const { getDbMock, withCircuitBreakerMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  withCircuitBreakerMock: vi.fn(),
}));
vi.mock("../db", () => ({ getDb: getDbMock }));
vi.mock("../dbCircuitBreaker", () => ({
  withCircuitBreaker: withCircuitBreakerMock,
}));

/** The contract's forbidden-fields list — must never appear ANYWHERE in the payload. */
const FORBIDDEN = [
  "passwordHash",
  "passwordResetToken",
  "passwordResetExpiresAt",
  "failedLoginCount",
  "firstFailedLoginAt",
  "lockedUntil",
  "tokenVersion",
  "pendingStripeSessionId",
  "pendingEmail",
  "pendingUsername",
];

/** A fully-populated live row, including every forbidden column, as the DB would return it. */
function fixtureRow(
  overrides: Record<string, unknown> = {}
): CustomerSourceRow {
  return {
    id: 42,
    email: "member@example.com",
    username: "member42",
    role: "user",
    hasAccess: true,
    expiryDate: null, // lifetime
    deletedAt: null,
    termsAccepted: true,
    termsAcceptedAt: 1750000000000,
    discordId: "123456789012345678",
    discordUsername: "member#0042",
    discordAvatar: "abcdef",
    discordConnectedAt: 1750000001000,
    manualDiscordId: null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    lastSignedIn: new Date("2026-08-01T12:00:00.000Z"),
    stripeCustomerId: "cus_TEST123",
    stripeSubscriptionId: "sub_TEST123",
    stripePlanId: "pro",
    planPriceId: 7,
    stripeSubscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    pendingSetup: false,
    // ── forbidden columns, ALL populated — must never survive sanitization ──
    passwordHash: "$2a$10$dummy-not-a-real-hash",
    passwordResetToken: "dummy-reset-token",
    passwordResetExpiresAt: 1750000002000,
    failedLoginCount: 3,
    firstFailedLoginAt: 1750000003000,
    lockedUntil: 1750000004000,
    tokenVersion: 9,
    pendingStripeSessionId: "cs_test_dummy",
    pendingEmail: "pending@example.com",
    pendingUsername: "pending42",
    ...overrides,
  } as CustomerSourceRow;
}

function fixtureCatalogue(): BillingCatalogue {
  const proPlan = { slug: "pro", name: "Pro", planType: "recurring" };
  const lifetimePlan = {
    slug: "lifetime",
    name: "Lifetime",
    planType: "one_time",
  };
  return {
    byPriceId: new Map([
      [
        7,
        {
          amountCents: 4900,
          currency: "usd",
          billingInterval: "month",
          plan: proPlan,
        },
      ],
      [
        8,
        {
          amountCents: 99999,
          currency: "usd",
          billingInterval: null, // one-off = lifetime SKU
          plan: lifetimePlan,
        },
      ],
    ]),
    byPlanSlug: new Map([
      ["pro", proPlan],
      ["lifetime", lifetimePlan],
    ]),
  };
}

function deps(
  rows: CustomerSourceRow[],
  catalogue: BillingCatalogue = fixtureCatalogue()
) {
  return {
    loadRows: async () => rows,
    loadCatalogue: async () => catalogue,
    now: () => Date.parse("2026-08-26T19:00:00.000Z"),
  };
}

beforeEach(() => {
  delete process.env.TAILERED_SYNC_URL;
  delete process.env.TAILERED_SYNC_SECRET;
  getDbMock.mockReset();
  withCircuitBreakerMock.mockReset();
  // Default: closed breaker — pass the wrapped query straight through.
  withCircuitBreakerMock.mockImplementation(
    async (fn: () => Promise<unknown>) => fn()
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.TAILERED_SYNC_URL;
  delete process.env.TAILERED_SYNC_SECRET;
  vi.restoreAllMocks();
});

describe("buildCustomerSnapshot", () => {
  it("never serializes any forbidden field, recursively, from a fully-poisoned row", async () => {
    const snapshot = await buildCustomerSnapshot(deps([fixtureRow()]));
    const json = JSON.stringify(snapshot);
    for (const key of FORBIDDEN) {
      expect(
        json,
        `forbidden key ${key} leaked into the payload`
      ).not.toContain(`"${key}"`);
    }
    // The poisoned VALUES must not leak either (e.g. under a renamed key).
    for (const value of [
      "$2a$10$dummy-not-a-real-hash",
      "dummy-reset-token",
      "cs_test_dummy",
      "pending@example.com",
      "pending42",
    ]) {
      expect(
        json,
        `forbidden value ${value} leaked into the payload`
      ).not.toContain(value);
    }
  });

  it("excludes soft-deleted rows (deletedAt IS NOT NULL never appears)", async () => {
    const live = fixtureRow();
    const dead = fixtureRow({
      id: 43,
      email: "gone@example.com",
      username: "gone43",
      deletedAt: 1750000005000,
    });
    const snapshot = await buildCustomerSnapshot(deps([live, dead]));
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.users[0]!.id).toBe(42);
    expect(JSON.stringify(snapshot)).not.toContain("gone@example.com");
  });

  it("emits the v1 envelope: version 1, dime source, generatedAt from the clock", async () => {
    const snapshot = await buildCustomerSnapshot(deps([fixtureRow()]));
    expect(snapshot.version).toBe(1);
    expect(snapshot.source).toBe("aisportsbettingmodels.com");
    expect(snapshot.generatedAt).toBe("2026-08-26T19:00:00.000Z");
  });

  it("serializes timestamps as ISO-8601 strings, and null expiryDate passes through as null (lifetime)", async () => {
    const snapshot = await buildCustomerSnapshot(deps([fixtureRow()]));
    const u = snapshot.users[0]!;
    expect(u.expiryDate).toBeNull();
    expect(u.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(u.lastSignedIn).toBe("2026-08-01T12:00:00.000Z");
    expect(u.termsAcceptedAt).toBe(new Date(1750000000000).toISOString());
    expect(u.discordConnectedAt).toBe(new Date(1750000001000).toISOString());
  });

  it("converts a bigint-ms expiryDate to ISO and nulls absent timestamps", async () => {
    const expiryMs = Date.parse("2026-12-31T00:00:00.000Z");
    const row = fixtureRow({
      expiryDate: expiryMs,
      lastSignedIn: null,
      termsAcceptedAt: null,
      discordConnectedAt: null,
    });
    const snapshot = await buildCustomerSnapshot(deps([row]));
    const u = snapshot.users[0]!;
    expect(u.expiryDate).toBe("2026-12-31T00:00:00.000Z");
    expect(u.lastSignedIn).toBeNull();
    expect(u.termsAcceptedAt).toBeNull();
    expect(u.discordConnectedAt).toBeNull();
  });

  it("computes entitled with listUsers parity: hasAccess is master, null expiry = lifetime, past expiry = false", async () => {
    const now = Date.parse("2026-08-26T19:00:00.000Z");
    const rows = [
      fixtureRow({
        id: 1,
        email: "a@x.com",
        username: "a",
        hasAccess: true,
        expiryDate: null,
      }),
      fixtureRow({
        id: 2,
        email: "b@x.com",
        username: "b",
        hasAccess: true,
        expiryDate: now + 1,
      }),
      fixtureRow({
        id: 3,
        email: "c@x.com",
        username: "c",
        hasAccess: true,
        expiryDate: now - 1,
      }),
      fixtureRow({
        id: 4,
        email: "d@x.com",
        username: "d",
        hasAccess: false,
        expiryDate: null,
      }),
      // boundary: now <= expiryDate is entitled (listUsers uses <=)
      fixtureRow({
        id: 5,
        email: "e@x.com",
        username: "e",
        hasAccess: true,
        expiryDate: now,
      }),
    ];
    const snapshot = await buildCustomerSnapshot(deps(rows));
    const byId = new Map(snapshot.users.map(u => [u.id, u]));
    expect(byId.get(1)!.entitled).toBe(true);
    expect(byId.get(2)!.entitled).toBe(true);
    expect(byId.get(3)!.entitled).toBe(false);
    expect(byId.get(4)!.entitled).toBe(false);
    expect(byId.get(5)!.entitled).toBe(true);
  });

  it("computes accessSource from stripeCustomerId presence", async () => {
    const rows = [
      fixtureRow({
        id: 1,
        email: "a@x.com",
        username: "a",
        stripeCustomerId: "cus_X",
      }),
      fixtureRow({
        id: 2,
        email: "b@x.com",
        username: "b",
        stripeCustomerId: null,
      }),
    ];
    const snapshot = await buildCustomerSnapshot(deps(rows));
    const byId = new Map(snapshot.users.map(u => [u.id, u]));
    expect(byId.get(1)!.accessSource).toBe("stripe");
    expect(byId.get(2)!.accessSource).toBe("manual");
  });

  it("resolves plan by priceId first, falls back to slug, and marks lifetime SKUs", async () => {
    const rows = [
      // priceId 7 → Pro monthly $49
      fixtureRow({
        id: 1,
        email: "a@x.com",
        username: "a",
        planPriceId: 7,
        stripePlanId: null,
      }),
      // priceId 8 → Lifetime one-off (billingInterval null ⇒ isLifetime true)
      fixtureRow({
        id: 2,
        email: "b@x.com",
        username: "b",
        planPriceId: 8,
        stripePlanId: null,
      }),
      // no priceId → slug fallback, price detail nulls, isLifetime null
      fixtureRow({
        id: 3,
        email: "c@x.com",
        username: "c",
        planPriceId: null,
        stripePlanId: "pro",
      }),
      // nothing resolvable → plan null
      fixtureRow({
        id: 4,
        email: "d@x.com",
        username: "d",
        planPriceId: null,
        stripePlanId: null,
      }),
    ];
    const snapshot = await buildCustomerSnapshot(deps(rows));
    const byId = new Map(snapshot.users.map(u => [u.id, u]));
    expect(byId.get(1)!.plan).toEqual({
      slug: "pro",
      name: "Pro",
      planType: "recurring",
      billingInterval: "month",
      amountCents: 4900,
      currency: "usd",
      isLifetime: false,
    });
    expect(byId.get(2)!.plan).toMatchObject({
      slug: "lifetime",
      isLifetime: true,
      billingInterval: null,
    });
    expect(byId.get(3)!.plan).toEqual({
      slug: "pro",
      name: "Pro",
      planType: "recurring",
      billingInterval: null,
      amountCents: null,
      currency: null,
      isLifetime: null,
    });
    expect(byId.get(4)!.plan).toBeNull();
  });
});

describe("signSnapshot", () => {
  it("matches the precomputed HMAC-SHA256 vector for {'a':1} with test-secret", () => {
    // Independently precomputed:
    //   node -e 'createHmac("sha256","test-secret").update('"'"'{"a":1}'"'"').digest("hex")'
    expect(signSnapshot('{"a":1}', "test-secret")).toBe(
      "sha256=179bf20a8b9040a32368814a68b0dc270823b5968498e0a73796c4202708ed8d"
    );
    // Cross-check against node:crypto directly (not signSnapshot twice).
    expect(signSnapshot('{"a":1}', "test-secret")).toBe(
      "sha256=" +
        createHmac("sha256", "test-secret").update('{"a":1}').digest("hex")
    );
  });
});

describe("pushCustomerSnapshot", () => {
  it("returns {ok:true, skipped:'unconfigured'} and performs NO fetch when env is unset", async () => {
    const fetchImpl = vi.fn();
    const result = await pushCustomerSnapshot({
      ...deps([fixtureRow()]),
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, skipped: "unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips when only the URL is set (secret missing)", async () => {
    process.env.TAILERED_SYNC_URL =
      "https://tailered.ai/api/admin/customer-sync";
    const fetchImpl = vi.fn();
    const result = await pushCustomerSnapshot({
      ...deps([fixtureRow()]),
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, skipped: "unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the raw JSON body with content-type and a matching x-dime-signature header", async () => {
    process.env.TAILERED_SYNC_URL =
      "https://tailered.ai/api/admin/customer-sync";
    process.env.TAILERED_SYNC_SECRET = "dummy-test-secret";
    const fetchImpl = vi.fn(
      async () => new Response('{"ok":true}', { status: 200 })
    );
    const result = await pushCustomerSnapshot({
      ...deps([fixtureRow()]),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://tailered.ai/api/admin/customer-sync");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    // The signature must be the HMAC of the EXACT raw bytes sent.
    const body = init.body as string;
    expect(headers["x-dime-signature"]).toBe(
      signSnapshot(body, "dummy-test-secret")
    );
    expect(headers["x-dime-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The body is the v1 snapshot.
    const parsed = JSON.parse(body);
    expect(parsed.version).toBe(1);
    expect(parsed.users).toHaveLength(1);
    expect(result).toEqual({ ok: true, users: 1, status: 200 });
  });

  it("returns {ok:false, status} on a non-2xx response", async () => {
    process.env.TAILERED_SYNC_URL =
      "https://tailered.ai/api/admin/customer-sync";
    process.env.TAILERED_SYNC_SECRET = "dummy-test-secret";
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 409 }));
    const result = await pushCustomerSnapshot({
      ...deps([fixtureRow()]),
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, status: 409 });
  });

  it("returns {ok:false, error} when fetch throws (timeout/network), without leaking the secret", async () => {
    process.env.TAILERED_SYNC_URL =
      "https://tailered.ai/api/admin/customer-sync";
    process.env.TAILERED_SYNC_SECRET = "dummy-test-secret";
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await pushCustomerSnapshot({
      ...deps([fixtureRow()]),
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network down");
    expect(JSON.stringify(result)).not.toContain("dummy-test-secret");
  });
});

// ─── Empty-snapshot refusal + DB-failure surfacing ───────────────────────────
// An empty push would WIPE the downstream mirror (tailered replaces the whole
// table with the snapshot). A legitimately empty dime user base does not exist,
// so zero users is always a fault — refuse the push (route maps ok:false → 502
// and the hourly workflow goes red) and never let "DB unavailable" or
// "breaker open" masquerade as an empty customer base.

function configureEnv() {
  process.env.TAILERED_SYNC_URL =
    "https://tailered.ai/api/admin/customer-sync";
  process.env.TAILERED_SYNC_SECRET = "dummy-test-secret";
}

/** Fake drizzle db: captures each select() projection, resolves fixed rows. */
function fakeSelectDb(rows: unknown[]) {
  const selections: Array<Record<string, unknown> | undefined> = [];
  const db = {
    select: (projection?: Record<string, unknown>) => {
      selections.push(projection);
      return {
        from: () => ({
          where: () => ({
            orderBy: async () => rows,
          }),
        }),
      };
    },
  };
  return { db, selections };
}

describe("pushCustomerSnapshot — empty snapshots are refused, DB faults surface as ok:false", () => {
  it("refuses a zero-user snapshot: {ok:false, error:'empty_snapshot_refused'}, NO fetch", async () => {
    configureEnv();
    const fetchImpl = vi.fn();
    const result = await pushCustomerSnapshot({ ...deps([]), fetchImpl });
    expect(result).toEqual({ ok: false, error: "empty_snapshot_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a snapshot whose only rows are soft-deleted (filters to zero users)", async () => {
    configureEnv();
    const fetchImpl = vi.fn();
    const dead = fixtureRow({ deletedAt: 1750000005000 });
    const result = await pushCustomerSnapshot({ ...deps([dead]), fetchImpl });
    expect(result).toEqual({ ok: false, error: "empty_snapshot_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("db unavailable (getDb → null): push resolves ok:false with the throw's message, NO fetch", async () => {
    configureEnv();
    getDbMock.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    // loadRows deliberately OMITTED — exercises the real loadRowsFromDb.
    const result = await pushCustomerSnapshot({
      loadCatalogue: async () => fixtureCatalogue(),
      now: () => Date.parse("2026-08-26T19:00:00.000Z"),
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("customer-sync: db unavailable");
    expect(result.skipped).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("breaker OPEN: surfaces as ok:false — NEVER an empty-snapshot (or any) push", async () => {
    configureEnv();
    const { db } = fakeSelectDb([fixtureRow()]);
    getDbMock.mockResolvedValue(db);
    withCircuitBreakerMock.mockReset();
    withCircuitBreakerMock.mockRejectedValue(
      new Error(
        "[DB-CIRCUIT] Circuit is OPEN — DB unavailable. Fast-failing to prevent hang."
      )
    );
    const fetchImpl = vi.fn();
    const result = await pushCustomerSnapshot({
      loadCatalogue: async () => fixtureCatalogue(),
      now: () => Date.parse("2026-08-26T19:00:00.000Z"),
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Circuit is OPEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("loadRowsFromDb — explicit column projection inside the circuit breaker", () => {
  /** The 22 source columns CustomerSourceRow names — and nothing else. */
  const PROJECTED_COLUMNS = [
    "id",
    "email",
    "username",
    "role",
    "hasAccess",
    "expiryDate",
    "deletedAt",
    "termsAccepted",
    "termsAcceptedAt",
    "discordId",
    "discordUsername",
    "discordConnectedAt",
    "manualDiscordId",
    "createdAt",
    "lastSignedIn",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "stripePlanId",
    "planPriceId",
    "stripeSubscriptionStatus",
    "cancelAtPeriodEnd",
    "pendingSetup",
  ];

  it("selects ONLY the snapshot-source columns (no credential/security columns), wrapped in withCircuitBreaker", async () => {
    configureEnv();
    const { db, selections } = fakeSelectDb([fixtureRow()]);
    getDbMock.mockResolvedValue(db);
    const fetchImpl = vi.fn(
      async () => new Response('{"ok":true}', { status: 200 })
    );
    const result = await pushCustomerSnapshot({
      loadCatalogue: async () => fixtureCatalogue(),
      now: () => Date.parse("2026-08-26T19:00:00.000Z"),
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, users: 1, status: 200 });
    expect(withCircuitBreakerMock).toHaveBeenCalledTimes(1);
    expect(selections).toHaveLength(1);
    const projection = selections[0];
    expect(projection, "db.select() must be called WITH a projection").toBeDefined();
    const keys = Object.keys(projection!).sort();
    expect(keys).toEqual([...PROJECTED_COLUMNS].sort());
    for (const key of FORBIDDEN) {
      expect(keys, `credential column ${key} must not be selected`).not.toContain(
        key
      );
    }
  });
});
