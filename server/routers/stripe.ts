/**
 * server/routers/stripe.ts
 *
 * tRPC router for Stripe payment operations.
 *
 * Procedures:
 *   stripe.createCheckoutSession       — creates a Stripe Checkout session (authenticated)
 *   stripe.publicCreateCheckoutSession — creates a Stripe Checkout session (unauthenticated)
 *   stripe.getSubscription             — returns the current user's subscription status
 *   stripe.createPortalSession         — creates a Stripe Customer Portal session
 *   stripe.getPlanStatus               — own-data plan state (active/cancel_scheduled/expired/none)
 *   stripe.getInvoices                 — own-data billing history (Stripe API, capped 24)
 *   stripe.getPaymentMethods           — own-data saved cards (Stripe API)
 *   stripe.getBillingInfo              — own-data name/email/address (Stripe customer)
 *
 * Flow:
 *   - Unauthenticated user clicks "Click Here" → publicCreateCheckoutSession is called
 *     → Stripe Checkout page collects email + "Desired Username" custom field + payment
 *   - Authenticated user clicks "Click Here" → createCheckoutSession is called
 *     → email prefilled from account, "Desired Username" prefilled from username
 *
 * Credentials are read from process.env — never hardcoded.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { router, stripeProcedure, isOriginAllowed, csrfOriginCheck } from "../_core/trpc";
import { maskEmail as maskEmailForLog } from "../_core/billingAlerts";
import { stripeAppUserProcedure } from "./appUsers";
import type Stripe from "stripe";
import { getStripe } from "../stripe/client";
import { recordCheckoutCreated } from "../stripe/checkoutLedger";
import { recordSubscriptionEvent, subscriptionPeriodEndMs } from "../stripe/subscriptionLedger";
import { PLANS, NEW_PLAN_IDS, getPlanByPriceId, computeExpiryMs, type PlanId } from "../stripe/products";
import { getPlanBySlug, defaultPriceForMode, isSoldOut, type StoredPlan, type StoredPrice } from "../stripe/planStore";
import { logSafe } from "../_core/logSafe";
import { derivePlanStatus } from "../stripe/planStatus";
import type { BillingInvoice, BillingPaymentMethod, BillingInfo } from "../stripe/billingTypes";
import { getDb, getAppUserById, invalidateAppUserByIdCache, updateAppUser } from "../db";
import { appUsers } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { syncDiscordRoleForUser } from "../discord/discordRoleSync";
import { getCachedAppUser, setCachedAppUser, invalidateCachedAppUser } from "../dbCircuitBreaker";
import { signAppUserToken, verifyAppUserToken, APP_USER_COOKIE } from "./appUsers";
import { getSessionCookieOptions } from "../_core/cookies";

const TAG = "[tRPC][stripe]";

/**
 * Validate the client-supplied checkout `origin` (AUTH-002).
 *
 * This value is interpolated straight into Stripe's success_url / cancel_url /
 * return_url. Unvalidated, anyone could mint a real checkout.stripe.com session
 * whose post-payment redirect points at a host they control — and Stripe would
 * hand them the paying victim's `{CHECKOUT_SESSION_ID}`, which is the bearer
 * credential the account-setup flow accepts (AUTH-001). Reusing the same
 * allowlist the CSRF middleware already applies keeps one source of truth.
 */
function assertAllowedOrigin(origin: string, procedure: string): string {
  if (!isOriginAllowed(origin)) {
    console.error(`${TAG}[${procedure}] [VERIFY] FAIL — rejected non-allowlisted origin="${origin}"`);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid request origin.",
    });
  }
  return origin;
}

/**
 * Stripe idempotency key (CHK-002). Stripe deduplicates create calls carrying
 * the same key for 24h, so a client retry or a network-level replay reuses the
 * original object instead of minting a second session/subscription mutation.
 */
function idempotencyKey(...parts: Array<string | number | null | undefined>): string {
  return parts.filter((p) => p != null && p !== "").join(":").slice(0, 255);
}

/**
 * Proof-of-payment gate for the post-checkout account-claim flow (AUTH-001).
 *
 * Both `getCheckoutSessionUser` and `completeAccountSetup` are unauthenticated
 * and keyed solely on a Stripe Checkout Session id. Without this check, that id
 * was a bearer credential: anyone holding one could read the buyer's identity
 * and then set an arbitrary email + password on the account they had just paid
 * for, receiving a 90-day session cookie. We now require the session to exist in
 * Stripe AND to be paid, so a guessed, stale, or fabricated id is worthless.
 *
 * Skipped under vitest only: the suite seeds pending rows directly and has no
 * Stripe credentials. `VITEST` is never set in the Railway runtime.
 */
async function assertCheckoutSessionPaid(sessionId: string, procedure: string): Promise<void> {
  if (process.env.VITEST) {
    console.log(`${TAG}[${procedure}] [STATE] VITEST — skipping Stripe session verification`);
    return;
  }
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err: unknown) {
    console.error(`${TAG}[${procedure}] [VERIFY] FAIL — session not retrievable from Stripe: ${err instanceof Error ? err.message : String(err)}`);
    throw new TRPCError({ code: "BAD_REQUEST", message: "This checkout link is not valid." });
  }
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    console.error(`${TAG}[${procedure}] [VERIFY] FAIL — payment_status=${session.payment_status}`);
    throw new TRPCError({ code: "BAD_REQUEST", message: "This checkout link is not valid." });
  }
}

/**
 * The setup claim expires (AUTH-001). A pending account used to stay claimable
 * forever; `pendingSetupExpiresAt` bounds it. NULL means a legacy row created
 * before this column existed — those fall back to the same TTL measured from
 * account creation where available, and are otherwise allowed through.
 */
function assertSetupClaimFresh(
  user: { pendingSetupExpiresAt?: number | null },
  procedure: string,
): void {
  const expiresAt = user.pendingSetupExpiresAt ?? null;
  if (expiresAt != null && Date.now() > expiresAt) {
    console.warn(`${TAG}[${procedure}] [VERIFY] FAIL — setup claim expired at ${new Date(expiresAt).toISOString()}`);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This setup link has expired. Please contact support to finish setting up your account.",
    });
  }
}

/**
 * Per-session attempt limiter for the unauthenticated claim endpoints. Bounded
 * map; entries expire with the claim TTL.
 */
const setupAttempts = new Map<string, { count: number; firstAt: number }>();
const SETUP_ATTEMPT_LIMIT = 10;
const SETUP_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
function assertSetupAttemptAllowed(sessionId: string, procedure: string): void {
  const now = Date.now();
  if (setupAttempts.size > 5000) {
    Array.from(setupAttempts.entries()).forEach(([k, v]) => {
      if (now - v.firstAt > SETUP_ATTEMPT_WINDOW_MS) setupAttempts.delete(k);
    });
  }
  const entry = setupAttempts.get(sessionId);
  if (!entry || now - entry.firstAt > SETUP_ATTEMPT_WINDOW_MS) {
    setupAttempts.set(sessionId, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
  if (entry.count > SETUP_ATTEMPT_LIMIT) {
    console.warn(`${TAG}[${procedure}] [VERIFY] FAIL — too many setup attempts for one session`);
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait and try again." });
  }
}

// ─── Input validation ─────────────────────────────────────────────────────────

// Accept any plan slug — legacy static plans + owner-created DB plans. Validity
// is enforced at resolution time (resolveCheckoutPlan throws for unknown slugs).
const zodPlanId = z.string().min(1).max(64);

// ─── Billing-tab auth (read-only, own-data-only) ──────────────────────────────

function getAppSessionToken(req: Request): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  return cookies[APP_USER_COOKIE];
}

/**
 * billingAppUserProcedure
 *
 * Authenticated app user WITHOUT the hasAccess/expiry gate that
 * stripeAppUserProcedure (server/routers/appUsers.ts) applies.
 *
 * That gate throws FORBIDDEN before a procedure body ever runs once
 * hasAccess=false or Date.now() > expiryDate — which is exactly the caller
 * this billing tab must keep serving: a lapsed subscriber who needs to see
 * state:"expired" (and their invoice/payment-method/billing-info history) so
 * they can renew, not a generic error page. Session validity (cookie + JWT +
 * tokenVersion) is still required; only the access-level check is skipped.
 *
 * Same DB-resilient cache fallback as the other app-user middlewares.
 */
const billingAppUserProcedure = stripeProcedure.use(csrfOriginCheck).use(async ({ ctx, next }) => {
  const TAGB = "[AppAuth][billingAppUserProcedure]";
  const token = getAppSessionToken(ctx.req);
  if (!token) {
    console.log(`${TAGB} REJECTED — no app_session cookie`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const payload = await verifyAppUserToken(token);
  if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });

  let user = await getAppUserById(payload.userId);
  const fromCache = !user;
  if (!user) {
    user = getCachedAppUser(payload.userId);
    if (user) {
      console.log(`${TAGB} DB unavailable — serving userId=${payload.userId} from cache`);
    }
  } else {
    setCachedAppUser(user);
  }
  if (!user) {
    console.log(`${TAGB} REJECTED — userId=${payload.userId} not found`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found" });
  }
  if (!fromCache && payload.tv !== null && payload.tv !== user.tokenVersion) {
    console.log(`${TAGB} REJECTED — tokenVersion mismatch userId=${user.id}`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session invalidated. Please log in again." });
  }
  // No hasAccess / expiryDate check by design — see doc comment above.
  return next({ ctx: { ...ctx, appUser: user } });
});

// ─── Auto-renewal disclosure copy (subscription_data.description) ─────────────

function subscriptionDescription(planId: PlanId): string {
  switch (planId) {
    case "annual":
      return "Dime AI — Annual Plan ($499.99/year). Auto-renews annually at $499.99 until cancelled. Cancel anytime before renewal.";
    case "monthly":
      return "Dime AI — Monthly Plan ($99.99/month). Auto-renews monthly at $99.99 until cancelled. Cancel anytime before renewal.";
    case "pro":
      return "Dime AI — Pro ($99/month). Auto-renews monthly at $99 until cancelled. Cancel anytime before renewal.";
    case "sharp":
      return "Dime AI — Sharp ($249/month). Auto-renews monthly at $249 until cancelled. Cancel anytime before renewal.";
    case "operator":
      return "Dime AI — Operator ($499/month). Auto-renews monthly at $499 until cancelled. Cancel anytime before renewal.";
  }
}

/**
 * Map a priceId() resolution failure to a clean TRPCError.
 * v2 plans (pro/sharp/operator) have env-only price IDs — when the env var is
 * missing the plan simply is not sellable yet: PRECONDITION_FAILED, not a 500.
 */
function priceResolutionError(planId: PlanId): TRPCError {
  if (NEW_PLAN_IDS.has(planId)) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "plan not yet available",
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Stripe price not configured. Contact support.",
  });
}

/** True when checkout (STRIPE_SECRET_KEY) runs against a LIVE Stripe account. */
function checkoutKeyIsLive(): boolean {
  return !(process.env.STRIPE_SECRET_KEY ?? "").includes("_test_");
}

/** Auto-renewal disclosure generated for a DB (owner-created) plan. */
function dbPlanDescription(plan: StoredPlan, price: StoredPrice): string {
  const amount = `$${(price.amountCents / 100).toFixed(2)}`;
  const per = price.interval
    ? price.intervalCount && price.intervalCount > 1
      ? `${price.intervalCount} ${price.interval}s`
      : price.interval
    : "one-time";
  return `${plan.name} — ${amount} / ${per}. Auto-renews until cancelled. Cancel anytime before renewal.`;
}

/**
 * The specific StoredPrice checkout should charge on a DB plan. When an explicit
 * priceId (a plan_prices row id, e.g. from a shared checkout link the owner copied
 * for one interval) is given, THAT interval is used — as long as it is active and
 * matches the checkout key's Stripe mode. A shared link deliberately targets one
 * interval, so if it can't be honored in the current mode we return null (→ error)
 * rather than silently charging a different price. With no priceId, the plan's
 * default price for the mode is used. Returns null when nothing matches.
 */
function resolveCheckoutPrice(
  plan: StoredPlan,
  priceId: number | undefined,
  wantLivemode: boolean,
): StoredPrice | null {
  if (priceId != null) {
    return (
      plan.prices.find((pr) => pr.id === priceId && pr.active && pr.livemode === wantLivemode) ?? null
    );
  }
  return defaultPriceForMode(plan, wantLivemode);
}

/**
 * Resolve a checkout plan slug (+ optional interval price id) → { priceId, description }.
 *  1) Legacy static plans (monthly/annual/pro/sharp/operator): the EXACT existing
 *     path — live env price IDs + hardcoded disclosure, byte-for-byte unchanged.
 *     These are single-price plans, so an explicit priceId is ignored.
 *  2) Owner-created DB plans: the requested interval (or the active default) MATCHING
 *     the checkout key's Stripe mode — live checkout must never be handed a test/
 *     sandbox price — plus a generated disclosure. The mode is derived PER-PRICE: a
 *     price with a cadence is a subscription; a no-interval ("Lifetime") price is a
 *     one-time payment, even inside an otherwise-recurring plan. Throws
 *     PRECONDITION_FAILED when the plan is unknown, inactive, sold out, or has no
 *     matching price in the current mode.
 */
type CheckoutMode = "subscription" | "payment";

async function resolveCheckoutPlan(
  slug: string,
  priceId?: number,
): Promise<{ priceId: string; description: string; couponId: string | null; mode: CheckoutMode; trialPeriodDays: number | null }> {
  if (Object.prototype.hasOwnProperty.call(PLANS, slug)) {
    const planId = slug as PlanId;
    let staticPriceId: string;
    try {
      staticPriceId = PLANS[planId].priceId();
    } catch {
      throw priceResolutionError(planId);
    }
    return { priceId: staticPriceId, description: subscriptionDescription(planId), couponId: null, mode: "subscription", trialPeriodDays: null };
  }
  const plan = await getPlanBySlug(slug);
  if (!plan || !plan.active) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "plan not available" });
  }
  // Limited-quantity FOMO: a plan with no spots left cannot be purchased.
  if (isSoldOut(plan)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "this plan is sold out" });
  }
  const price = resolveCheckoutPrice(plan, priceId, checkoutKeyIsLive());
  if (!price) {
    console.warn(`${TAG}[resolveCheckoutPlan] plan="${slug}" priceId=${priceId ?? "(default)"} has no matching active price in ${checkoutKeyIsLive() ? "live" : "test"} mode`);
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "plan not available" });
  }
  // Mode is per-price: a cadence → subscription; no interval (one-time / "Lifetime")
  // → a single payment.
  const mode: CheckoutMode = price.interval ? "subscription" : "payment";
  // A per-interval promo is applied as a Stripe coupon on the session.
  return {
    priceId: price.stripePriceId,
    description: dbPlanDescription(plan, price),
    couponId: price.stripeCouponId,
    mode,
    // Trials only exist on recurring prices; a one_time "day pass" is a paid
    // pass, and a FREE day pass is a trial on a recurring price.
    trialPeriodDays: mode === "subscription" ? (price.trialPeriodDays ?? null) : null,
  };
}

/**
 * Subscription-only checkout params, shared by both builders (hosted +
 * embedded) so the auto-renewal LAW cannot drift between them:
 *
 *   NO-GRACE POLICY (owner directive, 2026-08-01). Trials — including free
 *   day passes — ALWAYS auto-renew: the card is collected up front
 *   (`payment_method_collection: "always"`, replacing "if_required", which
 *   let a trial start with no card and nothing to charge at conversion), and
 *   a trial that somehow reaches its end without a payment method CANCELS at
 *   trial expiry (`trial_settings.end_behavior.missing_payment_method`)
 *   rather than pausing or invoicing into thin air. A declined conversion or
 *   renewal is handled by the webhook: access is revoked and the subscription
 *   canceled at the moment of failure — see invoice.payment_failed.
 *
 * `trial_period_days` is driven by the plan_prices row, making the DB the
 * authority on which SKU carries a trial — previously the column existed but
 * nothing applied it at checkout.
 */
function subscriptionCheckoutParams(
  mode: CheckoutMode,
  description: string,
  planId: string,
  userId: number | null | undefined,
  trialPeriodDays: number | null,
): Stripe.Checkout.SessionCreateParams {
  if (mode !== "subscription") return {};
  return {
    payment_method_collection: "always",
    subscription_data: {
      description,
      metadata: { ...(userId != null ? { user_id: String(userId) } : {}), plan_id: planId },
      ...(trialPeriodDays && trialPeriodDays > 0
        ? {
            trial_period_days: trialPeriodDays,
            trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
          }
        : {}),
    },
  };
}

// ─── Shared checkout session builder ─────────────────────────────────────────
// Used by both authenticated and unauthenticated procedures to avoid duplication.

interface BuildSessionParams {
  planId: string;
  origin: string;
  /** Optional plan_prices row id — selects ONE interval of a multi-interval DB plan
   *  (from a shared checkout link). Omitted → the plan's default interval. */
  priceRowId?: number | null;
  /** Stripe Customer ID — pass if user already has one to unify billing history */
  stripeCustomerId?: string | null;
  /** Email to prefill on Stripe Checkout */
  prefillEmail?: string;
  /** Desired username — prefilled in the Stripe custom_fields text input */
  desiredUsername?: string;
  /** Internal user ID — stored in metadata for webhook fulfillment */
  userId?: number | null;
}

async function buildStripeCheckoutSession(params: BuildSessionParams) {
  const { planId, origin: rawOrigin, priceRowId, stripeCustomerId, prefillEmail, desiredUsername, userId } = params;
  const origin = assertAllowedOrigin(rawOrigin, "buildStripeCheckoutSession");

  console.log(`${TAG}[buildStripeCheckoutSession] [INPUT] planId=${planId} priceRowId=${priceRowId ?? "(default)"} origin=${origin} userId=${userId ?? "anon"} prefillEmail=${prefillEmail ? maskEmailForLog(prefillEmail) : "(none)"} desiredUsername=${desiredUsername ?? "(none)"} stripeCustomerId=${stripeCustomerId ?? "(none)"}`);

  // ── [STEP 1+2] Resolve price + auto-renewal disclosure ────────────────────
  // Legacy static plans use the exact existing env path; owner-created DB plans
  // resolve the requested interval's (or default) mode-matched price. Throws a
  // clean PRECONDITION_FAILED if the plan isn't sellable (unknown / inactive /
  // wrong Stripe mode).
  const { priceId: stripePriceId, description, couponId, mode, trialPeriodDays } = await resolveCheckoutPlan(planId, priceRowId ?? undefined);
  console.log(`${TAG}[buildStripeCheckoutSession] [STATE] planId=${planId} priceId=${stripePriceId} mode=${mode}${couponId ? ` coupon=${couponId}` : ""}${trialPeriodDays ? ` trialDays=${trialPeriodDays}` : ""}`);
  // A per-interval promo is auto-applied as a coupon. Stripe forbids combining
  // `discounts` with `allow_promotion_codes`, so choose one: the baked-in coupon
  // when the interval has a promo, else let the customer enter a code.
  const discountParam: Stripe.Checkout.SessionCreateParams = couponId
    ? { discounts: [{ coupon: couponId }] }
    : { allow_promotion_codes: true };
  // Subscription-only params — shared builder enforces the no-grace /
  // always-auto-renew law (card up front, trial cancels without one).
  const subscriptionOnly = subscriptionCheckoutParams(mode, description, planId, userId, trialPeriodDays);

  // ── [STEP 3] Build success and cancel URLs ─────────────────────────────────
  const successUrl = `${origin}/subscribe/success?session_id={CHECKOUT_SESSION_ID}&plan=${planId}`;
  const cancelUrl = `${origin}/#pricing`;
  console.log(`${TAG}[buildStripeCheckoutSession] [STATE] successUrl=${successUrl} cancelUrl=${cancelUrl}`);

  // ── [STEP 4] Resolve customer parameter ───────────────────────────────────
  // If the user has an existing Stripe Customer ID, reuse it so their payment
  // methods are pre-filled and billing history is unified.
  // Otherwise, pass customer_email so Stripe prefills the email field.
  let customerParam: { customer: string } | { customer_email: string } | Record<string, never> = {};

  if (stripeCustomerId) {
    console.log(`${TAG}[buildStripeCheckoutSession] [STATE] reusing existing stripeCustomerId=${stripeCustomerId}`);
    customerParam = { customer: stripeCustomerId };
  } else if (prefillEmail) {
    console.log(`${TAG}[buildStripeCheckoutSession] [STATE] prefilling customer_email=${maskEmailForLog(prefillEmail)}`);
    customerParam = { customer_email: prefillEmail };
  } else {
    console.log(`${TAG}[buildStripeCheckoutSession] [STATE] no email or customer — Stripe will collect email on checkout page`);
  }

  // ── [STEP 5] Create Stripe Checkout Session ────────────────────────────────
  const stripe = getStripe();

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      ...customerParam,
      // ── Metadata for webhook fulfillment ────────────────────────────────
      // These fields are available in checkout.session.completed webhook.
      // price_id pins the EXACT interval purchased so the webhook grants that
      // interval's entitlement window (critical for a "Lifetime" interval).
      client_reference_id: userId != null ? String(userId) : undefined,
      metadata: {
        ...(userId != null ? { user_id: String(userId) } : {}),
        plan_id: planId,
        price_id: stripePriceId,
        desired_username: desiredUsername ?? "",
      },
      // ── Custom fields — collected on Stripe Checkout page ───────────────
      // "Desired Username" is required and prefilled if already known.
      custom_fields: [
        {
          key: "desired_username",
          label: { type: "custom" as const, custom: "Desired Username" },
          type: "text" as const,
          text: {
            minimum_length: 3,
            maximum_length: 64,
            ...(desiredUsername ? { default_value: desiredUsername } : {}),
          },
          optional: false,
        },
      ],
      // Subscription-only params (payment_method_collection + subscription_data
      // with the auto-renewal disclosure) are folded in for recurring plans;
      // one_time plans use mode:"payment" and omit them.
      ...subscriptionOnly,
      ...discountParam,
      success_url: successUrl,
      cancel_url: cancelUrl,
      billing_address_collection: "auto",
      // ── ALWAYS create a Customer ────────────────────────────────────────
      // mode:"subscription" creates one implicitly; mode:"payment" does NOT.
      // Its default is customer_creation:"if_required", which for a plain card
      // payment creates nothing, so session.customer arrives NULL at the
      // webhook — which then cannot bind the payment to an account.
      //
      // This is not hypothetical: both live one-time payments taken through
      // this integration arrived with customer=null and granted nothing. The
      // buyers had to be provisioned by hand. Forcing customer creation makes
      // that failure mode structurally impossible for every future checkout.
      // Only valid in payment mode AND only when no `customer` is already
      // supplied — Stripe rejects the combination outright.
      ...(mode === "payment" && !stripeCustomerId ? { customer_creation: "always" as const } : {}),
    }, {
      // 1-minute bucket: collapses double-clicks and transport retries into one
      // session, while still letting the same buyer start a fresh checkout later.
      idempotencyKey: idempotencyKey("checkout", userId ?? "anon", planId, priceRowId ?? "default", Math.floor(Date.now() / 60_000)),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG}[buildStripeCheckoutSession] [VERIFY] FAIL — Stripe API error: ${msg}`);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create checkout session. Please try again.",
    });
  }

  // ── [STEP 6] Validate session ──────────────────────────────────────────────
  if (!session.url) {
    console.error(`${TAG}[buildStripeCheckoutSession] [VERIFY] FAIL — session.url is null session_id=${session.id}`);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Checkout session created but no URL returned.",
    });
  }

  // ── [STEP 7] Record the attempt BEFORE the buyer leaves ────────────────────
  // Awaited deliberately: the row must exist before Stripe can deliver
  // checkout.session.completed, otherwise the webhook's write-back races an
  // absent row. recordCheckoutCreated never throws, so a ledger outage cannot
  // stop a buyer from paying.
  await recordCheckoutCreated({
    stripeSessionId: session.id,
    livemode: session.livemode ?? true,
    mode,
    userId: userId ?? null,
    planId,
    planPriceId: priceRowId ?? null,
    stripePriceId,
    amountCents: session.amount_total ?? null,
    currency: session.currency ?? null,
    desiredUsername: desiredUsername ?? null,
    customerEmail: prefillEmail ?? null,
    stripeCustomerId: stripeCustomerId ?? null,
    origin: successUrl,
  });

  console.log(`${TAG}[buildStripeCheckoutSession] [OUTPUT] session_id=${session.id} url=${session.url.substring(0, 60)}...`);
  console.log(`${TAG}[buildStripeCheckoutSession] [VERIFY] PASS — checkout session created successfully`);

  return { sessionId: session.id, url: session.url };
}

// ─── Embedded checkout session builder ────────────────────────────────────────
// Same plan/price resolution as buildStripeCheckoutSession, but ui_mode:"elements"
// (Checkout Sessions consumed by stripe.initCheckoutElementsSdk + Payment Element)
// so the payment form mounts inside the Dime domain (/checkout) with full
// Appearance API theming. Stripe still controls all card inputs — no raw card
// data ever touches this server.
//
// Params forbidden in elements mode (stripe-node d.ts, R-package): custom_fields,
// custom_text, branding_settings, cancel_url, success_url, submit_type,
// redirect_on_completion — none are sent. The "Desired Username" field is now
// OUR form field on /checkout, attached via publicAttachCheckoutIdentity
// (sessions.update metadata) before confirm.

async function buildEmbeddedCheckoutSession(params: BuildSessionParams) {
  const { planId, origin: rawOrigin, priceRowId, stripeCustomerId, prefillEmail, desiredUsername, userId } = params;
  const origin = assertAllowedOrigin(rawOrigin, "buildEmbeddedCheckoutSession");

  console.log(`${TAG}[buildEmbeddedCheckoutSession] [INPUT] planId=${planId} priceRowId=${priceRowId ?? "(default)"} origin=${origin} userId=${userId ?? "anon"}`);

  const { priceId: stripePriceId, description, couponId, mode, trialPeriodDays } = await resolveCheckoutPlan(planId, priceRowId ?? undefined);
  console.log(`${TAG}[buildEmbeddedCheckoutSession] [STATE] planId=${planId} priceId=${stripePriceId} mode=${mode}${couponId ? ` coupon=${couponId}` : ""}${trialPeriodDays ? ` trialDays=${trialPeriodDays}` : ""}`);
  // See buildStripeCheckoutSession: baked-in coupon XOR customer-entered code.
  const discountParam: Stripe.Checkout.SessionCreateParams = couponId
    ? { discounts: [{ coupon: couponId }] }
    : { allow_promotion_codes: true };
  // Shared builder — same no-grace / always-auto-renew law as the hosted flow.
  const subscriptionOnly = subscriptionCheckoutParams(mode, description, planId, userId, trialPeriodDays);

  let customerParam: { customer: string } | { customer_email: string } | Record<string, never> = {};
  if (stripeCustomerId) customerParam = { customer: stripeCustomerId };
  else if (prefillEmail) customerParam = { customer_email: prefillEmail };

  const stripe = getStripe();
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      // "elements" = the custom ui_mode consumed by initCheckoutElementsSdk
      // (stripe-node v22 JSDoc: custom ≡ elements).
      ui_mode: "elements",
      mode,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      ...customerParam,
      client_reference_id: userId != null ? String(userId) : undefined,
      metadata: {
        ...(userId != null ? { user_id: String(userId) } : {}),
        plan_id: planId,
        price_id: stripePriceId,
        desired_username: desiredUsername ?? "",
      },
      ...subscriptionOnly,
      ...discountParam,
      // Elements mode uses return_url (required for redirect-based payment
      // methods); the session_id lands on the same success page as always.
      return_url: `${origin}/subscribe/success?session_id={CHECKOUT_SESSION_ID}&plan=${planId}`,
      billing_address_collection: "auto",
    }, {
      idempotencyKey: idempotencyKey("checkout-embedded", userId ?? "anon", planId, priceRowId ?? "default", Math.floor(Date.now() / 60_000)),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG}[buildEmbeddedCheckoutSession] [VERIFY] FAIL — Stripe API error: ${msg}`);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create checkout session. Please try again.",
    });
  }

  if (!session.client_secret) {
    console.error(`${TAG}[buildEmbeddedCheckoutSession] [VERIFY] FAIL — no client_secret session_id=${session.id}`);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Checkout session created but no client secret returned.",
    });
  }

  // Same ledger contract as the redirect flow — the embedded surface is the
  // one anonymous buyers actually use, so leaving it unrecorded would keep the
  // exact population that got dropped invisible.
  await recordCheckoutCreated({
    stripeSessionId: session.id,
    livemode: session.livemode ?? true,
    mode,
    userId: userId ?? null,
    planId,
    planPriceId: priceRowId ?? null,
    stripePriceId,
    amountCents: session.amount_total ?? null,
    currency: session.currency ?? null,
    customerEmail: prefillEmail ?? null,
    origin: "embedded",
  });

  console.log(`${TAG}[buildEmbeddedCheckoutSession] [OUTPUT] session_id=${session.id} — embedded client_secret issued`);
  return { sessionId: session.id, clientSecret: session.client_secret };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const stripeRouter = router({
  /**
   * publicGetConfig
   *
   * Runtime delivery of the Stripe PUBLISHABLE key (safe to expose — it is
   * designed for browsers). The /checkout page uses this when the key was not
   * baked in at build time (VITE_STRIPE_PUBLISHABLE_KEY), which is the case on
   * any host that builds the client without env vars (e.g. the Railway Docker
   * image). This is what guarantees Embedded Checkout ALWAYS renders on-domain
   * — there is deliberately no hosted-redirect fallback anymore.
   */
  publicGetConfig: stripeProcedure.query(() => {
    const rawKey =
      process.env.STRIPE_PUBLISHABLE_KEY?.trim() ||
      process.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ||
      "";
    // Fail closed: never ship anything that isn't a publishable key to
    // browsers (a secret key pasted into the wrong env var must not leak).
    const publishableKey = rawKey.startsWith("pk_") ? rawKey : "";
    if (rawKey && !publishableKey) {
      console.error(`${TAG}[publicGetConfig] [VERIFY] FAIL — configured key does not start with pk_; refusing to serve it`);
    }
    console.log(
      `${TAG}[publicGetConfig] [OUTPUT] publishableKey=${publishableKey ? `${publishableKey.slice(0, 8)}… (${publishableKey.length} chars)` : "(unset)"}`
    );
    return { publishableKey };
  }),

  /**
   * publicCreateEmbeddedCheckoutSession
   *
   * Embedded (in-domain) variant of publicCreateCheckoutSession. Returns a
   * client_secret for a ui_mode:"elements" Checkout Session that the /checkout
   * page consumes with stripe.initCheckoutElementsSdk + a themed Payment
   * Element, keeping the URL on the Dime domain. Same rate limiter class as
   * the hosted variant (see server/_core/index.ts).
   */
  publicCreateEmbeddedCheckoutSession: stripeProcedure
    .input(
      z.object({
        planId: zodPlanId,
        /** Optional plan_prices row id — selects one interval of a multi-interval
         *  DB plan (from a shared checkout link). Omitted → the default interval. */
        priceId: z.number().int().positive().optional(),
        /** Frontend must pass window.location.origin for correct return URL */
        origin: z.string().url(),
      })
    )
    .mutation(async ({ input }) => {
      const { planId, priceId, origin } = input;
      console.log(`${TAG}[publicCreateEmbeddedCheckoutSession] [INPUT] planId=${planId} priceId=${priceId ?? "(default)"} origin=${origin} userId=anon`);
      return buildEmbeddedCheckoutSession({ planId, origin, priceRowId: priceId });
    }),

  /**
   * publicGetCheckoutPlan
   *
   * Public, display-only lookup for an owner-created DB plan (and, optionally, a
   * specific interval by plan_prices row id). Powers the /checkout summary rail
   * for DB plans and shared checkout links. Returns display-safe fields only — no
   * Stripe IDs — and null for legacy static plans (the page keeps its own hardcoded
   * copy for those) or any plan/interval that isn't sellable in the current mode.
   */
  publicGetCheckoutPlan: stripeProcedure
    .input(z.object({ slug: zodPlanId, priceId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const plan = await getPlanBySlug(input.slug);
      if (!plan || !plan.active) return null;
      const price = resolveCheckoutPrice(plan, input.priceId, checkoutKeyIsLive());
      if (!price) return null;
      return {
        slug: plan.slug,
        name: plan.name,
        description: plan.description,
        amountCents: price.amountCents,
        currency: price.currency,
        interval: price.interval,
        intervalCount: price.intervalCount,
        /** false → one-time / "Lifetime" (single payment); true → subscription. */
        recurring: price.interval != null,
        trialPeriodDays: price.trialPeriodDays,
        label: price.label,
        soldOut: isSoldOut(plan),
      };
    }),

  /**
   * publicAttachCheckoutIdentity
   *
   * Attaches the buyer's desired username to an open elements-mode Checkout
   * Session via sessions.update metadata (custom_fields are not allowed in
   * ui_mode:"elements"). Called by /checkout before actions.confirm(); the
   * webhook reads session.metadata.desired_username at fulfillment.
   */
  /**
   * publicListCheckoutPrices
   *
   * Display-only companion to publicGetCheckoutPlan: every sellable interval
   * for one plan, so the public pricing grid can show the true monthly figure
   * and deep-link to that exact price row. Without it the landing has to guess
   * — and a plan whose default price is weekly would advertise "billed
   * monthly" while opening a weekly checkout.
   *
   * Same safety envelope as publicGetCheckoutPlan: display fields only, never
   * Stripe IDs, and only prices active in the current key's mode.
   */
  publicListCheckoutPrices: stripeProcedure
    .input(z.object({ slug: zodPlanId }))
    .query(async ({ input }) => {
      const plan = await getPlanBySlug(input.slug);
      if (!plan || !plan.active) return null;
      const wantLivemode = checkoutKeyIsLive();
      const prices = plan.prices
        .filter((pr) => pr.active && pr.livemode === wantLivemode)
        .map((pr) => ({
          id: pr.id,
          amountCents: pr.amountCents,
          currency: pr.currency,
          interval: pr.interval,
          intervalCount: pr.intervalCount,
          label: pr.label,
        }));
      console.log(`[tRPC][stripe.publicListCheckoutPrices] PUBLIC slug=${plan.slug} prices=${prices.length}`);
      return { slug: plan.slug, name: plan.name, soldOut: isSoldOut(plan), prices };
    }),

  publicAttachCheckoutIdentity: stripeProcedure
    .input(
      z.object({
        sessionId: z.string().startsWith("cs_"),
        desiredUsername: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const TAG5 = `${TAG}[publicAttachCheckoutIdentity]`;
      const username = input.desiredUsername.trim();
      console.log(`${TAG5} [INPUT] sessionId=${input.sessionId} desiredUsername="${username}"`);

      // Server-side validation — aligned with the webhook sanitizer, which
      // strips spaces (so a spaced name accepted here would silently change).
      if (username.length < 3 || username.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
        console.warn(`${TAG5} [VERIFY] FAIL — username rejected by validation rule`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Username must be 3–64 characters and use only letters, numbers, underscores, dots or hyphens (no spaces).",
        });
      }

      const stripe = getStripe();
      try {
        await stripe.checkout.sessions.update(input.sessionId, {
          metadata: { desired_username: username },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG5} [VERIFY] FAIL — Stripe API error: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not attach your username to this checkout. Please try again.",
        });
      }

      console.log(`${TAG5} [OUTPUT] desired_username attached sessionId=${input.sessionId}`);
      console.log(`${TAG5} [VERIFY] PASS`);
      return { success: true as const };
    }),

  /**
   * publicCreateCheckoutSession
   *
   * Creates a Stripe Checkout session WITHOUT requiring authentication.
   * Used when an unauthenticated visitor clicks "Click Here" on the pricing section.
   *
   * Stripe Checkout collects:
   *   - Email (native Stripe field)
   *   - Desired Username (custom_fields text input)
   *   - Payment information (card / Apple Pay / Google Pay / Affirm / Klarna / etc.)
   *
   * No pre-checkout modal. No login redirect. Straight to Stripe.
   */
  publicCreateCheckoutSession: stripeProcedure
    .input(
      z.object({
        planId: zodPlanId,
        /** Frontend must pass window.location.origin for correct redirect URLs */
        origin: z.string().url(),
      })
    )
    .mutation(async ({ input }) => {
      const { planId, origin } = input;
      console.log(`${TAG}[publicCreateCheckoutSession] [INPUT] planId=${planId} origin=${origin} userId=anon`);
      return buildStripeCheckoutSession({ planId, origin });
    }),

  /**
   * createCheckoutSession
   *
   * Creates a Stripe Checkout session for an authenticated app user.
   * Email and username are prefilled from the user's account.
   *
   * Payment methods enabled:
   *   - Cards (Visa, MC, Amex, Discover)
   *   - Apple Pay / Google Pay (automatic via Checkout)
   *   - Affirm (US, min $50)
   *   - Afterpay / Clearpay
   *   - Klarna
   *   - Link (Stripe one-click checkout)
   *
   * Promo codes are enabled (allow_promotion_codes: true).
   */
  createCheckoutSession: stripeAppUserProcedure
    .input(
      z.object({
        planId: zodPlanId,
        /** Frontend must pass window.location.origin for correct redirect URLs */
        origin: z.string().url(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { planId, origin } = input;
      const user = ctx.appUser;

      console.log(`${TAG}[createCheckoutSession] [INPUT] userId=${user.id} email=${user.email ? maskEmailForLog(user.email) : "(none)"} planId=${planId} origin=${origin}`);

      // Duplicate-subscription guard: this procedure is only reachable by users
      // who already have access, so creating another subscription on the same
      // Stripe customer double-bills them (the webhook would then overwrite
      // stripeSubscriptionId, orphaning the old still-billing subscription).
      if (user.stripeSubscriptionId) {
        console.warn(`${TAG}[createCheckoutSession] [VERIFY] BLOCKED — userId=${user.id} already has subId=${user.stripeSubscriptionId}`);
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "You already have an active subscription. Manage or change your plan from your account settings instead.",
        });
      }

      return buildStripeCheckoutSession({
        planId,
        origin,
        stripeCustomerId: user.stripeCustomerId,
        prefillEmail: user.email ?? undefined,
        desiredUsername: user.username ?? undefined,
        userId: user.id,
      });
    }),

  /**
   * getSubscription
   *
   * Returns the current user's subscription status from the local DB.
   * Does NOT call the Stripe API — reads from app_users columns.
   */
  getSubscription: stripeAppUserProcedure.query(async ({ ctx }) => {
    const user = ctx.appUser;

    console.log(`${TAG}[getSubscription] [INPUT] userId=${user.id}`);

    const result = {
      hasAccess: user.hasAccess,
      expiryDate: user.expiryDate ?? null,
      stripeCustomerId: user.stripeCustomerId ?? null,
      stripeSubscriptionId: user.stripeSubscriptionId ?? null,
      stripePlanId: user.stripePlanId ?? null,
      isExpired: user.expiryDate ? Date.now() > user.expiryDate : false,
    };

    console.log(`${TAG}[getSubscription] [OUTPUT] hasAccess=${result.hasAccess} planId=${result.stripePlanId} expired=${result.isExpired}`);
    console.log(`${TAG}[getSubscription] [VERIFY] PASS`);

    return result;
  }),

  /**
   * createPortalSession
   *
   * Creates a Stripe Customer Portal session so the user can manage their
   * subscription (cancel, update payment method, view invoices).
   * Requires the user to have a stripeCustomerId.
   *
   * Bound to billingAppUserProcedure, not stripeAppUserProcedure (pre-merge
   * fix, owner directive 2026-07-22): stripeAppUserProcedure's hasAccess/
   * expiry gate threw FORBIDDEN before this body ever ran for a lapsed or
   * revoked subscriber — exactly the caller who most needs the portal, to
   * fix a card or pull an old invoice. Opening the Stripe-hosted portal is a
   * legitimate own-data operation for a lapsed customer (Stripe's own
   * intended model for the portal), so only the access-level gate is
   * dropped; session validity (cookie + JWT + tokenVersion) is unchanged.
   * reactivateSubscription stays on stripeAppUserProcedure — its own body's
   * cancel_scheduled-only guard already covers the one caller who can
   * reach it.
   */
  createPortalSession: billingAppUserProcedure
    .input(
      z.object({
        origin: z.string().url(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const user = ctx.appUser;

      console.log(`${TAG}[createPortalSession] [INPUT] userId=${user.id} origin=${input.origin}`);

      if (!user.stripeCustomerId) {
        console.error(`${TAG}[createPortalSession] [VERIFY] FAIL — user has no stripeCustomerId userId=${user.id}`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No billing account found. Please subscribe first.",
        });
      }

      const stripe = getStripe();
      // Same allowlist as checkout — the portal return_url is equally
      // attacker-directable if taken from the client unchecked (AUTH-002).
      const portalOrigin = assertAllowedOrigin(input.origin, "createPortalSession");
      const returnUrl = `${portalOrigin}/account`;

      let portalSession;
      try {
        portalSession = await stripe.billingPortal.sessions.create({
          customer: user.stripeCustomerId,
          return_url: returnUrl,
        }, {
          idempotencyKey: idempotencyKey("portal", user.id, Math.floor(Date.now() / 60_000)),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[createPortalSession] [VERIFY] FAIL — Stripe API error: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to open billing portal. Please try again.",
        });
      }

      console.log(`${TAG}[createPortalSession] [OUTPUT] portal_url=${portalSession.url.substring(0, 60)}...`);
      console.log(`${TAG}[createPortalSession] [VERIFY] PASS`);

      return { url: portalSession.url };
    }),

  /**
   * getCheckoutSessionUser
   * Looks up the pending user account created by a Stripe checkout session.
   * Called by SubscribeSuccess page after redirect from Stripe.
   */
  getCheckoutSessionUser: stripeProcedure
    .input(z.object({ sessionId: z.string().min(1).startsWith("cs_") }))
    .query(async ({ input }) => {
      console.log(`${TAG}[getCheckoutSessionUser] [INPUT] sessionId=${input.sessionId}`);
      assertSetupAttemptAllowed(input.sessionId, "getCheckoutSessionUser");
      await assertCheckoutSessionPaid(input.sessionId, "getCheckoutSessionUser");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const rows = await db.select({
        id: appUsers.id,
        username: appUsers.username,
        email: appUsers.email,
        pendingSetup: appUsers.pendingSetup,
        pendingEmail: appUsers.pendingEmail,
        pendingUsername: appUsers.pendingUsername,
        hasAccess: appUsers.hasAccess,
        stripePlanId: appUsers.stripePlanId,
        expiryDate: appUsers.expiryDate,
        pendingSetupExpiresAt: appUsers.pendingSetupExpiresAt,
      }).from(appUsers).where(eq(appUsers.pendingStripeSessionId, input.sessionId)).limit(1);

      if (!rows.length) {
        console.warn(`${TAG}[getCheckoutSessionUser] [STATE] No user found for sessionId=${input.sessionId}`);
        return null;
      }

      const user = rows[0];
      assertSetupClaimFresh(user, "getCheckoutSessionUser");
      console.log(`${TAG}[getCheckoutSessionUser] [OUTPUT] userId=${user.id} username=${user.username} pendingSetup=${user.pendingSetup}`);
      console.log(`${TAG}[getCheckoutSessionUser] [VERIFY] PASS`);
      return user;
    }),

  /**
   * completeAccountSetup
   * Sets the user's email and password, marks pendingSetup=false, grants Discord role.
   * Password requirements: min 8 chars, 1 uppercase, 1 lowercase, 1 special character.
   */
  completeAccountSetup: stripeProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      email: z.string().email("Please enter a valid email address"),
      password: z.string()
        .min(8, "Password must be at least 8 characters")
        .regex(/[A-Z]/, "Password must contain at least 1 uppercase letter")
        .regex(/[a-z]/, "Password must contain at least 1 lowercase letter")
        .regex(/[^A-Za-z0-9]/, "Password must contain at least 1 special character"),
    }))
    .mutation(async ({ input, ctx }) => {
      const TAG2 = `${TAG}[completeAccountSetup]`;
      console.log(`${TAG2} [INPUT] sessionId=${input.sessionId} email=${maskEmailForLog(input.email)}`);
      // Unauthenticated + account-provisioning: gate on attempt rate, then on
      // proof that this session was actually paid (AUTH-001).
      assertSetupAttemptAllowed(input.sessionId, "completeAccountSetup");
      await assertCheckoutSessionPaid(input.sessionId, "completeAccountSetup");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // [STEP 1] Find the pending user
      const rows = await db.select().from(appUsers)
        .where(eq(appUsers.pendingStripeSessionId, input.sessionId)).limit(1);
      if (!rows.length) {
        console.error(`${TAG2} [VERIFY] FAIL — no user found for sessionId=${input.sessionId}`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Account not found. Please contact support." });
      }
      const user = rows[0];
      assertSetupClaimFresh(user, "completeAccountSetup");
      console.log(`${TAG2} [STATE] Found userId=${user.id} username=${user.username} pendingSetup=${user.pendingSetup}`);

      if (!user.pendingSetup) {
        console.log(`${TAG2} [STATE] Account already set up — returning success`);
        return { success: true, username: user.username, alreadySetup: true };
      }

      // [STEP 2] Check email uniqueness (excluding this user)
      const emailConflict = await db.select({ id: appUsers.id }).from(appUsers)
        .where(eq(appUsers.email, input.email)).limit(1);
      if (emailConflict.length > 0 && emailConflict[0].id !== user.id) {
        console.error(`${TAG2} [VERIFY] FAIL — email already in use: ${maskEmailForLog(input.email)}`);
        throw new TRPCError({ code: "CONFLICT", message: "That email address is already in use. Please use a different email." });
      }

      // [STEP 3] Hash password
      console.log(`${TAG2} [STEP] Hashing password cost=10`);
      const passwordHash = await bcrypt.hash(input.password, 10);
      console.log(`${TAG2} [STATE] Password hash OK`);

      // [STEP 4] Update account: set email, password, clear pendingSetup
      await db.update(appUsers).set({
        email: input.email,
        passwordHash,
        pendingSetup: false,
        pendingEmail: null,
        pendingStripeSessionId: null,
      }).where(eq(appUsers.id, user.id));

      invalidateAppUserByIdCache(user.id);
      invalidateCachedAppUser(user.id);
      console.log(`${TAG2} [OUTPUT] Account setup complete userId=${user.id} email=${maskEmailForLog(input.email)}`);

      // [STEP 5] Grant Discord role now that setup is complete
      if (user.hasAccess) {
        console.log(`${TAG2} [STEP] Granting Discord role userId=${user.id}`);
        const updatedUser = { ...user, pendingSetup: false, email: input.email };
        const discordResult = await syncDiscordRoleForUser(updatedUser, true);
        console.log(`${TAG2} [STATE] Discord role grant: action=${discordResult.action} reason=${discordResult.reason}`);
      }

      // [STEP 6] Issue JWT session cookie — auto-logs the user in immediately
      // so "Enter the Platform" navigates directly to /feed without a re-login prompt.
      console.log(`${TAG2} [STEP] Issuing app_session JWT cookie userId=${user.id} role=${user.role} tv=${user.tokenVersion}`);
      const token = await signAppUserToken(user.id, user.role, user.tokenVersion);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(APP_USER_COOKIE, token, {
        ...cookieOptions,
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days — same as stayLoggedIn=true
      });
      console.log(`${TAG2} [STATE] app_session cookie set — user is now authenticated`);

      // [STEP 7] Send branded welcome email (non-blocking — failure does not abort setup)
      const planLabelMap: Record<string, string> = {
        monthly: 'Monthly Plan',
        annual: 'Annual Plan',
        pro: 'Pro Plan',
        sharp: 'Sharp Plan',
        operator: 'Operator Plan',
        lifetime: 'Lifetime Access',
        test: 'Monthly Plan',
      };
      const planLabel = planLabelMap[user.stripePlanId ?? ''] ?? 'Subscription';
      import('../email').then(({ sendWelcomeEmail }) => {
        sendWelcomeEmail({
          toEmail: input.email,
          username: user.username,
          planLabel,
          expiryDate: user.expiryDate ? new Date(user.expiryDate) : null,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`${TAG2} [STATE] Welcome email failed (non-critical): ${msg}`);
        });
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`${TAG2} [STATE] Welcome email import failed (non-critical): ${msg}`);
      });

      console.log(`${TAG2} [VERIFY] PASS`);
      return { success: true, username: user.username, alreadySetup: false };
    }),

  /**
   * cancelSubscription
   *
   * Cancels the user's Stripe subscription at period end.
   * The user retains access until expiryDate; hasAccess is NOT immediately revoked.
   * The webhook (customer.subscription.deleted) handles final revocation.
   */
  cancelSubscription: stripeAppUserProcedure.mutation(async ({ ctx }) => {
    const TAG3 = '[Stripe][cancelSubscription]';
    const user = ctx.appUser;
    console.log(`${TAG3} [INPUT] userId=${user.id} subId=${user.stripeSubscriptionId ?? 'none'}`);

    if (!user.stripeSubscriptionId) {
      console.warn(`${TAG3} [VERIFY] FAIL — no stripeSubscriptionId userId=${user.id}`);
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No active subscription found.',
      });
    }

    const stripe = getStripe();
    let sub;
    try {
      sub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAG3} [VERIFY] FAIL — Stripe API error: ${msg}`);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to cancel subscription. Please try again.',
      });
    }

    // Stripe SDK v17: billing_cycle_anchor replaces current_period_end on Subscription
    // Use cancel_at (set when cancel_at_period_end=true) or fall back to current_period_end
    const rawEnd = (sub as unknown as Record<string, number>).cancel_at
      ?? (sub as unknown as Record<string, number>).current_period_end
      ?? Math.floor(Date.now() / 1000 + 30 * 86400);
    const periodEnd = rawEnd * 1000; // convert to ms
    // [STEP] Persist cancel_at_period_end flag to DB so frontend can read it without a Stripe API call
    await updateAppUser(user.id, { cancelAtPeriodEnd: true });
    console.log(`${TAG3} [STATE] DB updated cancelAtPeriodEnd=true userId=${user.id}`);
    // Lifecycle ledger (avenue #4): the member's own request, recorded with
    // actor='user' and a synthetic app.* type. The webhook's mirror row
    // (customer.subscription.updated → cancel_scheduled) arrives separately;
    // having both proves the request round-tripped through Stripe.
    await recordSubscriptionEvent({
      stripeEventId: null,
      eventType: "app.cancel_requested",
      livemode: sub.livemode ?? true,
      stripeSubscriptionId: user.stripeSubscriptionId,
      stripeCustomerId: user.stripeCustomerId ?? null,
      userId: user.id,
      kind: "cancel_scheduled",
      outcome: "recorded",
      outcomeReason: "member scheduled cancellation — access retained until period end",
      fromPlanId: user.stripePlanId ?? null,
      status: sub.status ?? null,
      cancelAtPeriodEnd: true,
      periodEnd: subscriptionPeriodEndMs(sub) ?? periodEnd,
      actor: "user",
    });
    console.log(`${TAG3} [OUTPUT] cancel_at_period_end=true periodEnd=${new Date(periodEnd).toISOString()}`);
    console.log(`${TAG3} [VERIFY] PASS`);
    return { success: true, cancelAt: periodEnd };
  }),

  /**
   * reactivateSubscription
   *
   * Removes cancel_at_period_end from the Stripe subscription so it auto-renews.
   * Only valid when the subscription is still active (hasAccess=true, cancelAtPeriodEnd=true).
   */
  reactivateSubscription: stripeAppUserProcedure.mutation(async ({ ctx }) => {
    const TAG4 = '[Stripe][reactivateSubscription]';
    const user = ctx.appUser;
    console.log(`${TAG4} [INPUT] userId=${user.id} subId=${user.stripeSubscriptionId ?? 'none'} cancelAtPeriodEnd=${user.cancelAtPeriodEnd}`);

    if (!user.stripeSubscriptionId) {
      console.warn(`${TAG4} [VERIFY] FAIL — no stripeSubscriptionId userId=${user.id}`);
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No active subscription found.',
      });
    }

    if (!user.hasAccess) {
      console.warn(`${TAG4} [VERIFY] FAIL — subscription fully expired userId=${user.id}`);
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Subscription has fully expired. Please subscribe again.',
      });
    }

    const stripe = getStripe();
    let reactivatedSub: Stripe.Subscription;
    try {
      reactivatedSub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
      console.log(`${TAG4} [STATE] Stripe cancel_at_period_end=false subId=${user.stripeSubscriptionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAG4} [VERIFY] FAIL — Stripe API error: ${msg}`);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to reactivate subscription. Please try again.',
      });
    }

    // [STEP] Clear cancelAtPeriodEnd flag in DB
    await updateAppUser(user.id, { cancelAtPeriodEnd: false });
    console.log(`${TAG4} [STATE] DB updated cancelAtPeriodEnd=false userId=${user.id}`);
    // Lifecycle ledger (avenue #4): the reversal, actor='user'.
    await recordSubscriptionEvent({
      stripeEventId: null,
      eventType: "app.cancel_reverted",
      livemode: reactivatedSub.livemode ?? true,
      stripeSubscriptionId: user.stripeSubscriptionId,
      stripeCustomerId: user.stripeCustomerId ?? null,
      userId: user.id,
      kind: "cancel_reverted",
      outcome: "recorded",
      outcomeReason: "member reverted scheduled cancellation — subscription auto-renews again",
      fromPlanId: user.stripePlanId ?? null,
      status: reactivatedSub.status ?? null,
      cancelAtPeriodEnd: false,
      periodEnd: subscriptionPeriodEndMs(reactivatedSub),
      actor: "user",
    });
    console.log(`${TAG4} [OUTPUT] subscription reactivated userId=${user.id}`);
    console.log(`${TAG4} [VERIFY] PASS`);
    return { success: true };
  }),

  // ─── Read-only billing data layer (Round-3 Step 3) ──────────────────────────
  // Own-data-only: every procedure below reads exclusively from ctx.appUser —
  // no foreign user id is ever accepted as input. All four resolve to a
  // graceful empty/none shape (never an error) when the caller has no
  // stripeCustomerId. Built on billingAppUserProcedure (not
  // stripeAppUserProcedure) so a lapsed subscriber can still load this tab —
  // see that middleware's doc comment above for why.

  /**
   * getPlanStatus
   *
   * Derives { state, planId, planLabel, governingDate } via the pure
   * derivePlanStatus() (server/stripe/planStatus.ts) — reads only the local
   * DB row already on ctx.appUser, no Stripe API call.
   */
  getPlanStatus: billingAppUserProcedure.query(async ({ ctx }) => {
    const TAGS = `${TAG}[getPlanStatus]`;
    const user = ctx.appUser;
    console.log(`${TAGS} [INPUT] userId=${user.id} stripeCustomerId=${user.stripeCustomerId ?? '(none)'} stripePlanId=${user.stripePlanId ?? '(none)'}`);

    // Owner-created DB plans carry their display name in the catalog, not in
    // the legacy PLANS const. Resolve it here — derivePlanStatus is I/O-free by
    // design — so a dime-sharp subscriber sees "Dime Sharp" and not the retired
    // legacy plan normalizePlanId used to coerce them onto. Legacy slugs skip
    // the lookup entirely and behave exactly as before. A failed lookup is not
    // fatal: the status still renders, falling back to the slug.
    let catalogLabel: string | null = null;
    const rawPlan = user.stripePlanId;
    if (rawPlan && !Object.prototype.hasOwnProperty.call(PLANS, rawPlan)) {
      try {
        catalogLabel = (await getPlanBySlug(rawPlan))?.name ?? null;
      } catch (err) {
        console.warn(`${TAGS} catalog label lookup failed for plan="${logSafe(rawPlan)}": ${(err as Error).message}`);
      }
    }
    const status = derivePlanStatus(user, Date.now(), catalogLabel);

    console.log(`${TAGS} [OUTPUT] userId=${user.id} state=${status.state} planId=${status.planId ?? '(none)'} planLabel=${status.planLabel ?? '(none)'} governingDate=${status.governingDate ?? '(none)'}`);
    console.log(`${TAGS} [VERIFY] PASS`);
    return status;
  }),

  /**
   * getInvoices
   *
   * Own-data-only invoice history from the Stripe API, newest first, capped
   * at 24. Empty array (not an error) when the user has no stripeCustomerId.
   */
  getInvoices: billingAppUserProcedure.query(async ({ ctx }) => {
    const TAGI = `${TAG}[getInvoices]`;
    const user = ctx.appUser;
    console.log(`${TAGI} [INPUT] userId=${user.id} stripeCustomerId=${user.stripeCustomerId ?? '(none)'}`);

    if (!user.stripeCustomerId) {
      console.log(`${TAGI} [OUTPUT] userId=${user.id} no stripeCustomerId — returning empty list`);
      return [] as BillingInvoice[];
    }

    const stripe = getStripe();
    let invoices;
    try {
      invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        limit: 24,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAGI} [VERIFY] FAIL — Stripe API error: ${msg}`);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load billing history. Please try again.',
      });
    }

    const result: BillingInvoice[] = invoices.data.map((inv) => ({
      date: inv.created * 1000,
      amountCents: inv.amount_paid || inv.amount_due || 0,
      currency: inv.currency,
      status: inv.status ?? 'unknown',
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    }));

    console.log(`${TAGI} [OUTPUT] userId=${user.id} count=${result.length}`);
    console.log(`${TAGI} [VERIFY] PASS`);
    return result;
  }),

  /**
   * getPaymentMethods
   *
   * Own-data-only saved-card list from the Stripe API. Empty array (not an
   * error) when the user has no stripeCustomerId. isDefault is resolved
   * against the customer's invoice_settings.default_payment_method.
   */
  getPaymentMethods: billingAppUserProcedure.query(async ({ ctx }) => {
    const TAGP = `${TAG}[getPaymentMethods]`;
    const user = ctx.appUser;
    console.log(`${TAGP} [INPUT] userId=${user.id} stripeCustomerId=${user.stripeCustomerId ?? '(none)'}`);

    if (!user.stripeCustomerId) {
      console.log(`${TAGP} [OUTPUT] userId=${user.id} no stripeCustomerId — returning empty list`);
      return [] as BillingPaymentMethod[];
    }

    const stripe = getStripe();
    let defaultPaymentMethodId: string | null = null;
    let methods;
    try {
      const [customer, pmList] = await Promise.all([
        stripe.customers.retrieve(user.stripeCustomerId),
        stripe.paymentMethods.list({ customer: user.stripeCustomerId, type: 'card' }),
      ]);
      methods = pmList;
      if (!customer.deleted) {
        const defaultPm = customer.invoice_settings?.default_payment_method;
        defaultPaymentMethodId = typeof defaultPm === 'string' ? defaultPm : defaultPm?.id ?? null;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAGP} [VERIFY] FAIL — Stripe API error: ${msg}`);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load payment methods. Please try again.',
      });
    }

    const result: BillingPaymentMethod[] = methods.data
      .filter((pm): pm is typeof pm & { card: NonNullable<typeof pm.card> } => !!pm.card)
      .map((pm) => ({
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        isDefault: pm.id === defaultPaymentMethodId,
      }));

    console.log(`${TAGP} [OUTPUT] userId=${user.id} count=${result.length}`);
    console.log(`${TAGP} [VERIFY] PASS`);
    return result;
  }),

  /**
   * getBillingInfo
   *
   * Own-data-only name/email/address pulled from the Stripe customer record.
   * Empty shape (not an error) when the user has no stripeCustomerId or the
   * Stripe customer was deleted.
   */
  getBillingInfo: billingAppUserProcedure.query(async ({ ctx }) => {
    const TAGB2 = `${TAG}[getBillingInfo]`;
    const user = ctx.appUser;
    console.log(`${TAGB2} [INPUT] userId=${user.id} stripeCustomerId=${user.stripeCustomerId ?? '(none)'}`);

    const empty: BillingInfo = { name: null, email: null, address: null };

    if (!user.stripeCustomerId) {
      console.log(`${TAGB2} [OUTPUT] userId=${user.id} no stripeCustomerId — returning empty shape`);
      return empty;
    }

    const stripe = getStripe();
    let customer;
    try {
      customer = await stripe.customers.retrieve(user.stripeCustomerId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAGB2} [VERIFY] FAIL — Stripe API error: ${msg}`);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load billing information. Please try again.',
      });
    }

    if (customer.deleted) {
      console.warn(`${TAGB2} [STATE] customer deleted in Stripe userId=${user.id}`);
      return empty;
    }

    const result: BillingInfo = {
      name: customer.name ?? null,
      email: customer.email ?? null,
      address: customer.address ?? null,
    };

    console.log(`${TAGB2} [OUTPUT] userId=${user.id} hasAddress=${!!result.address}`);
    console.log(`${TAGB2} [VERIFY] PASS`);
    return result;
  }),
});
