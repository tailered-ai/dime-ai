/**
 * server/stripe/checkoutReconcileSweep.test.ts
 *
 * Session 3 / PR A0 — executable coverage for the reconcile sweep loop.
 *
 * Independent review found that PR A0's containment writes a ledger state the
 * sweep had no case for: `status="completed"` + Stripe `payment_status="paid"`
 * + `fulfillment="skipped"`. `classifySession` maps every complete+paid session
 * to `dropped`, and the sweep's spare only protected `fulfilled` — so within 30
 * minutes the non-Dime row was rewritten to `dropped`, its commercial reason
 * destroyed, and reported as "MONEY TAKEN WITHOUT ACCESS". The designed
 * response to that alarm is a MANUAL entitlement grant, i.e. the false alarm
 * would have induced by hand exactly the Dime access the containment prevents.
 *
 * The loop had no executable coverage at all (the existing checkoutReconcile
 * tests are source-contract plus pure `classifySession` cases). These drive the
 * real loop against a stubbed Stripe and database so the fix is proven end to
 * end rather than asserted about.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const listSessions = vi.fn();
const resolveCheckout = vi.fn(async () => true);
let localRows: Array<{
  stripeSessionId: string;
  status: string;
  fulfillment: string;
}> = [];

vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));
vi.mock("./client", () => ({
  getStripe: () => ({ checkout: { sessions: { list: listSessions } } }),
}));
vi.mock("./checkoutLedger", () => ({
  resolveCheckout: (...a: unknown[]) => resolveCheckout(...(a as [])),
}));
vi.mock("../db", () => ({
  getDb: async () => ({
    select: () => ({ from: () => ({ where: async () => localRows }) }),
  }),
}));

import { reconcileCheckoutSessions } from "./checkoutReconcile";

/** A live Payment-Link session Stripe reports as complete + paid. */
function paidSession(id: string) {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    customer: "cus_test",
    created: Math.floor(Date.now() / 1000) - 3600,
  };
}

beforeEach(() => {
  listSessions.mockReset();
  resolveCheckout.mockClear();
  localRows = [];
  listSessions.mockResolvedValue({
    data: [paidSession("cs_live_nondime")],
    has_more: false,
  });
});

describe("sweep — the non-Dime containment row survives", () => {
  it("leaves a completed+skipped row alone and raises no alarm", async () => {
    // Exactly what PR A0 writes for an OffDuty / WNBA / donation payment.
    localRows = [
      {
        stripeSessionId: "cs_live_nondime",
        status: "completed",
        fulfillment: "skipped",
      },
    ];

    const out = await reconcileCheckoutSessions();

    expect(out.alreadyConsistent).toBe(1);
    expect(out.unfulfilled).toBe(0);
    expect(out.unfulfilledIds).toEqual([]);
    // and crucially: the row is not rewritten, so its commercial reason —
    // "non-Dime transaction — OffDuty client services invoice" — survives.
    expect(resolveCheckout).not.toHaveBeenCalled();
  });

  it("leaves a fulfilled row alone (pre-existing rule, unregressed)", async () => {
    localRows = [
      {
        stripeSessionId: "cs_live_nondime",
        status: "completed",
        fulfillment: "fulfilled",
      },
    ];
    const out = await reconcileCheckoutSessions();
    expect(out.alreadyConsistent).toBe(1);
    expect(resolveCheckout).not.toHaveBeenCalled();
  });
});

describe("sweep — genuine drop detection is untouched", () => {
  it("still flags a complete+paid session whose row is pending", async () => {
    localRows = [
      {
        stripeSessionId: "cs_live_nondime",
        status: "created",
        fulfillment: "pending",
      },
    ];

    const out = await reconcileCheckoutSessions();

    expect(out.unfulfilled).toBe(1);
    expect(out.unfulfilledIds).toEqual(["cs_live_nondime"]);
    expect(resolveCheckout).toHaveBeenCalledTimes(1);
  });

  it("still flags a complete+paid session with no local row at all", async () => {
    localRows = [];
    const out = await reconcileCheckoutSessions();
    // Sessions created after the ledger epoch with no row are the real
    // money-taken-without-access class the sweep exists for.
    expect(out.unfulfilled + out.backfilled).toBeGreaterThan(0);
    expect(resolveCheckout).toHaveBeenCalled();
  });

  it("does not spare an expired+skipped row — the exemption stays narrow", async () => {
    listSessions.mockResolvedValue({
      data: [
        {
          id: "cs_live_exp",
          status: "expired",
          payment_status: "unpaid",
          created: Math.floor(Date.now() / 1000) - 3600,
        },
      ],
      has_more: false,
    });
    localRows = [
      {
        stripeSessionId: "cs_live_exp",
        status: "created",
        fulfillment: "pending",
      },
    ];

    const out = await reconcileCheckoutSessions();
    expect(out.expiredResolved).toBe(1);
  });
});
