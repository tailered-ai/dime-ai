/**
 * server/stripe/paymentStatusGuard.test.ts
 *
 * Session 3 / PR A — closes finding J-3.
 *
 * `checkout.session.completed` opens with a guard that stops any session Stripe
 * has not actually collected on:
 *
 *     if (payment_status !== "paid" && payment_status !== "no_payment_required")
 *       -> record the session as skipped, and BREAK
 *
 * That `break` is the only thing standing between an uncollected session and
 * plan resolution, account creation and `grantUserAccess`. It had no test.
 * Deleting it produced **zero failures across all 73 stripe + webhook tests** —
 * measured, not assumed, during the Phase J mutation run.
 *
 * The guard predates PR A0 and is present in production; this is a missing-test
 * defect, not a live one. It is pinned here because the whole point of the
 * recurring closeout is that money and access are decided in an exact order,
 * and this guard is the first step of that order.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const WEBHOOK_SRC = fs.readFileSync(
  path.join(ROOT, "server/stripeWebhook.ts"),
  "utf8"
);

const GUARD =
  'if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {';

/** The completed-checkout case body, from its label to the next case label. */
function checkoutBranch(): string {
  const start = WEBHOOK_SRC.indexOf('case "checkout.session.completed":');
  expect(start).toBeGreaterThan(-1);
  const end = WEBHOOK_SRC.indexOf("\n    case ", start + 10);
  expect(end).toBeGreaterThan(start);
  return WEBHOOK_SRC.slice(start, end);
}

describe("J-3 — the payment-status guard stops uncollected sessions", () => {
  it("the guard exists and admits exactly two collected states", () => {
    expect(WEBHOOK_SRC).toContain(GUARD);
    // Anything else — unpaid, no_payment_required's absence, a future Stripe
    // state — is not money in hand and must not pass.
  });

  it("it BREAKS out of the case — this is the assertion J-3 was missing", () => {
    // Mutation: delete this `break;` and the handler falls through to plan
    // resolution, account creation and grantUserAccess for a session Stripe
    // never collected. Before this test, that mutation was silent.
    const idx = WEBHOOK_SRC.indexOf(GUARD);
    const after = WEBHOOK_SRC.slice(idx, idx + 700);
    const brk = after.indexOf("break;");
    expect(brk).toBeGreaterThan(-1);

    const guarded = after.slice(0, brk);
    expect(guarded).not.toContain("grantUserAccess");
    expect(guarded).not.toContain("createPendingUserFromCheckout");
    expect(guarded).not.toContain("resolvePlanExpiry");
  });

  it("records the session as skipped rather than dropping it silently", () => {
    const idx = WEBHOOK_SRC.indexOf(GUARD);
    const block = WEBHOOK_SRC.slice(idx, idx + 700);
    expect(block).toContain("resolveCheckout");
    expect(block).toContain('fulfillment: "skipped"');
    expect(block).toContain("payment_status=");
  });

  it("runs before EVERY entitlement decision in the branch", () => {
    // Order is the contract: nothing that can grant may be reachable above it.
    const branch = checkoutBranch();
    const guard = branch.indexOf(GUARD);
    expect(guard).toBeGreaterThan(-1);

    for (const later of [
      "isKnownNonDimePrice(nonDimePriceId)",
      "const resolved = await resolvePlanExpiry(session.metadata?.plan_id)",
      "grantUserAccess",
    ]) {
      const at = branch.indexOf(later);
      expect(
        at,
        `${later} must appear after the payment-status guard`
      ).toBeGreaterThan(guard);
    }
  });

  it("the branch really is the completed-checkout handler (control)", () => {
    // Guards the slice itself: if the case label moved, the ordering assertions
    // above would compare positions inside the wrong block and pass vacuously.
    const branch = checkoutBranch();
    expect(branch).toContain("grantUserAccess");
    expect(branch.length).toBeGreaterThan(1000);
  });
});
