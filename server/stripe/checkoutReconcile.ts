/**
 * Checkout reconciliation — Stripe is the source of truth, we are the replica.
 *
 * The webhook is a PUSH channel, and every push channel has three failure modes
 * it cannot report on itself:
 *
 *   1. The event was never subscribed. `checkout.session.expired` is not on the
 *      live endpoint's event list, so an abandoned checkout stays 'created'
 *      locally forever and abandonment cannot be measured.
 *   2. The event was subscribed but never delivered — endpoint down, deploy
 *      window, Stripe retry exhaustion. Nothing local fires, so nothing knows.
 *   3. The event arrived and the handler bailed. This one the ledger already
 *      catches, because every bail path now writes a `dropped` row.
 *
 * A pull-based sweep covers all three, and needs no Dashboard configuration.
 * That matters: relying on a manually-ticked checkbox to notice lost revenue is
 * the same category of mistake as relying on a log line nobody reads.
 *
 * READ-ONLY against Stripe. The only writes are to our own ledger.
 */
import type Stripe from "stripe";
import { getStripe } from "./client";
import { getDb } from "../db";
import { checkoutSessions } from "../../drizzle/schema";
import { resolveCheckout } from "./checkoutLedger";
import { inArray } from "drizzle-orm";

const TAG = "[CheckoutReconcile]";

/** Stripe caps `limit` at 100; pages beyond this are a runaway, not a backlog. */
const DEFAULT_MAX_PAGES = 10;
/** How far back to sweep. Sessions expire after 24h, so 3 days covers any gap. */
const DEFAULT_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * When the checkout ledger went live (2026-08-01T09:00Z, migration 0126).
 *
 * The sweep infers "we never fulfilled this" from the ABSENCE of a ledger row.
 * That inference is only valid for sessions created after the ledger existed —
 * before it, every session is absent by construction, whether or not it was
 * fulfilled.
 *
 * A dry run against the live account proved this matters: it flagged all 9
 * historical paid sessions as dropped, when most had in fact been provisioned
 * by hand. Shipping that would have opened with nine false alarms and taught
 * everyone to ignore the signal on day one.
 *
 * Older sessions are still back-filled for the record, but as `skipped` with an
 * explicit "outcome unknown" reason — never as `dropped`.
 */
const LEDGER_EPOCH_MS = Date.parse("2026-08-01T09:00:00Z");

export type ReconcileOutcome = {
  scanned: number;
  /** Sessions Stripe reports complete that we never fulfilled. Revenue at risk. */
  unfulfilled: number;
  /** Expired sessions whose local row was still 'created'. */
  expiredResolved: number;
  /** Sessions with no local row at all — the webhook never landed. */
  backfilled: number;
  /** Rows already correct. */
  alreadyConsistent: number;
  truncated: boolean;
  /** Session ids that took money and granted nothing — for alerting. */
  unfulfilledIds: string[];
};

/**
 * Map a Stripe session to the ledger outcome it should have.
 *
 * Exported for tests: this is the whole decision table, and getting it wrong in
 * either direction is expensive. Marking a live session 'dropped' would cry
 * wolf; missing a real drop is the incident we are trying to end.
 */
export function classifySession(s: {
  status?: string | null;
  payment_status?: string | null;
  customer?: unknown;
}): {
  status: "created" | "completed" | "expired";
  fulfillment: "pending" | "fulfilled" | "dropped" | "skipped";
  reason: string | null;
} | null {
  // Still open — nothing to resolve yet. Leaving it 'created' is correct.
  if (s.status === "open") return null;

  if (s.status === "expired") {
    return {
      status: "expired",
      fulfillment: "skipped",
      reason: "session expired without payment (reconciled)",
    };
  }

  if (s.status === "complete") {
    const paid =
      s.payment_status === "paid" || s.payment_status === "no_payment_required";
    if (!paid) {
      return {
        status: "completed",
        fulfillment: "skipped",
        reason: `payment_status=${s.payment_status} (reconciled)`,
      };
    }
    // Complete AND paid, but our ledger never recorded a fulfilment. Either the
    // webhook never arrived or the handler bailed. Either way: money taken,
    // access not granted.
    return {
      status: "completed",
      fulfillment: "dropped",
      reason:
        "complete+paid in Stripe but never fulfilled locally (reconciled)",
    };
  }

  return null; // unknown status — do not guess
}

async function listRecentSessions(
  maxPages: number,
  sinceMs: number
): Promise<{ sessions: Stripe.Checkout.Session[]; truncated: boolean }> {
  const stripe = getStripe();
  const out: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const page: Stripe.ApiList<Stripe.Checkout.Session> =
      await stripe.checkout.sessions.list({
        limit: 100,
        created: { gte: Math.floor(sinceMs / 1000) },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
    out.push(...page.data);
    pages += 1;
    if (!page.has_more || page.data.length === 0) {
      return { sessions: out, truncated: false };
    }
    startingAfter = page.data[page.data.length - 1].id;
  }
  return { sessions: out, truncated: true };
}

/**
 * Sweep recent Stripe checkout sessions and correct the ledger.
 *
 * Throws only when the whole run is impossible (no Stripe key, no database) —
 * a silently empty report would read as "no problems", which is the one wrong
 * answer this function must never give. Per-session faults are logged and the
 * scan continues.
 */
export async function reconcileCheckoutSessions(opts?: {
  maxPages?: number;
  lookbackMs?: number;
  dryRun?: boolean;
}): Promise<ReconcileOutcome> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_PAGES);
  const lookbackMs = Math.max(60_000, opts?.lookbackMs ?? DEFAULT_LOOKBACK_MS);
  const dryRun = opts?.dryRun ?? false;

  const db = await getDb();
  if (!db)
    throw new Error(
      `${TAG} database unavailable — refusing to report an empty sweep as clean`
    );

  const since = Date.now() - lookbackMs;
  const { sessions, truncated } = await listRecentSessions(maxPages, since);
  console.log(
    `${TAG} [STATE] scanned ${sessions.length} Stripe sessions since ${new Date(since).toISOString()} truncated=${truncated}`
  );

  const ids = sessions.map(s => s.id);
  const existing = ids.length
    ? await db
        .select({
          stripeSessionId: checkoutSessions.stripeSessionId,
          status: checkoutSessions.status,
          fulfillment: checkoutSessions.fulfillment,
        })
        .from(checkoutSessions)
        .where(inArray(checkoutSessions.stripeSessionId, ids))
    : [];
  type LocalRow = {
    stripeSessionId: string;
    status: string;
    fulfillment: string;
  };
  const local = new Map<string, LocalRow>(
    (existing as LocalRow[]).map(r => [r.stripeSessionId, r] as const)
  );

  const out: ReconcileOutcome = {
    scanned: sessions.length,
    unfulfilled: 0,
    expiredResolved: 0,
    backfilled: 0,
    alreadyConsistent: 0,
    truncated,
    unfulfilledIds: [],
  };

  for (const s of sessions) {
    try {
      const want = classifySession(s);
      if (!want) continue; // still open

      const have = local.get(s.id);
      const createdMs = (s.created ?? 0) * 1000;

      // Predates the ledger: absence of a row proves nothing, so this session
      // may not be judged. Record it for the history, explicitly undecided.
      if (!have && createdMs < LEDGER_EPOCH_MS) {
        out.backfilled += 1;
        if (dryRun) {
          console.log(
            `${TAG} [DRY] would back-fill pre-ledger ${s.id} as skipped/unknown`
          );
          continue;
        }
        await resolveCheckout({
          stripeSessionId: s.id,
          status: want.status,
          fulfillment: "skipped",
          reason: "predates the checkout ledger — outcome unknown, not judged",
          customerEmail: s.customer_details?.email ?? null,
          stripeCustomerId: typeof s.customer === "string" ? s.customer : null,
          paymentStatus: s.payment_status ?? null,
          amountCents: s.amount_total ?? null,
          currency: s.currency ?? null,
        });
        continue;
      }

      // Already settled correctly — the webhook did its job. Do not rewrite a
      // 'fulfilled' row: the webhook is authoritative for success, and this
      // sweep only ever sees the session, not the entitlement it produced.
      if (have && have.fulfillment === "fulfilled") {
        out.alreadyConsistent += 1;
        continue;
      }
      // Nor a DELIBERATE skip on a completed session. `classifySession` only
      // knows two outcomes for complete+paid — fulfilled or "dropped" — so a
      // non-Dime sale (server/stripe/nonDimePrices.ts: a valid OffDuty/WNBA/
      // donation payment that must never grant Dime access) would otherwise be
      // rewritten to `dropped`, its commercial reason destroyed, and reported
      // as "MONEY TAKEN WITHOUT ACCESS". That alarm's designed response is a
      // manual entitlement grant — i.e. the false alarm would induce by hand
      // exactly the Dime access the containment exists to prevent.
      //
      // The rule is the same as for 'fulfilled': this sweep exists to fill
      // SILENCE, not to overrule a webhook that already reached a decision.
      if (
        have &&
        have.fulfillment === "skipped" &&
        have.status === "completed"
      ) {
        out.alreadyConsistent += 1;
        continue;
      }
      if (
        have &&
        have.status === want.status &&
        have.fulfillment === want.fulfillment
      ) {
        out.alreadyConsistent += 1;
        continue;
      }

      if (want.fulfillment === "dropped") {
        out.unfulfilled += 1;
        out.unfulfilledIds.push(s.id);
      } else if (want.status === "expired") {
        out.expiredResolved += 1;
      }
      if (!have) out.backfilled += 1;

      if (dryRun) {
        console.log(
          `${TAG} [DRY] would set ${s.id} -> ${want.status}/${want.fulfillment} (${want.reason})`
        );
        continue;
      }

      await resolveCheckout({
        stripeSessionId: s.id,
        status: want.status,
        fulfillment: want.fulfillment,
        reason: want.reason,
        customerEmail: s.customer_details?.email ?? null,
        stripeCustomerId:
          typeof s.customer === "string"
            ? s.customer
            : ((s.customer as Stripe.Customer | null)?.id ?? null),
        stripeSubscriptionId:
          typeof s.subscription === "string" ? s.subscription : null,
        stripePaymentIntentId:
          typeof s.payment_intent === "string" ? s.payment_intent : null,
        paymentStatus: s.payment_status ?? null,
        amountCents: s.amount_total ?? null,
        currency: s.currency ?? null,
      });
    } catch (err) {
      // One malformed session must not abort the sweep.
      console.error(
        `${TAG} [FAIL] session ${s.id}: ${(err as Error)?.message ?? err}`
      );
    }
  }

  const level = out.unfulfilled > 0 ? "error" : "log";
  console[level](
    `${TAG} [VERIFY] scanned=${out.scanned} unfulfilled=${out.unfulfilled} expired=${out.expiredResolved} ` +
      `backfilled=${out.backfilled} consistent=${out.alreadyConsistent} truncated=${out.truncated}` +
      (out.unfulfilled > 0
        ? ` — MONEY TAKEN WITHOUT ACCESS: ${out.unfulfilledIds.join(", ")}`
        : "")
  );
  return out;
}
