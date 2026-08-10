/**
 * server/stripe/nonDimePriceResolution.test.ts
 *
 * Session 3 / PR A0 — executable coverage for `resolveSessionPriceId`.
 *
 * Independent review found that the webhook-side half of PR A0 had NO
 * executable coverage (`processWebhookEvent` is not exported), and that a
 * plausible "drop the extra Stripe round-trip" refactor —
 *
 *     const nonDimePriceId = session.metadata?.price_id ?? null;
 *
 * — passes every source-contract assertion while fully reintroducing the
 * defect. Stripe Payment Links cannot carry `metadata.price_id`, so that edit
 * makes the id null for every Payment-Link session, `isKnownNonDimePrice(null)`
 * false, and the $500 OffDuty invoice grants monthly again. Silently.
 *
 * The line-item fallback is the ONLY mechanism by which the containment reaches
 * Payment Links, which is the only channel the production incident used. These
 * tests pin it directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

const listLineItems = vi.fn();

// The webhook module pulls the Stripe SDK and the DB layer in at import time.
// Neither is exercised here — stub them so the import stays side-effect free.
vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));
vi.mock("../db", () => ({ getDb: vi.fn(async () => null) }));
vi.mock("../dbCircuitBreaker", () => ({
  withCircuitBreaker: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("./client", () => ({
  getStripe: () => ({ checkout: { sessions: { listLineItems } } }),
}));

import { resolveSessionPriceId } from "../stripeWebhook";
import { isKnownNonDimePrice } from "./nonDimePrices";

const OFFDUTY_500 = "price_1Tu9IsPa3TFEAkkYSRU1iHLS";

function session(over: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_live_test",
    metadata: {},
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  listLineItems.mockReset();
});

describe("resolveSessionPriceId — the Payment-Link path", () => {
  it("falls back to the line item when metadata carries no price_id", async () => {
    // THE regression this file exists for. Every Payment Link lands here.
    listLineItems.mockResolvedValue({ data: [{ price: { id: OFFDUTY_500 } }] });

    const got = await resolveSessionPriceId(session({ metadata: {} }), "[t]");

    expect(got).toBe(OFFDUTY_500);
    expect(listLineItems).toHaveBeenCalledTimes(1);
    // …and that id is what makes the containment fire.
    expect(isKnownNonDimePrice(got)).toBe(true);
  });

  it("treats absent metadata (not just empty) the same way", async () => {
    listLineItems.mockResolvedValue({ data: [{ price: { id: OFFDUTY_500 } }] });
    const got = await resolveSessionPriceId(session({ metadata: null }), "[t]");
    expect(got).toBe(OFFDUTY_500);
  });

  it("prefers the pinned metadata price_id and skips the Stripe call", async () => {
    const got = await resolveSessionPriceId(
      session({ metadata: { price_id: "price_pinned_by_our_checkout" } }),
      "[t]"
    );
    expect(got).toBe("price_pinned_by_our_checkout");
    expect(listLineItems).not.toHaveBeenCalled();
  });

  it("trims a padded metadata price_id", async () => {
    const got = await resolveSessionPriceId(
      session({ metadata: { price_id: "  price_padded  " } }),
      "[t]"
    );
    expect(got).toBe("price_padded");
  });

  it("ignores a blank metadata price_id and still reads the line item", async () => {
    listLineItems.mockResolvedValue({ data: [{ price: { id: OFFDUTY_500 } }] });
    const got = await resolveSessionPriceId(
      session({ metadata: { price_id: "   " } }),
      "[t]"
    );
    expect(got).toBe(OFFDUTY_500);
  });
});

describe("resolveSessionPriceId — failure is never a classification", () => {
  it("returns null when Stripe throws, rather than inventing an id", async () => {
    listLineItems.mockRejectedValue(new Error("stripe is down"));
    const got = await resolveSessionPriceId(session(), "[t]");
    expect(got).toBeNull();
    // null must not read as "non-Dime" — the caller keeps existing behaviour.
    expect(isKnownNonDimePrice(got)).toBe(false);
  });

  it("returns null when the session has no line items", async () => {
    listLineItems.mockResolvedValue({ data: [] });
    expect(await resolveSessionPriceId(session(), "[t]")).toBeNull();
  });

  it("returns null when the line item carries no price", async () => {
    listLineItems.mockResolvedValue({ data: [{}] });
    expect(await resolveSessionPriceId(session(), "[t]")).toBeNull();
  });
});
