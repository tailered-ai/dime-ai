/**
 * server/stripe/nonDimePrices.test.ts
 *
 * Session 3 / PR A0 — emergency cross-business containment.
 *
 * The defect being locked down: `checkout.session.completed` has no business
 * allowlist, and its "price not in any plan map" branch LOGS WITHOUT BREAKING,
 * leaving plan="monthly" and expiry=now+30d. So a paid non-Dime client invoice
 * — OffDuty setup, a WNBA project invoice, a platform donation — grants real
 * Dime access. plink_1Tu9KR ($500 OffDuty) is customer_creation=always, so the
 * !stripeCustomerId guard can never save it, and one such session has already
 * completed in production.
 *
 * Two assertion kinds, matching this repo's existing convention (see
 * server/stripeWebhook.test.ts):
 *   1. behavioural tests over the pure classifier;
 *   2. source-contract tests for the handler wiring, which would otherwise
 *      need a live Express + Stripe + TiDB stack to observe.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  isKnownNonDimePrice,
  nonDimeReason,
  knownNonDimePriceIds,
} from "./nonDimePrices";

const ROOT = path.resolve(__dirname, "../..");
const WEBHOOK_SRC = fs.readFileSync(
  path.join(ROOT, "server/stripeWebhook.ts"),
  "utf8"
);

/** Owner-confirmed non-Dime, 2026-08-10. */
const OFFDUTY_500 = "price_1Tu9IsPa3TFEAkkYSRU1iHLS";
const WNBA_250 = "price_1TtJWhPa3TFEAkkYX4e6bkfO";
const WNBA_125 = "price_1U2Q5cPa3TFEAkkYrjjvZERp";
const DONATION = "price_1TwFS5Pa3TFEAkkYZR7sEnKK";

/** Owner-confirmed Dime-intended. These must NOT be blocked by PR A0. */
const DIME_FALLBACK = [
  "price_1U1vYRPa3TFEAkkYf1Z4AryF", // $149    Dime AI Model Lifetime Access
  "price_1TzHDsPa3TFEAkkYSxf13aZu", // $124.99 AI Model Lifetime Access
  "price_1TwBU5Pa3TFEAkkYf2GBnaqy", // $124.99 Lifetime Dime AI Model Projections
  "price_1TzH7bPa3TFEAkkYZ6VHVo78", // $99.99  AI Model Lifetime
  "price_1TrOBBPa3TFEAkkYQrre9LCf", // $199    Discord Access-Lifetime
];
const DIME_CATALOG_LIFETIME = "price_1TxADiPa3TFEAkkY8wHG6CSl"; // dime_plan_slug=dime-lifetime

describe("A0-1 — OffDuty $500 (the production incident class)", () => {
  it("is classified non-Dime", () => {
    expect(isKnownNonDimePrice(OFFDUTY_500)).toBe(true);
  });

  it("carries a reason for the ledger", () => {
    expect(nonDimeReason(OFFDUTY_500)).toBe("OffDuty client services invoice");
  });

  it("classification does not depend on a Stripe Customer existing", () => {
    // The whole point: plink_1Tu9KR is customer_creation=always, so the
    // !stripeCustomerId guard never fires. Customer presence must be irrelevant
    // to disposition — the classifier never sees a customer at all.
    expect(isKnownNonDimePrice(OFFDUTY_500)).toBe(true);
    expect(isKnownNonDimePrice.length).toBe(1); // priceId is the only input
  });
});

describe("A0-2/3/4 — WNBA project invoices", () => {
  it("$250 is non-Dime", () => {
    expect(isKnownNonDimePrice(WNBA_250)).toBe(true);
    expect(nonDimeReason(WNBA_250)).toBe("WNBA project invoice");
  });

  it("$125 is non-Dime", () => {
    expect(isKnownNonDimePrice(WNBA_125)).toBe(true);
  });

  it("both WNBA prices are distinct entries, not one name-matched rule", () => {
    // Two DIFFERENT live Products are both named "WNBA Project". Name matching
    // would have collapsed them; exact IDs keep them separate and explicit.
    expect(WNBA_250).not.toBe(WNBA_125);
    expect(knownNonDimePriceIds()).toContain(WNBA_250);
    expect(knownNonDimePriceIds()).toContain(WNBA_125);
  });
});

describe("A0-5 — donation (custom_unit_amount)", () => {
  it("is non-Dime regardless of the amount the donor chooses", () => {
    // This price has unit_amount=null and custom_unit_amount preset $50, so the
    // charged amount varies per donation. Amount could never have identified it.
    expect(isKnownNonDimePrice(DONATION)).toBe(true);
    expect(nonDimeReason(DONATION)).toBe("platform donation");
  });
});

describe("A0-6 — Dime fallback prices must NOT be blocked", () => {
  // These five are owner-confirmed Dime-intended one-time fallback sales paths.
  // PR A0 deliberately leaves their behaviour unchanged: their exact canonical
  // entitlement is gated on the production plan_prices read, and blocking them
  // here would strand legitimate Dime buyers.
  it.each(DIME_FALLBACK)("%s is not classified non-Dime", priceId => {
    expect(isKnownNonDimePrice(priceId)).toBe(false);
    expect(nonDimeReason(priceId)).toBeNull();
  });

  it("the catalog-provenance Dime lifetime price is not blocked either", () => {
    expect(isKnownNonDimePrice(DIME_CATALOG_LIFETIME)).toBe(false);
  });
});

describe("A0-7 — unknown prices are not silently called non-Dime", () => {
  it("an unrecognised price is not classified", () => {
    expect(isKnownNonDimePrice("price_synthetic_unknown_live")).toBe(false);
  });

  it("absent / empty price identity is never a classification", () => {
    // "we could not read the price" must not become "this is non-Dime".
    expect(isKnownNonDimePrice(null)).toBe(false);
    expect(isKnownNonDimePrice(undefined)).toBe(false);
    expect(isKnownNonDimePrice("")).toBe(false);
    expect(nonDimeReason(null)).toBeNull();
  });
});

describe("classification keys on exact Price ID only", () => {
  it("registry holds exactly the four owner-confirmed prices", () => {
    expect(knownNonDimePriceIds().sort()).toEqual(
      [OFFDUTY_500, WNBA_250, WNBA_125, DONATION].sort()
    );
  });

  it("same-amount collision: $124.99 Dime vs $124.99 non-Dime stay distinct", () => {
    // Live account fact: multiple distinct $124.99 one-time prices exist, and
    // they are not all the same offer. Amount is not identity.
    expect(isKnownNonDimePrice(DIME_CATALOG_LIFETIME)).toBe(false);
    expect(isKnownNonDimePrice("price_1TzHDsPa3TFEAkkYSxf13aZu")).toBe(false);
  });

  it("a near-miss Price ID does not match", () => {
    expect(isKnownNonDimePrice(OFFDUTY_500 + "x")).toBe(false);
    expect(isKnownNonDimePrice(OFFDUTY_500.slice(0, -1))).toBe(false);
  });
});

describe("webhook wiring — source contract", () => {
  it("the non-Dime check exists in checkout.session.completed", () => {
    expect(WEBHOOK_SRC).toContain("isKnownNonDimePrice(nonDimePriceId)");
  });

  it("it breaks out before any Dime grant", () => {
    const idx = WEBHOOK_SRC.indexOf("isKnownNonDimePrice(nonDimePriceId)");
    expect(idx).toBeGreaterThan(-1);
    const after = WEBHOOK_SRC.slice(idx, idx + 1400);
    expect(after).toContain("break;");
    // the guarded block must not itself grant
    const guarded = after.slice(0, after.indexOf("break;"));
    expect(guarded).not.toContain("grantUserAccess");
    expect(guarded).not.toContain("createPendingUserFromCheckout");
  });

  it("runs BEFORE plan/expiry resolution, which defaults to monthly", () => {
    const check = WEBHOOK_SRC.indexOf("isKnownNonDimePrice(nonDimePriceId)");
    const planResolution = WEBHOOK_SRC.indexOf(
      "const resolved = await resolvePlanExpiry(session.metadata?.plan_id)"
    );
    expect(check).toBeGreaterThan(-1);
    expect(planResolution).toBeGreaterThan(-1);
    expect(check).toBeLessThan(planResolution);
  });

  it("records the payment rather than dropping it", () => {
    const idx = WEBHOOK_SRC.indexOf("isKnownNonDimePrice(nonDimePriceId)");
    const block = WEBHOOK_SRC.slice(idx, idx + 1400);
    expect(block).toContain("resolveCheckout");
    expect(block).toContain('fulfillment: "skipped"');
    expect(block).toContain("non-Dime transaction");
  });

  it("a line-item read failure does not fabricate a classification", () => {
    // resolveSessionPriceId returns null on error; isKnownNonDimePrice(null)
    // is false, so the handler keeps its existing behaviour instead of
    // inventing "non-Dime" from a transient Stripe outage.
    expect(WEBHOOK_SRC).toContain(
      "could not read line items for non-Dime classification"
    );
    expect(isKnownNonDimePrice(null)).toBe(false);
  });
});
