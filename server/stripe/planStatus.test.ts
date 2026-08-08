/**
 * planStatus.test.ts
 *
 * Locks in the derivation matrix for derivePlanStatus (server/stripe/planStatus.ts).
 * Pure function — no DB, no Stripe API, no tRPC context — runs green with zero
 * environment/secrets configuration.
 */

import { describe, expect, it } from "vitest";
import { derivePlanStatus, type PlanStatusUser } from "./planStatus";
import { PLANS } from "./products";

const NOW = 1_700_000_000_000; // fixed reference instant

function user(overrides: Partial<PlanStatusUser> = {}): PlanStatusUser {
  return {
    stripeCustomerId: "cus_test123",
    stripePlanId: "pro",
    expiryDate: NOW + 30 * 24 * 60 * 60 * 1000, // 30 days from NOW
    cancelAtPeriodEnd: false,
    hasAccess: true,
    ...overrides,
  };
}

describe("derivePlanStatus", () => {
  it("returns active for a paid plan set to auto-renew", () => {
    const result = derivePlanStatus(user(), NOW);
    expect(result).toEqual({
      state: "active",
      planId: "pro",
      planLabel: PLANS.pro.name,
      governingDate: NOW + 30 * 24 * 60 * 60 * 1000,
    });
  });

  it("returns cancel_scheduled when cancelAtPeriodEnd is true but access has not lapsed", () => {
    const expiry = NOW + 15 * 24 * 60 * 60 * 1000;
    const result = derivePlanStatus(
      user({ cancelAtPeriodEnd: true, expiryDate: expiry }),
      NOW
    );
    expect(result).toEqual({
      state: "cancel_scheduled",
      planId: "pro",
      planLabel: PLANS.pro.name,
      governingDate: expiry,
    });
  });

  it("returns expired once now is strictly past the expiry date", () => {
    const expiry = NOW - 1; // one ms in the past
    const result = derivePlanStatus(user({ expiryDate: expiry }), NOW);
    expect(result).toEqual({
      state: "expired",
      planId: "pro",
      planLabel: PLANS.pro.name,
      governingDate: expiry,
    });
  });

  it("returns expired even when cancelAtPeriodEnd is still true (expiry check wins)", () => {
    const expiry = NOW - 24 * 60 * 60 * 1000; // one day in the past
    const result = derivePlanStatus(
      user({ cancelAtPeriodEnd: true, expiryDate: expiry }),
      NOW
    );
    expect(result.state).toBe("expired");
    expect(result.governingDate).toBe(expiry);
  });

  it("returns none when the user has never had a Stripe customer", () => {
    const result = derivePlanStatus(
      user({ stripeCustomerId: null, stripePlanId: null, expiryDate: null }),
      NOW
    );
    expect(result).toEqual({
      state: "none",
      planId: null,
      planLabel: null,
      governingDate: null,
    });
  });

  it("returns none when stripePlanId is missing even if a customer id exists", () => {
    const result = derivePlanStatus(user({ stripePlanId: null }), NOW);
    expect(result).toEqual({
      state: "none",
      planId: null,
      planLabel: null,
      governingDate: null,
    });
  });

  it("returns none when stripeCustomerId is missing even if a stale planId lingers", () => {
    const result = derivePlanStatus(user({ stripeCustomerId: null }), NOW);
    expect(result).toEqual({
      state: "none",
      planId: null,
      planLabel: null,
      governingDate: null,
    });
  });

  it("edge: expiry exactly equal to now is NOT expired (strict > boundary)", () => {
    const result = derivePlanStatus(user({ expiryDate: NOW }), NOW);
    expect(result.state).toBe("active");
    expect(result.governingDate).toBe(NOW);
  });

  it("edge: expiry exactly equal to now with cancelAtPeriodEnd is cancel_scheduled, not expired", () => {
    const result = derivePlanStatus(
      user({ expiryDate: NOW, cancelAtPeriodEnd: true }),
      NOW
    );
    expect(result.state).toBe("cancel_scheduled");
    expect(result.governingDate).toBe(NOW);
  });

  it("treats a NULL expiryDate (lifetime access) as active with a null governingDate", () => {
    const result = derivePlanStatus(user({ expiryDate: null }), NOW);
    expect(result).toEqual({
      state: "active",
      planId: "pro",
      planLabel: PLANS.pro.name,
      governingDate: null,
    });
  });

  // Was: "normalizes an unrecognized legacy stripePlanId instead of throwing",
  // asserting planId === "monthly". The intent — do not throw, still render —
  // is preserved; the assertion is not. Coercing an unknown slug to "monthly"
  // told a subscriber they were on a retired $99.99 plan they had never bought,
  // and it read as correct because the label came from a real plan. Reporting
  // the slug is honest and debuggable; reporting a different plan is not.
  it("reports an unrecognized stripePlanId as itself, without throwing and without coercing", () => {
    const result = derivePlanStatus(
      user({ stripePlanId: "legacy-plan-xyz" }),
      NOW
    );
    expect(result.state).toBe("active");
    expect(result.planId).toBe("legacy-plan-xyz");
    expect(result.planLabel).toBe("legacy-plan-xyz");
    expect(result.planLabel).not.toBe(PLANS.monthly.name);
  });

  describe("owner-created DB catalog plans", () => {
    // The live defect this fixes: all 95 subscribers hold stripePlanId
    // "dime-sharp" (admin counts subscribers by that column against the plan
    // slug), and normalizePlanId coerced it to "monthly", so every paying
    // customer's billing tab read "AI Sports Betting — Monthly".
    it("labels a DB plan with its catalog name, not a legacy plan's", () => {
      const result = derivePlanStatus(
        user({ stripePlanId: "dime-sharp" }),
        NOW,
        "Dime Sharp"
      );
      expect(result.planId).toBe("dime-sharp");
      expect(result.planLabel).toBe("Dime Sharp");
      expect(result.planLabel).not.toBe(PLANS.monthly.name);
    });

    it("falls back to the slug when no catalog label is supplied", () => {
      const result = derivePlanStatus(user({ stripePlanId: "dime-max" }), NOW);
      expect(result.planId).toBe("dime-max");
      expect(result.planLabel).toBe("dime-max");
    });

    it("ignores catalogLabel for legacy plans — their name comes from PLANS", () => {
      const result = derivePlanStatus(
        user({ stripePlanId: "pro" }),
        NOW,
        "Some Other Name"
      );
      expect(result.planId).toBe("pro");
      expect(result.planLabel).toBe(PLANS.pro.name);
    });

    it("carries the real slug through every non-none state", () => {
      const base = { stripePlanId: "dime-sharp" };
      expect(
        derivePlanStatus(
          user({ ...base, expiryDate: NOW - 1 }),
          NOW,
          "Dime Sharp"
        )
      ).toMatchObject({
        state: "expired",
        planId: "dime-sharp",
        planLabel: "Dime Sharp",
      });
      expect(
        derivePlanStatus(user({ ...base, hasAccess: false }), NOW, "Dime Sharp")
      ).toMatchObject({
        state: "expired",
        planId: "dime-sharp",
        planLabel: "Dime Sharp",
      });
      expect(
        derivePlanStatus(
          user({ ...base, cancelAtPeriodEnd: true }),
          NOW,
          "Dime Sharp"
        )
      ).toMatchObject({
        state: "cancel_scheduled",
        planId: "dime-sharp",
        planLabel: "Dime Sharp",
      });
    });
  });

  it("defaults `now` to Date.now() when not supplied", () => {
    const soon = Date.now() + 60_000;
    const result = derivePlanStatus(user({ expiryDate: soon }));
    expect(result.state).toBe("active");
  });

  it("returns expired when hasAccess is revoked even with a future expiry and live planId (would otherwise be active)", () => {
    const expiry = NOW + 30 * 24 * 60 * 60 * 1000;
    const result = derivePlanStatus(
      user({ hasAccess: false, expiryDate: expiry }),
      NOW
    );
    expect(result).toEqual({
      state: "expired",
      planId: "pro",
      planLabel: PLANS.pro.name,
      governingDate: expiry,
    });
  });

  it("returns expired when hasAccess is revoked even with cancelAtPeriodEnd + future expiry (would otherwise be cancel_scheduled)", () => {
    const expiry = NOW + 15 * 24 * 60 * 60 * 1000;
    const result = derivePlanStatus(
      user({ hasAccess: false, cancelAtPeriodEnd: true, expiryDate: expiry }),
      NOW
    );
    expect(result).toEqual({
      state: "expired",
      planId: "pro",
      planLabel: PLANS.pro.name,
      governingDate: expiry,
    });
  });
});
