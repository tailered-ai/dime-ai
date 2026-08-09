/**
 * Reproduces the 2026-07-31 login outage in miniature: app_users.planPriceId
 * existed in the Drizzle schema but not in the database, so every user lookup
 * failed and surfaced as "user not found".
 */
import { describe, it, expect } from "vitest";
import {
  formatDrift,
  REQUIRED_COLUMNS,
  normalizeSchemaRows,
  type SchemaDrift,
} from "./schemaGuard";
import { isSchemaError } from "../db";

describe("isSchemaError", () => {
  it("[SE-1] treats the exact outage error as a SCHEMA fault, not a missing row", () => {
    expect(
      isSchemaError({
        code: "ER_BAD_FIELD_ERROR",
        message: "Unknown column 'planPriceId' in 'field list'",
      })
    ).toBe(true);
  });

  it("[SE-2] covers the other code-ahead-of-migration shapes", () => {
    for (const code of [
      "ER_NO_SUCH_TABLE",
      "ER_PARSE_ERROR",
      "ER_BAD_TABLE_ERROR",
      "ER_WRONG_FIELD_SPEC",
    ])
      expect(isSchemaError({ code }), code).toBe(true);
  });

  it("[SE-3] leaves TRANSIENT faults fail-soft — those should degrade, not 500", () => {
    for (const code of [
      "PROTOCOL_CONNECTION_LOST",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ER_LOCK_DEADLOCK",
    ])
      expect(isSchemaError({ code }), code).toBe(false);
    expect(isSchemaError(new Error("circuit breaker open"))).toBe(false);
    expect(isSchemaError(null)).toBe(false);
    expect(isSchemaError(undefined)).toBe(false);
  });
});

describe("REQUIRED_COLUMNS", () => {
  it("[RC-1] guards the column whose absence caused the outage", () => {
    expect(REQUIRED_COLUMNS.app_users).toContain("planPriceId");
  });

  it("[RC-2] guards the identity + money path tables", () => {
    for (const t of [
      "app_users",
      "subscription_plans",
      "plan_prices",
      "plan_features",
      "stripe_webhook_events",
      "entitlement_events",
    ])
      expect(Object.keys(REQUIRED_COLUMNS), t).toContain(t);
  });

  it("[RC-4] guards all THREE ledgers — a ledger deployed ahead of its migration ships blind", () => {
    for (const t of [
      "checkout_sessions",
      "payment_events",
      "subscription_events",
    ])
      expect(Object.keys(REQUIRED_COLUMNS), t).toContain(t);
    // The columns the lifecycle queries depend on (from→to plan transition).
    expect(REQUIRED_COLUMNS.subscription_events).toEqual(
      expect.arrayContaining([
        "kind",
        "outcome",
        "fromPriceId",
        "toPriceId",
        "occurredAt",
      ])
    );
  });

  it("[RC-3] includes the columns the webhook idempotency + audit trail depend on", () => {
    expect(REQUIRED_COLUMNS.stripe_webhook_events).toContain("stripeEventId");
    expect(REQUIRED_COLUMNS.entitlement_events).toContain("reason");
    expect(REQUIRED_COLUMNS.app_users).toEqual(
      expect.arrayContaining(["hasAccess", "expiryDate", "stripePlanId"])
    );
  });
});

describe("formatDrift", () => {
  it("[FD-1] names the exact missing column so the fix is obvious from the log", () => {
    const drift: SchemaDrift[] = [
      {
        table: "app_users",
        missingColumns: ["planPriceId"],
        tableMissing: false,
      },
    ];
    const out = formatDrift(drift);
    expect(out).toContain("app_users");
    expect(out).toContain("planPriceId");
  });

  it("[FD-2] distinguishes a missing TABLE from missing columns", () => {
    const out = formatDrift([
      {
        table: "entitlement_events",
        missingColumns: ["id", "userId"],
        tableMissing: true,
      },
    ]);
    expect(out).toMatch(/MISSING entirely/);
  });

  it("[FD-3] reports every drifting table, not just the first", () => {
    const out = formatDrift([
      {
        table: "app_users",
        missingColumns: ["planPriceId"],
        tableMissing: false,
      },
      {
        table: "plan_features",
        missingColumns: ["sortOrder"],
        tableMissing: false,
      },
    ]);
    expect(out).toContain("app_users");
    expect(out).toContain("plan_features");
  });
});

/**
 * The envelope reader. This is where a guess used to live: the old code did
 * `Array.isArray(rows[0]) ? rows[0] : rows` and coerced anything else to `[]`,
 * so an unrecognized shape carrying a perfectly good schema became "zero rows"
 * — which reads as total drift. Coercing the other way would have been just as
 * wrong. An envelope we do not recognize is not data.
 */
describe("normalizeSchemaRows", () => {
  const rows = [
    { t: "app_users", c: "id" },
    { t: "app_users", c: "email" },
  ];

  it("[NR-1] accepts a flat row array (drizzle)", () => {
    expect(normalizeSchemaRows(rows)).toEqual({ ok: true, rows });
  });

  it("[NR-2] accepts the [rows, fields] envelope (mysql2)", () => {
    expect(normalizeSchemaRows([rows, []])).toEqual({ ok: true, rows });
  });

  it("[NR-3] a recognized EMPTY result is valid data, not an error", () => {
    // "The query ran and matched nothing" is a real answer — it means the
    // tables are absent. Hiding it here is how the wrong-database case escaped.
    expect(normalizeSchemaRows([])).toEqual({ ok: true, rows: [] });
    expect(normalizeSchemaRows([[], []])).toEqual({ ok: true, rows: [] });
  });

  it("[NR-4] rejects an unrecognized envelope instead of coercing it", () => {
    expect(normalizeSchemaRows({ rows }).ok).toBe(false);
    expect(normalizeSchemaRows(null).ok).toBe(false);
    expect(normalizeSchemaRows(undefined).ok).toBe(false);
    expect(normalizeSchemaRows("rows").ok).toBe(false);
  });

  it("[NR-5] rejects rows missing the expected keys", () => {
    expect(normalizeSchemaRows([{ TABLE_NAME: "app_users" }]).ok).toBe(false);
    expect(normalizeSchemaRows([{ t: "app_users" }]).ok).toBe(false);
    expect(normalizeSchemaRows([{ t: null, c: null }]).ok).toBe(false);
  });

  it("[NR-6] stringifies non-string scalars rather than rejecting them", () => {
    expect(normalizeSchemaRows([{ t: 1, c: 2 }])).toEqual({
      ok: true,
      rows: [{ t: "1", c: "2" }],
    });
  });
});
