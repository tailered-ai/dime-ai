/**
 * server/stripe/nonDimePrices.ts
 *
 * Session 3 / PR A0 — emergency cross-business containment.
 *
 * THE PROBLEM
 * -----------
 * This Stripe account (acct_1SKTfG…) does not only sell Dime. It has also taken
 * client project invoices (OffDuty setup work, the WNBA project) and platform
 * donations. Those are legitimate revenue with no Dime entitlement attached.
 *
 * `checkout.session.completed` in server/stripeWebhook.ts has no product,
 * price, or business allowlist anywhere between the case label and fulfilment.
 * When a paid session carries no application metadata — which is true of EVERY
 * Stripe Payment Link, since Payment Links cannot set our `plan_id`/`price_id`
 * — the handler falls through to `resolvePlanExpiry(undefined)` →
 * `normalizePlanId` → **"monthly"**, logs
 *   `[VERIFY] FAIL — price … not in any plan map; defaulting to "monthly"`
 * and then **continues** (there is no `break` on that branch), granting
 * ~30 days of real Dime access.
 *
 * So a $500 OffDuty client invoice reaching this handler grants Dime access.
 * That is not hypothetical: plink_1Tu9KR is `customer_creation=always` with
 * `setup_future_usage=off_session`, so a Stripe Customer is guaranteed and the
 * `!stripeCustomerId` guard can never fire for it — and one such $500 session
 * has already completed in production (2026-07-17).
 *
 * WHY EXACT PRICE IDs, AND NOTHING ELSE
 * -------------------------------------
 * Classification keys on the exact Stripe Price ID and nothing else. Not the
 * product name, not the amount, not the presence of metadata:
 *
 *  - Amounts collide. Two different live $124.99 one-time prices exist, one
 *    Dime and one not. Amount cannot identify an offer.
 *  - Product names collide too — two distinct live Products are both named
 *    "Dime Pro", and two distinct Products are both named "WNBA Project".
 *  - `metadata.dime_plan_slug` is write-only in this codebase (three write
 *    sites in planProvisioning.ts, zero read sites) and is documented there as
 *    best-effort. It is provenance, never a guard.
 *
 * SCOPE — deliberately narrow
 * ---------------------------
 * This module answers ONE question: "has the owner explicitly classified this
 * exact Price as non-Dime?" It does not decide what a Dime price grants, and it
 * does not change what happens to prices it does not recognise. Unknown prices
 * keep their existing behaviour here; making unknown fail closed belongs to the
 * full PR A, which is gated on the production `plan_prices` read so that the
 * historical one-time Dime fallback prices get their correct entitlement rather
 * than being stranded.
 *
 * Commercial classification below is owner-admitted business truth, recorded
 * 2026-08-10. It is not inferred from any field on the Stripe object.
 */

/**
 * Exact live Stripe Price IDs the owner has confirmed sell something other than
 * Dime access. A payment on one of these is valid revenue that must produce
 * ZERO Dime entitlement.
 *
 * Keyed by Price ID because that is the only stable identity of a commercial
 * offer. Adding an entry is a commercial decision, not a code cleanup — every
 * entry needs the owner's confirmation of intent recorded alongside it.
 */
const NON_DIME_PRICES: ReadonlyMap<string, string> = new Map([
  [
    // plink_1Tu9KR… · $500.00 one-time · product "OffDuty Domain + Bot + Server Setup"
    // Client services invoice for the separate OffDuty Locks project.
    // customer_creation=always, so this is the one that provably reaches the grant path.
    "price_1Tu9IsPa3TFEAkkYSRU1iHLS",
    "OffDuty client services invoice",
  ],
  [
    // plink_1TtJWp… · $250.00 one-time · product "WNBA Project"
    "price_1TtJWhPa3TFEAkkYX4e6bkfO",
    "WNBA project invoice",
  ],
  [
    // plink_1U2Q6D… · $125.00 one-time · product "WNBA Project"
    // Created 2026-08-07, mid-Session-3 — the drift event that proved this
    // registry has to exist rather than being a one-off audit.
    "price_1U2Q5cPa3TFEAkkYrjjvZERp",
    "WNBA project invoice",
  ],
  [
    // plink_1TwFS6… · custom_unit_amount (pay-what-you-want, preset $50)
    // product "Donate to the Dime AI Platform". A donation to the platform is
    // not a purchase of it — and the amount is chosen by the donor, so amount
    // could never have identified this one.
    "price_1TwFS5Pa3TFEAkkYZR7sEnKK",
    "platform donation",
  ],
]);

/**
 * True when this exact Stripe Price is owner-classified as non-Dime.
 *
 * Returns false for null/undefined/empty deliberately: "we could not determine
 * the price" is NOT the same as "this is non-Dime", and must never be treated
 * as a classification. The caller keeps its existing behaviour in that case.
 */
export function isKnownNonDimePrice(
  priceId: string | null | undefined
): boolean {
  if (!priceId) return false;
  return NON_DIME_PRICES.has(priceId);
}

/**
 * Short human reason for the ledger's `fulfillmentReason`, or null when the
 * price is not a known non-Dime price. Kept short — the column is varchar(120)
 * and the caller prefixes it.
 */
export function nonDimeReason(
  priceId: string | null | undefined
): string | null {
  if (!priceId) return null;
  return NON_DIME_PRICES.get(priceId) ?? null;
}

/** Exact Price IDs currently classified non-Dime. Exposed for tests/audit. */
export function knownNonDimePriceIds(): readonly string[] {
  return Array.from(NON_DIME_PRICES.keys());
}
