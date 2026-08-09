/**
 * schemaGuard.ts — detect "code deployed ahead of its migration" at BOOT.
 *
 * WHY (2026-07-31 login outage, and Incident 43 before it):
 * Drizzle enumerates every column declared in schema.ts in the SQL it generates.
 * If a column ships in code before its migration runs, EVERY query against that
 * table fails with ER_BAD_FIELD_ERROR. On 2026-07-31 that took platform-wide
 * login down: `app_users.planPriceId` existed in code, not in the database, and
 * the failure surfaced as "user not found" rather than "your schema is behind".
 *
 * The deploy itself looked perfectly healthy — build green, container up, health
 * endpoint 200 — because nothing ever asked whether the schema matched. This
 * asks, once, at startup.
 *
 * Deliberately WARN-only by default. A hard exit would convert a recoverable
 * degraded state into a crash-loop on a service that also serves marketing pages
 * and the bot prerender. Set SCHEMA_GUARD_FATAL=1 to fail closed instead.
 *
 * Cost: one information_schema query per boot, on the tables that matter.
 */

import { getDb } from "../db";
import { sql } from "drizzle-orm";
import { isAnalyticsStore } from "../analytics/config";

const TAG = "[SchemaGuard]";

/**
 * Columns whose absence breaks a core flow. Not exhaustive by design — this
 * guards the money and identity paths, where a mismatch is an outage rather
 * than a degraded feature.
 */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  app_users: [
    "id",
    "email",
    "username",
    "passwordHash",
    "role",
    "hasAccess",
    "expiryDate",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "stripePlanId",
    "cancelAtPeriodEnd",
    "pendingSetup",
    "pendingStripeSessionId",
    "pendingSetupExpiresAt",
    "stripeSubscriptionStatus",
    "lastStripeEventAt",
    "planPriceId",
    "tokenVersion",
  ],
  subscription_plans: [
    "id",
    "slug",
    "name",
    "planType",
    "active",
    "livemode",
    "stripeProductId",
  ],
  plan_prices: [
    "id",
    "planId",
    "stripePriceId",
    "amountCents",
    "currency",
    "active",
    "isDefault",
  ],
  plan_features: ["id", "planId", "featureKey", "sortOrder"],
  stripe_webhook_events: ["id", "stripeEventId", "eventType", "processedAt"],
  entitlement_events: ["id", "userId", "eventType", "reason", "createdAt"],
  // Ledger tables. Both fail SOFT by design — recordCheckoutCreated and
  // recordPaymentEvent swallow their own errors so a missing table can never
  // 5xx a webhook and trigger Stripe to redeliver an already-fulfilled event.
  //
  // That safety property has a cost: when the migration is skipped, the code
  // ships blind and says nothing. It happened on BOTH ledger deploys, because
  // merging triggers the Railway deploy automatically and the migration
  // workflow has to be run BEFORE the merge, not after. SchemaGuard reported
  // PASS each time — it only knew about app_users and the billing catalogue.
  //
  // Declaring them here makes the omission loud at boot instead of silent
  // until the first payment.
  checkout_sessions: [
    "id",
    "stripeSessionId",
    "status",
    "fulfillment",
    "fulfillmentReason",
    "userId",
    "planId",
    "amountCents",
    "customerEmail",
    "createdAt",
  ],
  payment_events: [
    "id",
    "stripeEventId",
    "objectId",
    "objectType",
    "kind",
    "outcome",
    "outcomeReason",
    "amountCents",
    "currency",
    "userId",
    "occurredAt",
    "recordedAt",
  ],
  subscription_events: [
    "id",
    "stripeEventId",
    "eventType",
    "stripeSubscriptionId",
    "kind",
    "outcome",
    "outcomeReason",
    "fromPlanId",
    "toPlanId",
    "fromPriceId",
    "toPriceId",
    "status",
    "cancelAtPeriodEnd",
    "periodEnd",
    "actor",
    "occurredAt",
    "recordedAt",
  ],
};

export interface SchemaDrift {
  table: string;
  missingColumns: string[];
  tableMissing: boolean;
}

/**
 * Why a verdict could not be produced. Every one of these means "we do not
 * know", and none of them may ever be rendered as PASS.
 */
export type SchemaGuardUnavailableReason =
  | "no-database-handle"
  | "no-database-context"
  | "inspection-failed"
  | "unrecognized-driver-result";

/**
 * A discriminated verdict, replacing the old `{ ok, drift }` shape.
 *
 * The old shape collapsed THREE distinct conditions onto `{ ok: true, drift: [] }`
 * — verified clean, no database handle, and inspection threw — and the no-handle
 * case additionally logged `[VERIFY] PASS`. Reproduced on the 23aafc55a baseline
 * before this change; see the closeout PR. An empty array must never carry hidden
 * epistemic meaning, so the state is now explicit and non-optional:
 *
 *   pass            — the database was reached, the schema context was
 *                     established, the inspection returned a recognized result,
 *                     and every required table AND column was observed.
 *   fail            — inspection SUCCEEDED and confirmed drift. Fatal under
 *                     SCHEMA_GUARD_FATAL=1.
 *   unavailable     — no trustworthy verdict. Never fatal (fail-open), never PASS.
 *   not_applicable  — this service does not own the guarded tables.
 */
export type SchemaGuardResult =
  | { status: "pass"; drift: readonly []; database: string }
  | { status: "fail"; drift: SchemaDrift[]; database: string }
  | {
      status: "unavailable";
      drift: readonly [];
      reason: SchemaGuardUnavailableReason;
      detail?: string;
    }
  | { status: "not_applicable"; drift: readonly []; reason: "analytics-store" };

type SchemaRow = { t: string; c: string };

/**
 * Recognize the driver's result envelope, or refuse to guess.
 *
 * The previous code did `Array.isArray(rows[0]) ? rows[0] : rows` and coerced
 * anything else to `[]` — so an unrecognized shape carrying a PERFECTLY GOOD
 * schema became "zero rows", which reads as total drift. Silent coercion in
 * either direction is the bug; an envelope we do not recognize is `unavailable`.
 *
 * A recognized-but-EMPTY result is deliberately NOT an error here. "The query ran
 * and matched nothing" is a real, meaningful answer — it means the tables are not
 * there — and it is the caller's job to treat that as drift, not this function's
 * job to hide it.
 */
export function normalizeSchemaRows(
  raw: unknown
): { ok: true; rows: SchemaRow[] } | { ok: false } {
  const isRow = (v: unknown): v is SchemaRow =>
    typeof v === "object" &&
    v !== null &&
    "t" in v &&
    "c" in v &&
    (v as { t: unknown }).t != null &&
    (v as { c: unknown }).c != null;

  const asRows = (v: unknown): SchemaRow[] | null => {
    if (!Array.isArray(v)) return null;
    return v.every(isRow)
      ? v.map(r => ({ t: String(r.t), c: String(r.c) }))
      : null;
  };

  if (!Array.isArray(raw)) return { ok: false };
  // Flat row array (drizzle) — also covers the empty case.
  const flat = asRows(raw);
  if (flat) return { ok: true, rows: flat };
  // mysql2 [rows, fields] envelope.
  const nested = asRows(raw[0]);
  if (nested) return { ok: true, rows: nested };
  return { ok: false };
}

/** First scalar value of the first row, for single-value probes. */
function firstScalar(raw: unknown): string | null {
  const rows = Array.isArray(raw)
    ? Array.isArray(raw[0])
      ? (raw[0] as unknown[])
      : (raw as unknown[])
    : null;
  const row = rows?.[0];
  if (typeof row !== "object" || row === null) return null;
  const v = Object.values(row as Record<string, unknown>)[0];
  return v == null ? null : String(v);
}

/**
 * Establish that the inspection itself is trustworthy BEFORE comparing anything.
 *
 * Order matters. Each step can only fail one way, and every failure is an
 * explicit `unavailable` reason rather than an empty array:
 *   1. a database handle exists
 *   2. a schema context is selected (`SELECT DATABASE()` is non-null) — this is
 *      what separates "queried the right place and found nothing" from "queried
 *      nowhere", which the drift-shape heuristic used to guess at
 *   3. the information_schema query succeeds
 *   4. the result envelope is one we recognize
 */
export async function inspectSchema(
  required: Readonly<Record<string, readonly string[]>> = REQUIRED_COLUMNS
): Promise<
  | { status: "ok"; database: string; rows: SchemaRow[] }
  | {
      status: "unavailable";
      reason: SchemaGuardUnavailableReason;
      detail?: string;
    }
> {
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (err) {
    return {
      status: "unavailable",
      reason: "no-database-handle",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!db) return { status: "unavailable", reason: "no-database-handle" };

  let database: string | null;
  try {
    database = firstScalar(
      await db.execute(sql`SELECT DATABASE() AS databaseName`)
    );
  } catch (err) {
    return {
      status: "unavailable",
      reason: "inspection-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!database)
    return { status: "unavailable", reason: "no-database-context" };

  const tables = Object.keys(required);
  let raw: unknown;
  try {
    raw = await db.execute(
      sql`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(
            tables.map(t => sql`${t}`),
            sql`, `
          )})`
    );
  } catch (err) {
    return {
      status: "unavailable",
      reason: "inspection-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const normalized = normalizeSchemaRows(raw);
  if (!normalized.ok)
    return { status: "unavailable", reason: "unrecognized-driver-result" };
  return { status: "ok", database, rows: normalized.rows };
}

/**
 * The pure comparison, split out from the DB read so it can be tested.
 *
 * Worth testing directly: this is the code that decides whether a skipped
 * migration is announced or ignored, and it reported PASS through BOTH ledger
 * deploys — not because the logic was wrong, but because the tables were never
 * declared. A test that can construct "every table but this one" is the only
 * way to prove the absence is now caught.
 */
export function compareSchema(
  presentRows: ReadonlyArray<{ t: string; c: string }>,
  required: Readonly<Record<string, readonly string[]>> = REQUIRED_COLUMNS
): SchemaDrift[] {
  const present = new Map<string, Set<string>>();
  for (const r of presentRows) {
    const t = String(r.t),
      c = String(r.c);
    if (!present.has(t)) present.set(t, new Set());
    present.get(t)!.add(c);
  }

  const drift: SchemaDrift[] = [];
  for (const [table, cols] of Object.entries(required)) {
    const have = present.get(table);
    if (!have) {
      drift.push({ table, missingColumns: [...cols], tableMissing: true });
      continue;
    }
    const missing = cols.filter(c => !have.has(c));
    if (missing.length)
      drift.push({ table, missingColumns: missing, tableMissing: false });
  }
  return drift;
}

/**
 * RETIRED: the drift-shape heuristic (`INCONCLUSIVE_MIN_TABLES` /
 * `isInconclusiveRead`).
 *
 * It inferred "the read failed" from all-required-tables-missing, because a
 * migration does not drop the whole product schema. That inference existed only
 * because the read state was not observable — and it was wrong in one direction
 * that matters: a product service genuinely pointed at an empty or WRONG database
 * was waved through as merely unknown, and stayed non-fatal with the guard armed.
 *
 * `inspectSchema` now observes the read state directly, so every case the
 * heuristic covered has an explicit home and nothing is inferred from shape:
 *
 *   no database handle        -> unavailable / no-database-handle
 *   connect or query throws   -> unavailable / inspection-failed
 *   DATABASE() null           -> unavailable / no-database-context
 *   unrecognized driver shape -> unavailable / unrecognized-driver-result
 *   context OK, zero tables   -> FAIL  (confirmed: right place, nothing there)
 *   context OK, partial drift -> FAIL
 *   context OK, complete      -> PASS
 *
 * Two systems solving the same ambiguity is worse than one, so the heuristic is
 * gone rather than layered. Explicit state beats a statistical argument.
 */

/** Human-readable, actionable — names the exact objects and the fix. */
export function formatDrift(drift: readonly SchemaDrift[]): string {
  return drift
    .map(d =>
      d.tableMissing
        ? `  table "${d.table}" is MISSING entirely (${d.missingColumns.length} expected columns)`
        : `  table "${d.table}" is missing: ${d.missingColumns.join(", ")}`
    )
    .join("\n");
}

/**
 * Run once at boot. Never throws on its own failure — an unreachable database at
 * startup is the circuit breaker's problem, not this check's.
 */
export async function assertSchemaCurrent(
  /**
   * Injectable for tests, exactly as `runSchemaProbe(probe = probeAppUsersSchema)`
   * is in schemaHealthGate. It exists so the child-process fatal test can drive a
   * REAL `process.exit` without a real database — a spy can prove the call was
   * made, but only a spawned process can prove the process actually died.
   */
  inspect: typeof inspectSchema = inspectSchema
): Promise<SchemaGuardResult> {
  // Both Railway services run the SAME build, but only one owns these tables.
  // The analytics store (ai-sports-betting-backend, ANALYTICS_ROLE=store) points
  // its DATABASE_URL at a different database that by design holds analytics_events
  // and none of the product/billing tables declared above. So every one of them
  // reads as "MISSING entirely" on every boot: ten tables, plus a "login, checkout,
  // fulfilment will break" warning, none of it true there.
  //
  // That is worse than noise. This guard exists to make ONE failure impossible to
  // miss — code deployed ahead of its migration, which took platform-wide login
  // down on 2026-07-31 — and a guard that screams on every single boot of one
  // service is precisely how the real alarm gets scrolled past.
  //
  // Scoped by ROLE, deliberately, not by drift shape. Treating "table missing
  // entirely" as benign would have been the smaller diff and the wrong fix: that
  // case IS the ledger miss described in REQUIRED_COLUMNS above, and it has to
  // stay loud on the service that actually owns the tables.
  if (isAnalyticsStore()) {
    console.log(
      `${TAG} [VERIFY] N/A — ANALYTICS_ROLE=store. This instance's DATABASE_URL is the ` +
        `analytics store, which owns none of the product tables this guard checks, so drift ` +
        `here would be meaningless. The product service reports the real verdict.`
    );
    return { status: "not_applicable", drift: [], reason: "analytics-store" };
  }

  const inspection = await inspect();
  if (inspection.status === "unavailable") {
    // No verdict. Explicitly NOT a pass, and explicitly not fatal: freezing
    // deploys on a cold or blipping database would be a self-inflicted outage,
    // and the DB circuit breaker plus the app_users health gate already own
    // database availability. Same fail-open asymmetry as schemaHealthGate.
    console.error(
      `${TAG} [VERIFY] UNAVAILABLE — no schema verdict could be produced ` +
        `(${inspection.reason}${inspection.detail ? `: ${inspection.detail}` : ""}). ` +
        `This is NOT a pass: the guarded schema was not verified on this boot. ` +
        `Not fatal even under SCHEMA_GUARD_FATAL=1, because an unverifiable check ` +
        `must not decide that a healthy deployment cannot serve.`
    );
    return {
      status: "unavailable",
      drift: [],
      reason: inspection.reason,
      ...(inspection.detail ? { detail: inspection.detail } : {}),
    };
  }

  const drift = compareSchema(inspection.rows);
  if (drift.length === 0) {
    console.log(
      `${TAG} [VERIFY] PASS — live schema satisfies every required column ` +
        `(database "${inspection.database}", ${Object.keys(REQUIRED_COLUMNS).length} tables inspected)`
    );
    return { status: "pass", drift: [], database: inspection.database };
  }

  // Reached only when the inspection itself succeeded, so this is CONFIRMED.
  // That now includes "every table absent", which the retired heuristic used to
  // wave through: with the schema context proven non-null, zero required tables
  // means the product service is pointed at an empty or wrong database, and it
  // must not serve.
  const detail = formatDrift(drift);
  console.error(
    `${TAG} [VERIFY] FAIL — the running code expects schema objects that do not exist ` +
      `in database "${inspection.database}":\n${detail}\n` +
      `${TAG} This means code deployed AHEAD of its migration. Drizzle enumerates every declared ` +
      `column, so queries against these tables will fail with ER_BAD_FIELD_ERROR and user-facing ` +
      `flows (login, checkout, fulfilment) will break.\n` +
      `${TAG} FIX: run the pending migration workflow, then redeploy.`
  );
  if (process.env.SCHEMA_GUARD_FATAL === "1") {
    console.error(
      `${TAG} SCHEMA_GUARD_FATAL=1 — refusing to serve with a stale schema.`
    );
    process.exit(1);
  }
  return { status: "fail", drift, database: inspection.database };
}

/**
 * Boot preflight: resolve the authoritative verdict BEFORE the server accepts
 * traffic, bounded so a cold database cannot wedge startup.
 *
 * Sequencing is the point. Until this existed the full guard ran fire-and-forget
 * from the `listening` handler, so with SCHEMA_GUARD_FATAL=1 a confirmed-stale
 * deployment began accepting requests and exited underneath them. The narrow
 * app_users probe (schemaHealthGate) already ran pre-listen; this gives the
 * nine-table guard the same standing.
 *
 * The timeout mirrors runBootSchemaProbe's reasoning: the budget must exceed the
 * pool's 15s connectTimeout, because at boot this may open the very first
 * connection. A timeout yields no verdict, which is `unavailable`, which is
 * fail-open — never a pass, never fatal.
 */
export async function runSchemaGuardPreflight(
  timeoutMs = 20_000
): Promise<SchemaGuardResult> {
  const timedOut: SchemaGuardResult = {
    status: "unavailable",
    drift: [],
    reason: "inspection-failed",
    detail: `preflight exceeded ${timeoutMs}ms`,
  };
  const result = await Promise.race([
    assertSchemaCurrent(),
    new Promise<SchemaGuardResult>(resolve => {
      const t = setTimeout(() => resolve(timedOut), timeoutMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
  if (result === timedOut) {
    console.error(
      `${TAG} [VERIFY] UNAVAILABLE — preflight exceeded ${timeoutMs}ms; ` +
        `continuing to listen without a verdict (not a pass).`
    );
  }
  return result;
}
