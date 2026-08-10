/**
 * server/stripe/recurringAuthority.ts
 *
 * Session 3 / PR A — the exact current Stripe Price and the exact Stripe billing
 * period govern recurring Dime entitlement.
 *
 * THE DEFECT THIS REPLACES
 * -----------------------
 * `customer.subscription.created|updated` resolved entitlement like this:
 *
 *     resolvePlanExpiry(sub.metadata?.plan_id)
 *       -> getPlanBySlug(slug)
 *       -> defaultPriceOf(plan)        // the plan's isDefault row
 *       -> computeExpiryMsForPrice(price, plan, Date.now())
 *
 * Two independent faults, and they compound:
 *
 *  R-1  PRICE / INTERVAL AUTHORITY. `sub.metadata.plan_id` is a plan SLUG
 *       written at checkout. It cannot say which interval was bought, and
 *       Stripe never updates it — a Customer Portal switch changes the
 *       subscription item and leaves the metadata untouched. So the code fell
 *       back to the plan's DEFAULT price. An annual subscriber on a
 *       month-default plan was re-dated as if monthly; a Pro->Sharp switch kept
 *       saying Pro.
 *
 *  R-2  PERIOD ANCHOR AUTHORITY. Expiry came from `Date.now() + interval`, not
 *       from the period Stripe actually billed. Even for a subscriber whose
 *       interval IS the default, any mid-cycle update restarted the clock from
 *       the moment the webhook happened to arrive.
 *
 * Note the shape of R-2: `invoice.paid`/`subscription_cycle` already anchors to
 * the invoice's billed period (WBHK-006), so a renewal wrote the RIGHT expiry —
 * and a `customer.subscription.updated` for the same cycle could then overwrite
 * it with a fresh wall-clock window. The correct value was being produced and
 * then discarded.
 *
 * THE RULE
 * --------
 *     current Stripe subscription item Price  ->  plan + planPriceId
 *     current Stripe subscription period      ->  expiryDate
 *
 * Metadata is corroborating evidence, never authority.
 *
 * WHAT THIS MODULE DELIBERATELY WILL NOT DO
 * -----------------------------------------
 *  - It will not revoke. An unmapped Price means "we do not understand this
 *    subscription", which is a reason to stop writing, not a reason to cut off
 *    someone who is paying. Unknown fails closed against NEW entitlement
 *    mutation, not against existing access.
 *  - It will not touch a grandfathered lifetime member. Lifetime VIPs bought a
 *    retired one-time product and are outside the recurring model entirely;
 *    writing a period-bounded expiry onto one would convert lifetime access
 *    into a subscription window.
 *  - It will not invent a planPriceId. Legacy static plans (products.ts PLANS)
 *    have no `plan_prices` row, so the field is left alone rather than nulled —
 *    clearing a correct value is worse than leaving a stale one.
 *  - It does not map Prices itself. The caller resolves the exact Price through
 *    the two authorities that already exist — `getPriceById` (DB catalog) and
 *    `getPlanByPriceId` (legacy static) — and passes the result in. Adding a
 *    third lookup table here is how classification engines start to disagree.
 */

import { LIFETIME_ACCESS_UNTIL_MS } from "./planStore";
import type { BillingInterval } from "./planStore";

/** Exact interval length in ms — mirrors planStore's owner-specified table. */
const INTERVAL_MS: Record<BillingInterval, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

/**
 * A Stripe Price that resolved to something this application understands.
 *
 * `planPriceRowId` is null for legacy static plans, which predate the DB
 * catalog and have no `plan_prices` row. Null means "leave the stored value
 * alone", NOT "write null".
 */
export type MappedRecurringPrice = {
  planSlug: string;
  planPriceRowId: number | null;
  interval: BillingInterval | null;
  intervalCount: number | null;
  source: "catalog" | "legacy_static";
};

export type RecurringResolution =
  | {
      kind: "apply";
      priceId: string;
      planId: string;
      /** null → do not write; the caller must omit the field entirely. */
      planPriceId: number | null;
      expiryMs: number;
      expirySource: "stripe_period" | "price_interval";
      mapSource: "catalog" | "legacy_static";
    }
  | { kind: "preserve_lifetime"; priceId: string | null; reason: string }
  | { kind: "manual_review"; priceId: string | null; reason: string };

/**
 * Does this stored expiry mean "lifetime"?
 *
 * Two representations exist and both are live: the webhook writes the
 * far-future sentinel `LIFETIME_ACCESS_UNTIL_MS`, while the admin path stores
 * NULL (see adminAccountProvisioning.ts, which maps the sentinel back to null).
 * Anything at or beyond the sentinel counts — a value past 2100 is not a
 * billing period by any reading.
 */
export function isLifetimeEntitlement(
  expiryMs: number | null | undefined
): boolean {
  if (expiryMs == null) return true;
  return expiryMs >= LIFETIME_ACCESS_UNTIL_MS;
}

/**
 * Resolve an exact Stripe Price through the two authorities that already exist.
 *
 * Order is deliberate: the DB catalog first, then the legacy static map. A
 * catalog miss is NOT yet "unknown" — `products.ts` PLANS predate the catalog
 * and those subscriptions are still live, so treating a legacy Price as
 * unrecognised would stop extending a paying member's access.
 *
 * The lookups are injected rather than imported so this — the wiring that
 * decides which authority answers — is executable in a test. `stripeWebhook.ts`
 * sits at the top level of `server/`, which the patch-coverage gate's
 * `server/**\/*.ts` pathspec does not match (it matches 0 of the 213 files
 * there), so logic left inline in the handler is measured by nothing.
 */
export async function mapRecurringPrice(
  priceId: string | null | undefined,
  deps: {
    catalog: (id: string) => Promise<{
      plan: { slug: string };
      price: {
        id: number;
        interval: BillingInterval | null;
        intervalCount: number | null;
      };
    } | null>;
    legacy: (id: string) => { id: string; interval: string } | null;
  }
): Promise<MappedRecurringPrice | null> {
  if (!priceId) return null;

  const hit = await deps.catalog(priceId);
  if (hit) {
    return {
      planSlug: hit.plan.slug,
      planPriceRowId: hit.price.id,
      interval: hit.price.interval,
      intervalCount: hit.price.intervalCount,
      source: "catalog",
    };
  }

  const legacy = deps.legacy(priceId);
  if (legacy) {
    return {
      planSlug: legacy.id,
      // No plan_prices row exists for a legacy static plan. Null means "leave
      // the stored value alone" — nulling a correct id is strictly worse.
      planPriceRowId: null,
      interval: legacy.interval as BillingInterval,
      intervalCount: 1,
      source: "legacy_static",
    };
  }

  return null;
}

/**
 * Decide what a recurring subscription event should write.
 *
 * Pure on purpose: every input is a value the caller has already resolved, so
 * the whole decision table is testable without Stripe, a database, or a clock.
 *
 * Order matters and is load-bearing:
 *   1. lifetime first — a grandfathered member is never re-dated, whatever the
 *      subscription says;
 *   2. no Price — nothing to be authoritative about;
 *   3. no mapping — we do not guess;
 *   4. Stripe's period if it supplied one, else the EXACT current price's
 *      interval (never the plan default) measured from now;
 *   5. neither → we cannot date the entitlement, so we do not write one.
 */
export function resolveRecurringEntitlement(args: {
  /** `sub.items.data[0].price.id` — the Price the customer is billed at NOW. */
  priceId: string | null | undefined;
  /** Catalog or legacy resolution of that exact Price, or null if unmapped. */
  mapped: MappedRecurringPrice | null;
  /** `subscriptionPeriodEndMs(sub)` — Stripe's own boundary, or null. */
  stripePeriodEndMs: number | null;
  /** The member's CURRENT stored expiry, used only to detect lifetime. */
  existingExpiryMs: number | null | undefined;
  nowMs: number;
}): RecurringResolution {
  const { priceId, mapped, stripePeriodEndMs, existingExpiryMs, nowMs } = args;

  // (1) A grandfathered lifetime member is outside the recurring model. Writing
  // a period-bounded expiry here would silently convert lifetime into a
  // subscription window, so this event contributes nothing but a record.
  if (isLifetimeEntitlement(existingExpiryMs)) {
    return {
      kind: "preserve_lifetime",
      priceId: priceId ?? null,
      reason:
        "grandfathered lifetime entitlement — recurring events do not re-date it",
    };
  }

  if (!priceId) {
    return {
      kind: "manual_review",
      priceId: null,
      reason: "subscription carries no line-item Price — nothing authoritative",
    };
  }

  if (!mapped) {
    return {
      kind: "manual_review",
      priceId,
      reason: `Price ${priceId} maps to no catalog row and no legacy plan — existing access preserved, no entitlement written`,
    };
  }

  // (4) Stripe's boundary wins whenever it exists — including when it is
  // EARLIER than a locally computed window. A downgrade or a cancel_at is a
  // real shortening, and inventing a longer window would give away access.
  let expiryMs: number;
  let expirySource: "stripe_period" | "price_interval";
  if (stripePeriodEndMs != null) {
    expiryMs = stripePeriodEndMs;
    expirySource = "stripe_period";
  } else if (mapped.interval) {
    // Fallback: the interval of the EXACT price they hold, never the plan
    // default. Strictly better than the old behaviour, still second choice.
    const count =
      mapped.intervalCount && mapped.intervalCount > 0
        ? mapped.intervalCount
        : 1;
    expiryMs = nowMs + INTERVAL_MS[mapped.interval] * count;
    expirySource = "price_interval";
  } else {
    // (5) A recurring subscription whose price has no interval is incoherent.
    return {
      kind: "manual_review",
      priceId,
      reason: `Price ${priceId} has no billing interval and Stripe supplied no period end — cannot date the entitlement`,
    };
  }

  return {
    kind: "apply",
    priceId,
    planId: mapped.planSlug,
    planPriceId: mapped.planPriceRowId,
    expiryMs,
    expirySource,
    mapSource: mapped.source,
  };
}
