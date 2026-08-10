/**
 * server/stripe/recurringAuthority.test.ts
 *
 * Session 3 / PR A — recurring entitlement authority.
 *
 * Two defects are pinned here, and they are independent:
 *
 *   R-1  the plan/interval came from `metadata.plan_id` -> the plan's DEFAULT
 *        price, so a non-default interval was silently re-dated as the default
 *        and a cross-plan Portal switch kept the old plan;
 *   R-2  the expiry came from `Date.now() + interval` rather than the period
 *        Stripe actually billed, so even a monthly member drifted on every
 *        mid-cycle update.
 *
 * R-2 is why "are any subscribers on a non-default interval?" is not a
 * sufficient blast-radius question — a plan whose interval matches the default
 * is still wrong on the anchor.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  resolveRecurringEntitlement,
  isLifetimeEntitlement,
  type MappedRecurringPrice,
} from "./recurringAuthority";
import { LIFETIME_ACCESS_UNTIL_MS } from "./planStore";

const NOW = 1_786_300_000_000; // fixed clock — no Date.now() in assertions
const DAY = 24 * 60 * 60 * 1000;

/** Live catalog rows, from the production read on 2026-08-10. */
const SHARP_MONTH: MappedRecurringPrice = {
  planSlug: "dime-sharp",
  planPriceRowId: 120003,
  interval: "month",
  intervalCount: 1,
  source: "catalog",
};
const SHARP_YEAR: MappedRecurringPrice = {
  planSlug: "dime-sharp",
  planPriceRowId: 120004,
  interval: "year",
  intervalCount: 1,
  source: "catalog",
};
const MAX_MONTH: MappedRecurringPrice = {
  planSlug: "dime-max",
  planPriceRowId: 120018,
  interval: "month",
  intervalCount: 1,
  source: "catalog",
};
const MAX_YEAR: MappedRecurringPrice = {
  planSlug: "dime-max",
  planPriceRowId: 120019,
  interval: "year",
  intervalCount: 1,
  source: "catalog",
};
const MAX_DAY: MappedRecurringPrice = {
  planSlug: "dime-max",
  planPriceRowId: 120016,
  interval: "day",
  intervalCount: 1,
  source: "catalog",
};
const MAX_WEEK: MappedRecurringPrice = {
  planSlug: "dime-max",
  planPriceRowId: 120017,
  interval: "week",
  intervalCount: 1,
  source: "catalog",
};
const PRO_MONTH: MappedRecurringPrice = {
  planSlug: "dime-pro",
  planPriceRowId: 120013,
  interval: "month",
  intervalCount: 1,
  source: "catalog",
};
const LEGACY_MONTHLY: MappedRecurringPrice = {
  planSlug: "monthly",
  planPriceRowId: null,
  interval: "month",
  intervalCount: 1,
  source: "legacy_static",
};

/** An ordinary active subscriber: not lifetime, mid-cycle. */
const ACTIVE_EXPIRY = NOW + 12 * DAY;

function resolve(
  over: Partial<Parameters<typeof resolveRecurringEntitlement>[0]>
) {
  return resolveRecurringEntitlement({
    priceId: "price_live_sharp_month",
    mapped: SHARP_MONTH,
    stripePeriodEndMs: NOW + 30 * DAY,
    existingExpiryMs: ACTIVE_EXPIRY,
    nowMs: NOW,
    ...over,
  });
}

describe("R-1 — the current Price decides plan and interval", () => {
  it("a monthly subscriber resolves to the monthly row", () => {
    const r = resolve({});
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.planId).toBe("dime-sharp");
    expect(r.planPriceId).toBe(120003);
  });

  it("annual does NOT collapse to the plan's monthly default", () => {
    // The exact defect: dime-sharp's default row is $99.99/month, so the old
    // path re-dated a $499.99/year member as monthly.
    const r = resolve({
      priceId: "price_live_sharp_year",
      mapped: SHARP_YEAR,
      stripePeriodEndMs: NOW + 365 * DAY,
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.planPriceId).toBe(120004); // annual row, not 120003
    expect(r.expiryMs).toBe(NOW + 365 * DAY);
  });

  it("same-plan interval switch moves planPriceId (month → year)", () => {
    const r = resolve({ mapped: MAX_YEAR, stripePeriodEndMs: NOW + 365 * DAY });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.planId).toBe("dime-max");
    expect(r.planPriceId).toBe(120019);
  });

  it("cross-plan switch moves the plan (Pro → Sharp)", () => {
    // Both directions, so the assertion demonstrates that the PLAN follows the
    // Price rather than that one hard-coded answer happens to be right.
    const before = resolve({
      priceId: "price_live_pro_month",
      mapped: PRO_MONTH,
    });
    const after = resolve({
      priceId: "price_live_sharp_month",
      mapped: SHARP_MONTH,
    });
    expect(before.kind).toBe("apply");
    expect(after.kind).toBe("apply");
    if (before.kind !== "apply" || after.kind !== "apply") return;
    expect(before.planId).toBe("dime-pro");
    expect(before.planPriceId).toBe(120013);
    expect(after.planId).toBe("dime-sharp");
    expect(after.planPriceId).toBe(120003);
  });

  it("metadata is not an input at all — it cannot influence the outcome", () => {
    // The strongest form of "current Price wins": the resolver has no parameter
    // through which a stale plan slug could arrive.
    const params = Object.keys(
      resolve({}) as unknown as Record<string, unknown>
    );
    expect(params).not.toContain("metadata");
    expect(resolveRecurringEntitlement.length).toBe(1); // one options object
  });

  it.each([
    ["day", MAX_DAY, 120016],
    ["week", MAX_WEEK, 120017],
    ["month", MAX_MONTH, 120018],
    ["year", MAX_YEAR, 120019],
  ])("supports the %s interval", (_label, mapped, rowId) => {
    const r = resolve({ mapped: mapped as MappedRecurringPrice });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.planPriceId).toBe(rowId);
  });
});

describe("R-2 — Stripe's period decides the expiry", () => {
  it("uses Stripe's boundary, not now + interval, even for a monthly member", () => {
    // A monthly subscriber 12 days into a cycle: the period ends in 18 days,
    // NOT 30. The old path wrote now+30d and quietly extended the cycle.
    const periodEnd = NOW + 18 * DAY;
    const r = resolve({ stripePeriodEndMs: periodEnd });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.expiryMs).toBe(periodEnd);
    expect(r.expiryMs).not.toBe(NOW + 30 * DAY);
    expect(r.expirySource).toBe("stripe_period");
  });

  it("accepts a period EARLIER than the stored expiry — a real shortening", () => {
    // cancel_at, or a downgrade. Refusing to shorten would give away access.
    const earlier = NOW + 2 * DAY;
    const r = resolve({
      stripePeriodEndMs: earlier,
      existingExpiryMs: NOW + 300 * DAY,
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.expiryMs).toBe(earlier);
  });

  it("falls back to the EXACT price's interval when Stripe supplies no period", () => {
    const r = resolve({ mapped: SHARP_YEAR, stripePeriodEndMs: null });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    // 365 days from the price the member actually holds — never the plan default.
    expect(r.expiryMs).toBe(NOW + 365 * DAY);
    expect(r.expirySource).toBe("price_interval");
  });

  it("honours intervalCount > 1 in the fallback", () => {
    const r = resolve({
      mapped: { ...SHARP_MONTH, intervalCount: 3 },
      stripePeriodEndMs: null,
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.expiryMs).toBe(NOW + 90 * DAY);
  });

  it("treats a null/zero intervalCount as 1 rather than collapsing to now", () => {
    for (const bad of [null, 0]) {
      const r = resolve({
        mapped: { ...SHARP_MONTH, intervalCount: bad as number | null },
        stripePeriodEndMs: null,
      });
      expect(r.kind).toBe("apply");
      if (r.kind !== "apply") continue;
      expect(r.expiryMs).toBe(NOW + 30 * DAY);
    }
  });

  it("refuses to date an entitlement with neither a period nor an interval", () => {
    const r = resolve({
      mapped: { ...SHARP_MONTH, interval: null },
      stripePeriodEndMs: null,
    });
    expect(r.kind).toBe("manual_review");
  });
});

describe("unknown Price fails closed against MUTATION, not against access", () => {
  it("an unmapped Price writes nothing and does not revoke", () => {
    const r = resolve({ priceId: "price_live_never_seen", mapped: null });
    expect(r.kind).toBe("manual_review");
    if (r.kind !== "manual_review") return;
    expect(r.priceId).toBe("price_live_never_seen");
    // no plan, no planPriceId, no expiry anywhere in the result
    expect(Object.keys(r)).toEqual(["kind", "priceId", "reason"]);
  });

  it("a subscription with no line-item Price writes nothing", () => {
    const r = resolve({ priceId: null, mapped: null });
    expect(r.kind).toBe("manual_review");
  });

  it("never invents a plan from a stale slug when the Price is unknown", () => {
    const r = resolve({ priceId: "price_live_never_seen", mapped: null });
    expect(JSON.stringify(r)).not.toContain("dime-");
    expect(JSON.stringify(r)).not.toContain("monthly");
  });
});

describe("grandfathered lifetime members are never re-dated", () => {
  it("the far-future sentinel is lifetime", () => {
    expect(isLifetimeEntitlement(LIFETIME_ACCESS_UNTIL_MS)).toBe(true);
    expect(isLifetimeEntitlement(LIFETIME_ACCESS_UNTIL_MS + 1)).toBe(true);
  });

  it("NULL is lifetime too — the admin path stores it that way", () => {
    expect(isLifetimeEntitlement(null)).toBe(true);
    expect(isLifetimeEntitlement(undefined)).toBe(true);
  });

  it("an ordinary expiry is not lifetime", () => {
    expect(isLifetimeEntitlement(ACTIVE_EXPIRY)).toBe(false);
    expect(isLifetimeEntitlement(LIFETIME_ACCESS_UNTIL_MS - 1)).toBe(false);
  });

  it("a lifetime member's expiry is not replaced by a billing period", () => {
    // Without this, a VIP who later starts any subscription would have lifetime
    // access converted into a 30-day window.
    const r = resolve({ existingExpiryMs: LIFETIME_ACCESS_UNTIL_MS });
    expect(r.kind).toBe("preserve_lifetime");
  });

  it("lifetime is checked BEFORE the Price is mapped", () => {
    // Ordering matters: an unmapped Price on a lifetime member must still come
    // back as lifetime-preserved, never as an anomaly that invites a fix-up.
    const r = resolve({
      priceId: "price_live_never_seen",
      mapped: null,
      existingExpiryMs: null,
    });
    expect(r.kind).toBe("preserve_lifetime");
  });

  it("a lifetime member gets no plan or planPriceId assignment", () => {
    const r = resolve({ existingExpiryMs: LIFETIME_ACCESS_UNTIL_MS });
    expect(Object.keys(r)).toEqual(["kind", "priceId", "reason"]);
  });
});

describe("legacy static plans keep working", () => {
  it("resolves to the legacy slug", () => {
    const r = resolve({
      priceId: "price_1TaVc2Pa3TFEAkkYucDoFPcW",
      mapped: LEGACY_MONTHLY,
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.planId).toBe("monthly");
    expect(r.mapSource).toBe("legacy_static");
  });

  it("leaves planPriceId alone rather than nulling a correct value", () => {
    const r = resolve({
      priceId: "price_1TaVc2Pa3TFEAkkYucDoFPcW",
      mapped: LEGACY_MONTHLY,
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.planPriceId).toBeNull(); // caller omits the field entirely
  });

  it("still anchors a legacy member to Stripe's period", () => {
    const r = resolve({
      priceId: "price_1TaVc2Pa3TFEAkkYucDoFPcW",
      mapped: LEGACY_MONTHLY,
      stripePeriodEndMs: NOW + 9 * DAY,
    });
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.expiryMs).toBe(NOW + 9 * DAY);
  });
});

// ─── Handler wiring — source contract ───────────────────────────────────────
// The loop around this resolver needs Stripe, Express and TiDB to execute, so
// the wiring is pinned by source the way this repo already pins the webhook
// (see stripeWebhook.test.ts and nonDimePrices.test.ts).

const ROOT = path.resolve(__dirname, "../..");
const WEBHOOK_SRC = fs.readFileSync(
  path.join(ROOT, "server/stripeWebhook.ts"),
  "utf8"
);

/** The `customer.subscription.created|updated` case body, label to its `break`. */
function subscriptionBranch(): string {
  const start = WEBHOOK_SRC.indexOf('case "customer.subscription.created":');
  const end = WEBHOOK_SRC.indexOf(
    'case "customer.subscription.deleted":',
    start
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return WEBHOOK_SRC.slice(start, end);
}

/**
 * The same branch with whole-line comments removed.
 *
 * Negative assertions ("the old call is gone") must read CODE. Run against the
 * raw text they also match the comment that explains what was replaced — which
 * both fails on honest documentation and, worse, could be satisfied by deleting
 * a comment rather than by keeping the fix.
 */
function subscriptionBranchCode(): string {
  return subscriptionBranch()
    .split("\n")
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

describe("webhook wiring — the branch actually uses this resolver", () => {
  it("calls resolveRecurringEntitlement", () => {
    expect(subscriptionBranch()).toContain("resolveRecurringEntitlement({");
  });

  it("feeds it the CURRENT subscription item Price", () => {
    expect(subscriptionBranch()).toContain(
      "const currentPriceId = subNow.priceId"
    );
  });

  it("no longer resolves the plan from metadata.plan_id", () => {
    // THE regression this whole PR exists to prevent. Restoring the old line
    // must fail here even if every behavioural test above still passes.
    const code = subscriptionBranchCode();
    expect(code).not.toContain("resolvePlanExpiry(sub.metadata?.plan_id)");
    expect(code).not.toContain("defaultPriceOf");
    // and the stripper must not be vacuous — the branch still has real code
    expect(code).toContain("await grantUserAccess({");
  });

  it("anchors expiry to Stripe's period, not a wall clock", () => {
    const branch = subscriptionBranch();
    expect(branch).toContain("stripePeriodEndMs: subscriptionPeriodEndMs(sub)");
  });

  it("passes the member's existing expiry so lifetime can be detected", () => {
    expect(subscriptionBranch()).toContain(
      "existingExpiryMs: subUserBefore?.expiryDate"
    );
  });

  it("omits planPriceId entirely when the resolver returns null", () => {
    expect(subscriptionBranch()).toContain(
      "...(resolution.planPriceId != null ? { planPriceId: resolution.planPriceId } : {})"
    );
  });

  it("breaks before grantUserAccess on any non-apply outcome", () => {
    const branch = subscriptionBranch();
    const guard = branch.indexOf('if (resolution.kind !== "apply")');
    const grant = branch.indexOf("await grantUserAccess({", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(guard);
    const guarded = branch.slice(guard, branch.indexOf("break;", guard));
    expect(guarded).not.toContain("grantUserAccess");
  });

  it("consults the catalog first, then the legacy static map — no third table", () => {
    const branch = subscriptionBranch();
    expect(branch).toContain("await getPriceById(currentPriceId)");
    expect(branch).toContain("getPlanByPriceId(currentPriceId)");
  });
});

describe("invoice.paid renewal authority is preserved (WBHK-006)", () => {
  it("still anchors renewals to the invoice's billed period", () => {
    // A future cleanup that "unifies" expiry on Date.now() would reintroduce
    // the drift this repo already fixed once.
    //
    // Assert the ASSIGNMENT, not the surrounding vocabulary. Checking only for
    // the strings "periodEndSec" and "stripe_period_end_exact" would survive
    // swapping the ternary's true-branch for the local fallback — the log line
    // would keep claiming an exact Stripe period while writing a computed one.
    const renewal = WEBHOOK_SRC.slice(
      WEBHOOK_SRC.indexOf('case "invoice.paid":')
    );
    const flat = renewal.replace(/\s+/g, " ");
    expect(flat).toContain(
      "const renewExpiry = periodEndSec ? periodEndSec * 1000 : fallbackExpiry;"
    );
    expect(renewal).toContain("period?.end");
  });
});
