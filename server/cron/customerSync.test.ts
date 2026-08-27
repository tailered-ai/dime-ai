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
import { eq, isNull } from "drizzle-orm";
import { appUsers, planPrices, subscriptionPlans } from "../../drizzle/schema";
import {
  buildCustomerSnapshot,
  buildSanitizedUserById,
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
    expect(result).toEqual({
      ok: true,
      users: 1,
      status: 200,
      bytes: Buffer.byteLength(body),
    });
  });

  it("returns {ok:false, status} on a non-2xx response, surfacing the HTTP status", async () => {
    process.env.TAILERED_SYNC_URL =
      "https://tailered.ai/api/admin/customer-sync";
    process.env.TAILERED_SYNC_SECRET = "dummy-test-secret";
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 409 }));
    const result = await pushCustomerSnapshot({
      ...deps([fixtureRow()]),
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      bytes: expect.any(Number),
    });
  });

  it("logs the payload runway line (users + numeric bytes) BEFORE the fetch, and never logs any fixture email", async () => {
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
    expect(result.ok).toBe(true);

    const logSpy = vi.mocked(console.log);
    const lines = logSpy.mock.calls.map(args => args.map(String).join(" "));
    const runwayIdx = lines.findIndex(l =>
      l.startsWith("[Cron:customer-sync] payload ")
    );
    expect(runwayIdx, "runway log line must fire").toBeGreaterThanOrEqual(0);
    const m = lines[runwayIdx]!.match(
      /^\[Cron:customer-sync\] payload users=(\d+) bytes=(\d+)$/
    );
    expect(m, "runway line must carry numeric users and bytes").not.toBeNull();
    expect(Number(m![1])).toBe(1);
    expect(Number(m![2])).toBeGreaterThan(0);
    expect(result.bytes).toBe(Number(m![2]));

    // Ordering: the runway line fires BEFORE the fetch (that is what makes it
    // a runway line — it survives even if the push hangs or dies).
    expect(logSpy.mock.invocationCallOrder[runwayIdx]!).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[0]!
    );

    // PII: no console call — log or error — ever contains the payload body or
    // any member email from the fixture.
    const allLines = [
      ...lines,
      ...vi
        .mocked(console.error)
        .mock.calls.map(args => args.map(String).join(" ")),
    ];
    for (const line of allLines) {
      expect(line).not.toContain("member@example.com");
      expect(line).not.toContain("pending@example.com");
    }
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
  process.env.TAILERED_SYNC_URL = "https://tailered.ai/api/admin/customer-sync";
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
    expect(result).toEqual({
      ok: true,
      users: 1,
      status: 200,
      bytes: expect.any(Number),
    });
    expect(withCircuitBreakerMock).toHaveBeenCalledTimes(1);
    expect(selections).toHaveLength(1);
    const projection = selections[0];
    expect(
      projection,
      "db.select() must be called WITH a projection"
    ).toBeDefined();
    const keys = Object.keys(projection!).sort();
    expect(keys).toEqual([...PROJECTED_COLUMNS].sort());
    for (const key of FORBIDDEN) {
      expect(
        keys,
        `credential column ${key} must not be selected`
      ).not.toContain(key);
    }
  });
});

// ─── Real default loaders, end to end through a projection-honoring fake db ──
// These do NOT inject loadRows/loadCatalogue: loadRowsFromDb and
// loadCatalogueFromDb run their real lines (projection object, isNull row
// filter, breaker wrapping, catalogue join + mapping, toIso on raw DB values).
// Only the `../db` module boundary is faked. The fake db APPLIES the query's
// projection to column-keyed fixtures, so these tests FAIL if the projection
// drops a needed column (the produced SnapshotUser loses that value) or if
// toIso misconverts (the asserted ISO strings change).

/** Fixture "DB row": drizzle column object → raw stored value. */
type ColumnFixture = Map<unknown, unknown>;

/** Apply a drizzle-style projection {outKey: column} to a column fixture. */
function projectRow(
  projection: Record<string, unknown>,
  source: ColumnFixture
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(projection)) {
    if (!source.has(column)) {
      throw new Error(
        `fake db: projection key "${key}" references a column with no fixture value`
      );
    }
    out[key] = source.get(column);
  }
  return out;
}

type CapturedQueries = {
  userProjection?: Record<string, unknown>;
  userWhere?: unknown;
  userOrderBy?: unknown;
  userLimit?: unknown;
  catalogueProjection?: Record<string, unknown>;
  joinTable?: unknown;
  joinCondition?: unknown;
};

/**
 * Chainable fake drizzle db routing by the from() table:
 *   appUsers   → select().from().where().orderBy()  (loadRowsFromDb's shape)
 *   planPrices → select().from().innerJoin()        (loadCatalogueFromDb's shape)
 * Resolved rows are the fixtures projected through the REAL query's projection.
 */
function fakeDrizzleDb(opts: {
  userRows?: ColumnFixture[];
  catalogueRows?: ColumnFixture[];
  catalogueError?: Error;
}) {
  const captured: CapturedQueries = {};
  const db = {
    select(projection: Record<string, unknown>) {
      return {
        from(table: unknown) {
          if (table === appUsers) {
            captured.userProjection = projection;
            return {
              where(condition: unknown) {
                captured.userWhere = condition;
                return {
                  // loadRowsFromDb's shape: select().from().where().orderBy()
                  async orderBy(order: unknown) {
                    captured.userOrderBy = order;
                    return (opts.userRows ?? []).map(r =>
                      projectRow(projection, r)
                    );
                  },
                  // loadRowByIdFromDb's shape: select().from().where().limit(1)
                  async limit(n: unknown) {
                    captured.userLimit = n;
                    return (opts.userRows ?? []).map(r =>
                      projectRow(projection, r)
                    );
                  },
                };
              },
            };
          }
          if (table === planPrices) {
            captured.catalogueProjection = projection;
            return {
              async innerJoin(joinTable: unknown, condition: unknown) {
                captured.joinTable = joinTable;
                captured.joinCondition = condition;
                if (opts.catalogueError) throw opts.catalogueError;
                return (opts.catalogueRows ?? []).map(r =>
                  projectRow(projection, r)
                );
              },
            };
          }
          throw new Error("fake db: unexpected from() table");
        },
      };
    },
  };
  return { db, captured };
}

const FIXED_NOW = Date.parse("2026-08-26T19:00:00.000Z");

/** app_users fixture keyed by the real schema columns, raw DB value types. */
function userColumnFixture(
  overrides: ColumnFixture = new Map()
): ColumnFixture {
  const base = new Map<unknown, unknown>([
    [appUsers.id, 42],
    [appUsers.email, "member@example.com"],
    [appUsers.username, "member42"],
    [appUsers.role, "user"],
    [appUsers.hasAccess, true],
    [appUsers.expiryDate, FIXED_NOW + 86_400_000], // ms-int column, +1 day
    [appUsers.deletedAt, null],
    [appUsers.termsAccepted, true],
    [appUsers.termsAcceptedAt, 1750000000000], // ms-int column
    [appUsers.discordId, "123456789012345678"],
    [appUsers.discordUsername, "member#0042"],
    [appUsers.discordConnectedAt, 1750000001000], // ms-int column
    [appUsers.manualDiscordId, null],
    [appUsers.createdAt, new Date("2026-01-02T03:04:05.000Z")], // Date column
    [appUsers.lastSignedIn, new Date("2026-08-01T12:00:00.000Z")], // Date column
    [appUsers.stripeCustomerId, "cus_TEST123"],
    [appUsers.stripeSubscriptionId, "sub_TEST123"],
    [appUsers.stripePlanId, null],
    [appUsers.planPriceId, 7],
    [appUsers.stripeSubscriptionStatus, "active"],
    [appUsers.cancelAtPeriodEnd, false],
    [appUsers.pendingSetup, false],
  ]);
  for (const [column, value] of overrides) base.set(column, value);
  return base;
}

/** plan_prices ⋈ subscription_plans joined-row fixture, keyed by real columns. */
function catalogueColumnFixture(values: {
  priceId: number;
  amountCents: number;
  currency: string;
  interval: string | null;
  slug: string;
  name: string;
  planType: string;
}): ColumnFixture {
  return new Map<unknown, unknown>([
    [planPrices.id, values.priceId],
    [planPrices.amountCents, values.amountCents],
    [planPrices.currency, values.currency],
    [planPrices.interval, values.interval],
    [subscriptionPlans.slug, values.slug],
    [subscriptionPlans.name, values.name],
    [subscriptionPlans.planType, values.planType],
  ]);
}

// Each test below defaults exactly ONE loader per buildCustomerSnapshot call.
// Defaulting both at once fires two CONCURRENT dynamic import("../db") calls
// for the same mocked specifier, and vitest's mock interception verifiably
// hands one of them the REAL module (observed: rows loader got the mock,
// catalogue loader got real server/db). One default loader per call keeps the
// module mock deterministic; production runs both against the real db anyway.
describe("default loaders — loadRowsFromDb + loadCatalogueFromDb run for real", () => {
  it("real loadRowsFromDb: projection applied to raw column values, isNull filter, breaker wrap, toIso conversions", async () => {
    const userRows = [userColumnFixture()];
    const { db, captured } = fakeDrizzleDb({ userRows });
    getDbMock.mockResolvedValue(db);

    // loadRows NOT injected — the real default loader runs its real query.
    const snapshot = await buildCustomerSnapshot({
      loadCatalogue: async () => fixtureCatalogue(),
      now: () => FIXED_NOW,
    });

    // The rows query ran inside the breaker, with the spec's row filter+order.
    expect(withCircuitBreakerMock).toHaveBeenCalledTimes(1);
    expect(captured.userWhere).toStrictEqual(isNull(appUsers.deletedAt));
    expect(captured.userOrderBy).toBe(appUsers.createdAt);

    expect(snapshot.users).toHaveLength(1);
    const u42 = snapshot.users[0]!;
    // Values that only survive if the projection carries their column — the
    // fake db applies the REAL projection to the column-keyed fixture, so a
    // dropped column erases the value and fails these.
    expect(u42.id).toBe(42);
    expect(u42.email).toBe("member@example.com");
    expect(u42.username).toBe("member42");
    expect(u42.role).toBe("user");
    expect(u42.hasAccess).toBe(true);
    expect(u42.entitled).toBe(true); // expiry 1 day past fixed now
    expect(u42.termsAccepted).toBe(true);
    expect(u42.discordId).toBe("123456789012345678");
    expect(u42.discordUsername).toBe("member#0042");
    expect(u42.manualDiscordId).toBeNull();
    expect(u42.accessSource).toBe("stripe");
    expect(u42.stripeCustomerId).toBe("cus_TEST123");
    expect(u42.stripeSubscriptionId).toBe("sub_TEST123");
    expect(u42.stripeSubscriptionStatus).toBe("active");
    expect(u42.cancelAtPeriodEnd).toBe(false);
    expect(u42.pendingSetup).toBe(false);
    // toIso on RAW column values: ms-int columns and Date columns both → ISO.
    expect(u42.expiryDate).toBe(new Date(FIXED_NOW + 86_400_000).toISOString());
    expect(u42.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(u42.lastSignedIn).toBe("2026-08-01T12:00:00.000Z");
    expect(u42.termsAcceptedAt).toBe(new Date(1750000000000).toISOString());
    expect(u42.discordConnectedAt).toBe(new Date(1750000001000).toISOString());
    // planPriceId survived projection: resolves against the injected catalogue.
    expect(u42.plan).toEqual({
      slug: "pro",
      name: "Pro",
      planType: "recurring",
      billingInterval: "month",
      amountCents: 4900,
      currency: "usd",
      isLifetime: false,
    });
  });

  it("real loadCatalogueFromDb: join + projection + mapping build byPriceId/byPlanSlug that resolve real plan detail", async () => {
    const catalogueRows = [
      catalogueColumnFixture({
        priceId: 7,
        amountCents: 4900,
        currency: "usd",
        interval: "month",
        slug: "pro",
        name: "Pro",
        planType: "recurring",
      }),
      // Second price on the SAME plan slug — byPlanSlug keeps the first.
      catalogueColumnFixture({
        priceId: 9,
        amountCents: 49900,
        currency: "usd",
        interval: "year",
        slug: "pro",
        name: "Pro",
        planType: "recurring",
      }),
      catalogueColumnFixture({
        priceId: 8,
        amountCents: 99999,
        currency: "usd",
        interval: null,
        slug: "lifetime",
        name: "Lifetime",
        planType: "one_time",
      }),
    ];
    const { db, captured } = fakeDrizzleDb({ catalogueRows });
    getDbMock.mockResolvedValue(db);

    const loadRows = async () => [
      // priceId 7 → Pro monthly $49 (exact-SKU path)
      fixtureRow({ planPriceId: 7, stripePlanId: null }),
      // priceId 8 → Lifetime one-off: billingInterval null ⇒ isLifetime true
      fixtureRow({
        id: 43,
        email: "life@example.com",
        username: "life43",
        planPriceId: 8,
        stripePlanId: null,
      }),
      // no priceId → slug fallback through the REAL byPlanSlug map
      fixtureRow({
        id: 44,
        email: "slug@example.com",
        username: "slug44",
        planPriceId: null,
        stripePlanId: "pro",
      }),
    ];
    // loadCatalogue NOT injected — the real default loader runs its real query.
    const snapshot = await buildCustomerSnapshot({
      loadRows,
      now: () => FIXED_NOW,
    });

    // The catalogue query joined subscription_plans on planId.
    expect(captured.joinTable).toBe(subscriptionPlans);
    expect(captured.joinCondition).toStrictEqual(
      eq(subscriptionPlans.id, planPrices.planId)
    );

    expect(snapshot.users).toHaveLength(3);
    const byId = new Map(snapshot.users.map(u => [u.id, u]));

    // Plan detail resolved through the REAL byPriceId map: every field — a
    // projection that drops amountCents/currency/interval/slug/name/planType
    // makes this object wrong.
    expect(byId.get(42)!.plan).toEqual({
      slug: "pro",
      name: "Pro",
      planType: "recurring",
      billingInterval: "month",
      amountCents: 4900,
      currency: "usd",
      isLifetime: false,
    });

    // Lifetime SKU: interval null survives the loader's `?? null` mapping.
    expect(byId.get(43)!.plan).toEqual({
      slug: "lifetime",
      name: "Lifetime",
      planType: "one_time",
      billingInterval: null,
      amountCents: 99999,
      currency: "usd",
      isLifetime: true,
    });

    // Slug fallback through the REAL byPlanSlug (first "pro" entry kept).
    expect(byId.get(44)!.plan).toEqual({
      slug: "pro",
      name: "Pro",
      planType: "recurring",
      billingInterval: null,
      amountCents: null,
      currency: null,
      isLifetime: null,
    });
  });

  it("catalogue with db unavailable degrades to empty (plan null), users still mirror", async () => {
    // loadRows injected; loadCatalogue defaults. getDb → null exercises the
    // real loadCatalogueFromDb early-return (NOT a throw — roles/access still
    // mirror when plan detail is unavailable).
    getDbMock.mockResolvedValue(null);
    const snapshot = await buildCustomerSnapshot({
      loadRows: async () => [fixtureRow()],
      now: () => FIXED_NOW,
    });
    expect(snapshot.users).toHaveLength(1);
    const u = snapshot.users[0]!;
    expect(u.email).toBe("member@example.com");
    expect(u.entitled).toBe(true);
    // planPriceId 7 AND stripePlanId "pro" both set — with an empty catalogue
    // neither resolves.
    expect(u.plan).toBeNull();
  });

  it("catalogue query THROWING degrades to empty catalogue and logs [CustomerSync][catalogue][FAIL] — push still succeeds", async () => {
    configureEnv();
    const { db } = fakeDrizzleDb({
      catalogueError: new Error("catalogue-query-down"),
    });
    getDbMock.mockResolvedValue(db);
    const fetchImpl = vi.fn(
      async () => new Response('{"ok":true}', { status: 200 })
    );
    // loadRows injected (rows healthy); loadCatalogue defaults and throws
    // inside the real try/catch.
    const result = await pushCustomerSnapshot({
      loadRows: async () => [fixtureRow()],
      now: () => FIXED_NOW,
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      users: 1,
      status: 200,
      bytes: expect.any(Number),
    });
    const sent = JSON.parse(
      (fetchImpl.mock.calls[0]! as unknown as [string, RequestInit])[1]
        .body as string
    );
    expect(sent.users).toHaveLength(1);
    expect(sent.users[0].plan).toBeNull();
    const errLines = vi
      .mocked(console.error)
      .mock.calls.map(args => args.map(String).join(" "));
    expect(
      errLines.some(l =>
        l.includes("[CustomerSync][catalogue][FAIL] catalogue-query-down")
      ),
      "catalogue failure must be logged with its marker and message"
    ).toBe(true);
  });
});

describe("buildSanitizedUserById (Phase 2 write-through)", () => {
  const emptyCatalogue = (): BillingCatalogue => ({
    byPriceId: new Map(),
    byPlanSlug: new Map(),
  });

  it("returns the sanitized user for a live row — forbidden fields absent", async () => {
    const user = await buildSanitizedUserById(42, {
      loadRows: async () => [fixtureRow()],
      loadCatalogue: async () => emptyCatalogue(),
      now: () => Date.parse("2026-08-27T00:00:00.000Z"),
    });
    expect(user).not.toBeNull();
    expect(user!.id).toBe(42);
    expect(user!.username).toBe("member42");
    expect(user!.entitled).toBe(true);
    for (const key of FORBIDDEN) {
      expect(Object.keys(user!)).not.toContain(key);
    }
  });

  it("returns null when the id is not among the rows", async () => {
    const user = await buildSanitizedUserById(99, {
      loadRows: async () => [fixtureRow()],
      loadCatalogue: async () => emptyCatalogue(),
    });
    expect(user).toBeNull();
  });

  it("returns null for a soft-deleted row (deletedAt set)", async () => {
    const user = await buildSanitizedUserById(42, {
      loadRows: async () => [fixtureRow({ deletedAt: 1700000000000 })],
      loadCatalogue: async () => emptyCatalogue(),
    });
    expect(user).toBeNull();
  });

  // ── Real default single-row loader (loadRowByIdFromDb) ─────────────────────
  // loadRows NOT injected: the real loader runs its dynamic imports, breaker
  // wrap, shared CUSTOMER_ROW_PROJECTION, and id+deletedAt WHERE + limit(1)
  // through the projection-honoring fake db.
  it("real loadRowByIdFromDb: shared projection + id/deletedAt filter + limit(1), breaker-wrapped", async () => {
    const { db, captured } = fakeDrizzleDb({ userRows: [userColumnFixture()] });
    getDbMock.mockResolvedValue(db);

    const user = await buildSanitizedUserById(42, {
      loadCatalogue: async () => fixtureCatalogue(),
      now: () => FIXED_NOW,
    });

    expect(withCircuitBreakerMock).toHaveBeenCalledTimes(1);
    expect(captured.userLimit).toBe(1); // single-row loader, not orderBy
    expect(captured.userOrderBy).toBeUndefined();
    expect(user).not.toBeNull();
    expect(user!.id).toBe(42);
    expect(user!.username).toBe("member42");
    // Values survive only if the shared projection carries their column.
    expect(user!.email).toBe("member@example.com");
    expect(user!.accessSource).toBe("stripe");
    expect(user!.plan?.slug).toBe("pro");
    for (const key of FORBIDDEN) {
      expect(Object.keys(user!)).not.toContain(key);
    }
  });

  it("real loadRowByIdFromDb: unknown id → empty rows → null", async () => {
    const { db } = fakeDrizzleDb({ userRows: [] });
    getDbMock.mockResolvedValue(db);
    const user = await buildSanitizedUserById(999, {
      loadCatalogue: async () => emptyCatalogue(),
      now: () => FIXED_NOW,
    });
    expect(user).toBeNull();
  });

  it("real loadRowByIdFromDb: db unavailable throws (never a silent null)", async () => {
    getDbMock.mockResolvedValue(null);
    await expect(
      buildSanitizedUserById(42, {
        loadCatalogue: async () => emptyCatalogue(),
        now: () => FIXED_NOW,
      })
    ).rejects.toThrow(/db unavailable/);
  });
});
