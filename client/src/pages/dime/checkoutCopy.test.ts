/**
 * client/src/pages/dime/checkoutCopy.test.ts
 *
 * Session 3 / PR B — checkout disclosure cadence integrity.
 *
 * The defect these tests lock down: `chargeCadence` was typed
 * `"monthly" | "annually"` and built as
 *   `d.interval === "year" ? "annually" : "monthly"`,
 * so a daily or weekly price rendered "Charged today, then monthly until you
 * cancel." directly under the pay button — while `renewal` on the same screen
 * correctly said weekly. Displayed cadence and legal cadence disagreed about
 * the same transaction.
 *
 * Every assertion below reads from ONE selected price row, because that row is
 * the same one whose Stripe Price ID is sent to Checkout.
 */

import { describe, it, expect } from "vitest";
import {
  buildDbCopy,
  buildLegalLine,
  cadencePhrase,
  LOADING_COPY,
  type DbCheckoutPlan,
} from "./checkoutCopy";

/** A DB price row as `stripe.publicGetCheckoutPlan` returns it. */
function priceRow(over: Partial<DbCheckoutPlan> = {}): DbCheckoutPlan {
  return {
    slug: "dime-max",
    name: "Dime Max",
    description: null,
    amountCents: 19999,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    recurring: true,
    trialPeriodDays: null,
    label: null,
    soldOut: false,
    ...over,
  };
}

/** The full sentence a buyer reads immediately above/below the pay button. */
function legalFor(over: Partial<DbCheckoutPlan> = {}): string {
  return buildLegalLine(buildDbCopy(priceRow(over)));
}

describe("cadencePhrase — the single cadence authority", () => {
  it("names each singular interval", () => {
    expect(cadencePhrase("day", 1)).toBe("daily");
    expect(cadencePhrase("week", 1)).toBe("weekly");
    expect(cadencePhrase("month", 1)).toBe("monthly");
    expect(cadencePhrase("year", 1)).toBe("annually");
  });

  it("keeps the count for multi-interval prices", () => {
    expect(cadencePhrase("day", 2)).toBe("every 2 days");
    expect(cadencePhrase("week", 2)).toBe("every 2 weeks");
    expect(cadencePhrase("month", 3)).toBe("every 3 months");
    expect(cadencePhrase("year", 2)).toBe("every 2 years");
  });

  it("treats a null/0/1 count as singular", () => {
    expect(cadencePhrase("week", null)).toBe("weekly");
    expect(cadencePhrase("week", 0)).toBe("weekly");
    expect(cadencePhrase("week", 1)).toBe("weekly");
  });

  it("never renders a null interval into the sentence", () => {
    // recurring implies interval != null upstream; a malformed row must still
    // not print "every 1 null" to a paying customer.
    expect(cadencePhrase(null, 1)).toBe("monthly");
    // count > 1 is the path that actually reaches the template literal, where
    // a missing `unit` fallback would interpolate the word "null".
    expect(cadencePhrase(null, 2)).toBe("every 2 months");
  });
});

describe("D1 — daily price", () => {
  it("discloses daily, never monthly", () => {
    const legal = legalFor({ interval: "day", amountCents: 1999 });
    expect(legal).toContain("then daily until you cancel");
    expect(legal).not.toContain("monthly");
    expect(legal).not.toContain("annually");
  });

  it("uses the same cadence in the renewal sentence", () => {
    const copy = buildDbCopy(priceRow({ interval: "day", amountCents: 1999 }));
    expect(copy.renewal).toContain("Auto-renews daily");
    expect(copy.chargeCadence).toBe("daily");
  });
});

describe("D2 — weekly price (the reported defect)", () => {
  it("discloses weekly, never monthly", () => {
    // Dime Max's real weekly row: plan_prices 120017 / $74.99 / week.
    const legal = legalFor({ interval: "week", amountCents: 7499 });
    expect(legal).toContain("then weekly until you cancel");
    expect(legal).not.toContain("monthly");
  });

  it("renewal and legal line agree", () => {
    const copy = buildDbCopy(priceRow({ interval: "week", amountCents: 7499 }));
    expect(copy.renewal).toContain("Auto-renews weekly at $74.99");
    expect(buildLegalLine(copy)).toContain("then weekly");
  });
});

describe("D3 — monthly price", () => {
  it("discloses monthly", () => {
    const legal = legalFor({ interval: "month", amountCents: 19999 });
    expect(legal).toContain("then monthly until you cancel");
    expect(legal).not.toContain("weekly");
  });
});

describe("D4 — annual price", () => {
  it("discloses annually", () => {
    const legal = legalFor({ interval: "year", amountCents: 99999 });
    expect(legal).toContain("then annually until you cancel");
    expect(legal).not.toContain("monthly");
  });
});

describe("D5 — one-time price", () => {
  it("carries no renewal language at all", () => {
    const legal = legalFor({
      interval: null,
      intervalCount: null,
      recurring: false,
    });
    expect(legal).toContain("Charged once today");
    expect(legal).toContain("no renewals");
    expect(legal).not.toContain("until you cancel");
    expect(legal).not.toContain("monthly");
    expect(legal).not.toContain("weekly");
  });

  it("does not promise a renewal in the renewal field either", () => {
    const copy = buildDbCopy(
      priceRow({ interval: null, intervalCount: null, recurring: false })
    );
    expect(copy.recurring).toBe(false);
    expect(copy.renewal).not.toContain("Auto-renews");
    // A one-time price carries no cadence at all — pinning this stops the
    // "monthly" placeholder from creeping back onto a lifetime purchase.
    expect(copy.chargeCadence).toBe("");
  });
});

describe("D6 — every 2 weeks", () => {
  it("keeps the count in both sentences", () => {
    const copy = buildDbCopy(
      priceRow({ interval: "week", intervalCount: 2, amountCents: 2999 })
    );
    expect(copy.chargeCadence).toBe("every 2 weeks");
    expect(copy.renewal).toContain("Auto-renews every 2 weeks");
    expect(buildLegalLine(copy)).toContain(
      "then every 2 weeks until you cancel"
    );
  });

  it("is never flattened to plain weekly", () => {
    const legal = legalFor({ interval: "week", intervalCount: 2 });
    expect(legal).not.toContain("then weekly");
  });
});

describe("D7 — every 3 months", () => {
  it("keeps the count and is never flattened to monthly", () => {
    const legal = legalFor({
      interval: "month",
      intervalCount: 3,
      amountCents: 49999,
    });
    expect(legal).toContain("then every 3 months until you cancel");
    expect(legal).not.toContain("then monthly");
  });
});

describe("display / execution parity", () => {
  // The point of the defect: copy must be a pure function of the ONE price row
  // the caller selected — never a second, independently resolved price.
  it("derives amount, period and cadence from the same row", () => {
    const row = priceRow({
      interval: "week",
      intervalCount: 1,
      amountCents: 7499,
    });
    const copy = buildDbCopy(row);

    expect(copy.price).toBe("$74.99");
    expect(copy.period).toBe("/ week");
    expect(copy.chargeCadence).toBe("weekly");
    expect(copy.renewal).toContain("$74.99");
    expect(copy.payLabel).toContain("$74.99");
    // one row in → one consistent transaction description out
    expect(buildLegalLine(copy)).toContain("weekly");
  });

  it("is deterministic — same row always yields identical copy", () => {
    const row = priceRow({ interval: "day", amountCents: 499 });
    expect(buildDbCopy(row)).toEqual(buildDbCopy(row));
  });

  it("changing only the interval changes only the cadence wording", () => {
    const weekly = buildDbCopy(
      priceRow({ interval: "week", amountCents: 7499 })
    );
    const monthly = buildDbCopy(
      priceRow({ interval: "month", amountCents: 7499 })
    );
    expect(weekly.price).toBe(monthly.price);
    expect(weekly.chargeCadence).not.toBe(monthly.chargeCadence);
  });
});

describe("legacy static plan copy is unaffected", () => {
  // Legacy plans supply their own curated cadence strings; widening the type
  // from the "monthly" | "annually" union must leave them byte-identical.
  it("renders a legacy monthly cadence unchanged", () => {
    const legal = buildLegalLine({
      name: "Pro",
      heading: "Activate Pro",
      price: "$99",
      period: "/month",
      payLabel: "Start Pro — $99/mo",
      renewal: "Auto-renews monthly at $99 until cancelled.",
      chargeCadence: "monthly",
    });
    expect(legal).toBe(
      "Charged today, then monthly until you cancel. Secure processing by Stripe — card details never touch our servers."
    );
  });

  it("renders a legacy annual cadence unchanged", () => {
    const legal = buildLegalLine({
      name: "Elite",
      heading: "Activate Elite",
      price: "$499.99",
      period: "/ year",
      payLabel: "Start Elite — $499.99/yr",
      renewal: "Auto-renews annually at $499.99 until cancelled.",
      chargeCadence: "annually",
    });
    expect(legal).toBe(
      "Charged today, then annually until you cancel. Secure processing by Stripe — card details never touch our servers."
    );
  });
});

describe("loading state makes no cadence promise", () => {
  // Found by PR B's own adversarial self-review: `copy` falls back to
  // LOADING_COPY while publicGetCheckoutPlan is in flight and the legal line
  // renders unconditionally, so the old `chargeCadence: "monthly"` placeholder
  // told a weekly buyer "then monthly until you cancel" before any price had
  // been selected.
  // Pinned with toBe, not a list of absences. Independent review caught that
  // three `not.toContain` assertions all pass if LOADING_COPY.recurring flips
  // to false — which makes the pre-price line read "Charged once today —
  // lifetime access, no renewals.", an equally false promise in the other
  // direction. Only an exact-string assertion rules out every wrong sentence.
  it("says exactly the assurance and nothing else while no price is resolved", () => {
    expect(buildLegalLine(LOADING_COPY)).toBe(
      "Secure processing by Stripe — card details never touch our servers."
    );
  });

  it("still shows the Stripe assurance", () => {
    expect(buildLegalLine(LOADING_COPY)).toContain(
      "Secure processing by Stripe"
    );
  });

  it("resumes a full cadence sentence once a price arrives", () => {
    const legal = legalFor({ interval: "week", amountCents: 7499 });
    expect(legal).toContain("Charged today, then weekly until you cancel");
  });
});
