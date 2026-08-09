/**
 * client/src/pages/dime/checkoutCopy.ts
 *
 * Pure checkout display/disclosure copy for /checkout. Extracted from
 * CheckoutPage.tsx so the cadence contract is unit-testable without mounting
 * Stripe Elements — the words next to the pay button are a financial
 * disclosure, and a disclosure that cannot be tested cannot be trusted.
 *
 * THE INVARIANT (Session 3, PR B):
 *
 *   selected price → displayed amount
 *                  → displayed period
 *                  → renewal sentence
 *                  → legal authorization line
 *
 * all describe the SAME transaction. The customer must never read one billing
 * cadence while Stripe charges another.
 *
 * No I/O, no React, no Stripe SDK — everything here is a pure function of the
 * price row the caller already selected.
 */

/** Copy for one checkout offer — legacy static plan or owner-created DB plan. */
export interface PlanCopy {
  /** Rail tier name + success-panel subject. */
  name: string;
  /** Form card heading. */
  heading: string;
  price: string;
  period: string;
  /** "Works out to" per-day line — omitted (empty) for owner-created DB plans. */
  perDay?: string;
  /** v2 ladder rail rows — legacy plans keep their existing compact rail.
   *  Withheld while the tiered Analyst models are not live: no plan sets it, so
   *  the "Model access" row does not render. Kept for the day the tiers ship. */
  modelAccess?: string;
  /** Withheld until the credit ledger grants and meters credits (PROD-001). */
  credits?: string;
  features?: string[];
  payLabel: string;
  renewal: string;
  /**
   * The recurring cadence PHRASE for this exact price — "daily", "weekly",
   * "monthly", "annually", "every 2 weeks", … as produced by `cadencePhrase`.
   *
   * Deliberately a phrase and not a `"monthly" | "annually"` union. That union
   * was the Session 3 disclosure defect: every non-yearly interval collapsed to
   * "monthly", so a $74.99/week checkout rendered "then monthly until you
   * cancel" directly under the pay button while `renewal` correctly said
   * weekly. One cadence interpretation, derived once, used everywhere.
   */
  chargeCadence: string;
  /** false → a one-time ("Lifetime") purchase — no renewal, no cancellation row.
   *  undefined/true → recurring (all legacy plans). */
  recurring?: boolean;
}

/** Public display shape returned by stripe.publicGetCheckoutPlan (DB plans). */
export interface DbCheckoutPlan {
  slug: string;
  name: string;
  description: string | null;
  amountCents: number;
  currency: string;
  interval: "day" | "week" | "month" | "year" | null;
  intervalCount: number | null;
  recurring: boolean;
  trialPeriodDays: number | null;
  label: string | null;
  soldOut: boolean;
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/**
 * Human cadence phrase for a recurring DB interval (e.g. "monthly",
 * "every 2 weeks"). This is THE single cadence authority — the price line, the
 * renewal sentence and the legal authorization line all read from it, so they
 * cannot drift apart.
 *
 * A null interval defaults to "month": `publicGetCheckoutPlan` sets
 * `recurring = (price.interval != null)`, so recurring prices always carry one;
 * defaulting keeps a malformed row from rendering "every 1 null".
 */
export function cadencePhrase(
  interval: DbCheckoutPlan["interval"],
  count: number | null
): string {
  const unit = interval ?? "month";
  const n = count && count > 1 ? count : 1;
  if (n === 1) {
    if (unit === "day") return "daily";
    if (unit === "week") return "weekly";
    if (unit === "month") return "monthly";
    if (unit === "year") return "annually";
  }
  return `every ${n} ${unit}${n > 1 ? "s" : ""}`;
}

/** Build the checkout display copy for an owner-created DB plan/interval. */
export function buildDbCopy(d: DbCheckoutPlan): PlanCopy {
  const priceStr = formatMoney(d.amountCents, d.currency);
  if (!d.recurring) {
    return {
      name: d.name,
      heading: `Activate ${d.name}`,
      price: priceStr,
      period: "one-time",
      payLabel: `Get lifetime access — ${priceStr}`,
      renewal: "One-time payment — lifetime access. No renewals.",
      // Empty for the same reason as LOADING_COPY: a one-time purchase has no
      // recurring cadence, so stamping "monthly" here would be a claim the
      // price does not support. Dead today (buildLegalLine branches on
      // `recurring` first) — but the field's contract is "the cadence of THIS
      // price", and a placeholder that contradicts it is how the original
      // defect started.
      chargeCadence: "",
      recurring: false,
    };
  }
  const n = d.intervalCount && d.intervalCount > 1 ? `${d.intervalCount} ` : "";
  const unit = d.interval ?? "month";
  const period = `/ ${n}${unit}${d.intervalCount && d.intervalCount > 1 ? "s" : ""}`;
  const phrase = cadencePhrase(d.interval, d.intervalCount);
  return {
    name: d.name,
    heading: `Activate ${d.name}`,
    price: priceStr,
    period,
    payLabel: `Subscribe — ${priceStr}`,
    renewal: `Auto-renews ${phrase} at ${priceStr} until cancelled. Cancel anytime before renewal.`,
    chargeCadence: phrase,
    recurring: true,
  };
}

/** The trailing half of every legal line — never varies with the price. */
const STRIPE_ASSURANCE =
  "Secure processing by Stripe — card details never touch our servers.";

/**
 * Placeholder shown in the rail while the DB plan's display info loads.
 *
 * `chargeCadence` is deliberately EMPTY, not "monthly". No price has been
 * selected yet at this point, so any cadence here would be an unfounded claim —
 * and the previous "monthly" placeholder made a weekly plan's page read
 * "then monthly until you cancel" for as long as the lookup was in flight.
 * `buildLegalLine` renders the no-cadence form while this is the active copy.
 */
export const LOADING_COPY: PlanCopy = {
  name: "Loading…",
  heading: "Activate your plan",
  price: "—",
  period: "",
  payLabel: "Continue to payment",
  renewal: "",
  chargeCadence: "",
  recurring: true,
};

/** Renewal/authorization legal line under the pay button — recurring vs one-time. */
export function buildLegalLine(copy: PlanCopy): string {
  if (copy.recurring === false) {
    return `Charged once today — lifetime access, no renewals. ${STRIPE_ASSURANCE}`;
  }
  // No cadence resolved yet (loading) → promise nothing about renewal timing.
  if (!copy.chargeCadence) return STRIPE_ASSURANCE;
  return `Charged today, then ${copy.chargeCadence} until you cancel. ${STRIPE_ASSURANCE}`;
}
