/**
 * /checkout?plan=<slug>[&price=<id>] — in-domain, Dime-branded Stripe checkout.
 *
 * `plan` is either one of the five legacy ids (pro|sharp|operator|monthly|annual,
 * which keep their curated PLAN_COPY) or an owner-created DB plan slug, whose
 * display copy is fetched from stripe.publicGetCheckoutPlan. The optional `price`
 * selects one interval of a multi-interval DB plan (a plan_prices row id, from a
 * checkout link the owner copied for a specific interval — including "Lifetime",
 * which checks out as a one-time payment). The Stripe elements flow is identical
 * regardless of plan source.
 *
 * ONLY path: Checkout Sessions ui_mode:"elements" consumed by
 * stripe.initCheckoutElementsSdk + a Payment Element themed with the
 * Appearance API (design-system/dime-ai/MASTER.md tokens). The URL never
 * leaves the domain and Stripe controls all card inputs — no raw card data
 * ever touches our code. Redirecting to the Stripe-hosted checkout page is
 * FORBIDDEN (owner directive, 2026-07-10) — there is no hosted fallback.
 *
 * Publishable-key resolution: build-time VITE_STRIPE_PUBLISHABLE_KEY when
 * present, otherwise fetched at runtime from stripe.publicGetConfig — so the
 * form works on builds that had no env vars (Railway Docker image, or a build
 * with no env vars). If no key is available at all, the page shows an
 * explicit error with retry — never a redirect.
 *
 * Flow: session created on page-load (the un-awaited clientSecret promise is
 * handed straight to the SYNCHRONOUS initCheckoutElementsSdk) → Payment
 * Element mounts → loadActions() → on Pay: validate fields, attach desired
 * username to the session server-side (publicAttachCheckoutIdentity →
 * sessions.update metadata; custom_fields don't exist in elements mode),
 * actions.updateEmail(email), actions.confirm({ redirect: "if_required" }).
 * Card payments confirm IN-PAGE; success renders on-domain and routes into
 * the existing /subscribe/success fulfillment flow.
 *
 * States: loading skeleton → form | processing | success | session expired
 * (re-creates the session) | generic error (+retry).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import type {
  Appearance,
  CssFontSource,
  StripeCheckoutElementsSdk,
  StripeCheckoutLoadActionsSuccess,
  StripePaymentElement,
} from "@stripe/stripe-js";
import { trpc } from "@/lib/trpc";
import "./landing/landing-v2.css";
import { MintCheck, Wordmark } from "./landing/components/shared";
// Display/disclosure copy lives in a pure module so the cadence contract is
// unit-testable without mounting Stripe Elements — see checkoutCopy.test.ts.
import {
  buildDbCopy,
  buildLegalLine,
  LOADING_COPY,
  type PlanCopy,
} from "./checkoutCopy";

type PlanId = "pro" | "sharp" | "operator" | "monthly" | "annual";

const PLAN_COPY: Record<PlanId, PlanCopy> = {
  pro: {
    name: "Pro",
    heading: "Activate Pro",
    price: "$99",
    period: "/month",
    perDay: "≈ $3.30 / day",
    features: [
      "Full AI Model Projections board — every game, priced",
      "Dime Chat on any game the model prices",
      "Live edge grades, honest PASS signals",
    ],
    payLabel: "Start Pro — $99/mo",
    renewal:
      "Auto-renews monthly at $99 until cancelled. Cancel anytime before renewal — access runs through the period you've paid for.",
    chargeCadence: "monthly",
  },
  sharp: {
    name: "Sharp",
    heading: "Activate Sharp",
    price: "$249",
    period: "/month",
    perDay: "≈ $8.30 / day",
    features: ["Everything in Pro", "Priority access to new model markets"],
    payLabel: "Start Sharp — $249/mo",
    renewal:
      "Auto-renews monthly at $249 until cancelled. Cancel anytime before renewal — access runs through the period you've paid for.",
    chargeCadence: "monthly",
  },
  operator: {
    name: "Operator",
    heading: "Activate Operator",
    price: "$499",
    period: "/month",
    perDay: "≈ $16.63 / day",
    features: [
      "Everything in Sharp",
      "Early access to new markets and model releases",
    ],
    payLabel: "Start Operator — $499/mo",
    renewal:
      "Auto-renews monthly at $499 until cancelled. Cancel anytime before renewal — access runs through the period you've paid for.",
    chargeCadence: "monthly",
  },
  monthly: {
    name: "Pro — Monthly",
    heading: "Activate Pro — Monthly",
    price: "$99.99",
    period: "/ month",
    perDay: "≈ $3.30 / day",
    payLabel: "Start Pro — $99.99/mo",
    renewal:
      "Auto-renews monthly at $99.99 until cancelled. Cancel anytime before renewal.",
    chargeCadence: "monthly",
  },
  annual: {
    name: "Elite — Annual",
    heading: "Activate Elite — Annual",
    price: "$499.99",
    period: "/ year",
    perDay: "≈ $1.37 / day · save 58% vs monthly",
    payLabel: "Start Elite — $499.99/yr",
    renewal:
      "Auto-renews annually at $499.99 until cancelled. Cancel anytime before renewal.",
    chargeCadence: "annually",
  },
};

const PUBLISHABLE_KEY =
  (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) ?? "";

/** The five hardcoded legacy plans keep their curated PLAN_COPY. */
function isLegacyPlan(slug: string): slug is PlanId {
  return (
    slug === "pro" ||
    slug === "sharp" ||
    slug === "operator" ||
    slug === "monthly" ||
    slug === "annual"
  );
}

/**
 * The plan slug from ?plan= — a legacy id OR an owner-created DB plan slug. Only
 * safe slug characters are accepted; anything else falls back to "pro" — the
 * plan the whole site sells at $99 (audit D-CHECKOUT-99: the old "monthly"
 * fallback quoted the retired $99.99 plan to anyone who reached /checkout
 * without a query param). Links that explicitly name "monthly" still get it.
 */
function parsePlanSlug(search: string): string {
  const plan = new URLSearchParams(search).get("plan")?.trim();
  return plan && /^[a-z0-9-]{1,64}$/i.test(plan) ? plan : "pro";
}

/** The optional ?price= — a plan_prices row id selecting one interval of a DB plan. */
function parsePriceId(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("price");
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ─── Stripe Appearance API — Dime token mapping (design spec §B, verbatim) ────

const APPEARANCE: Appearance = {
  theme: "night",
  labels: "above",
  variables: {
    colorPrimary: "#45E0A8",
    colorBackground: "#000000",
    colorText: "#FFFFFF",
    colorTextSecondary: "#FFFFFF",
    colorTextPlaceholder: "#FFFFFF",
    colorDanger: "#FFFFFF", // grey-stamp error law — never red
    colorSuccess: "#45E0A8",
    iconColor: "#FFFFFF",
    accessibleColorOnColorPrimary: "#000000",
    fontFamily: "'Familjen Grotesk', 'Helvetica Neue', Arial, sans-serif",
    fontSizeBase: "15px",
    borderRadius: "10px",
    spacingUnit: "4px",
    // 2026-07-13 audit P0-8: focus was suppressed entirely (focusBoxShadow none),
    // leaving the card fields with zero visible focus while the rest of the page
    // gets the 3px mint ring. Match the app-wide focus treatment.
    focusBoxShadow: "0 0 0 3px #45E0A8",
    focusOutline: "none",
  },
  rules: {
    ".Input": {
      backgroundColor: "#000000",
      border: "1px solid #FFFFFF",
      color: "#FFFFFF",
      boxShadow: "none",
      padding: "11px 13px",
    },
    ".Input:focus": {
      boxShadow: "0 0 0 3px #45E0A8",
      outline: "none",
      borderColor: "#FFFFFF",
    },
    // Invalid state: no red under the law — a 2px double-weight border makes the
    // failing field findable while Stripe's .Error text names the problem below.
    ".Input--invalid": {
      border: "2px solid #FFFFFF",
      color: "#FFFFFF",
      boxShadow: "none",
    },
    ".Label": {
      fontFamily: "'Familjen Grotesk', system-ui, -apple-system, sans-serif",
      fontSize: "11px",
      fontWeight: "500",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "#FFFFFF",
    },
    ".Error": { color: "#FFFFFF", fontSize: "13px" },
    ".Tab": {
      backgroundColor: "transparent",
      border: "1px solid #FFFFFF",
      color: "#FFFFFF",
    },
    ".Tab:hover": { color: "#FFFFFF" },
    ".Tab--selected": {
      backgroundColor: "#000000",
      border: "1px solid #45E0A8",
      color: "#FFFFFF",
    },
    ".TabIcon--selected": { fill: "#45E0A8" },
    ".Block": {
      backgroundColor: "#000000",
      border: "1px solid #FFFFFF",
      borderRadius: "12px",
    },
  },
};

const ELEMENTS_FONTS: CssFontSource[] = [
  {
    // Single-font mandate: IBM Plex Mono removed from the Stripe iframe load
    // (2026-07-13 audit — it was the last surface still fetching the retired mono).
    cssSrc:
      "https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&display=swap",
  },
];

// ─── Field validation (mirrors publicAttachCheckoutIdentity server rules) ─────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_ .-]+$/;

type Phase = "active" | "processing" | "success" | "expired" | "error";

export default function CheckoutPage() {
  const [, navigate] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  const plan = parsePlanSlug(search);
  const priceId = parsePriceId(search);
  const legacyCopy = isLegacyPlan(plan) ? PLAN_COPY[plan] : null;

  // Owner-created DB plans fetch their display copy (name / price / cadence) from
  // the public endpoint; the five legacy plans keep their curated PLAN_COPY. The
  // Stripe checkout flow below is identical either way — only the rail copy and
  // the {planId, priceId} passed to the session mutation differ.
  const dbPlanQuery = trpc.stripe.publicGetCheckoutPlan.useQuery(
    { slug: plan, ...(priceId ? { priceId } : {}) },
    { enabled: !legacyCopy, staleTime: 60_000, retry: false }
  );
  const copy: PlanCopy =
    legacyCopy ??
    (dbPlanQuery.data ? buildDbCopy(dbPlanQuery.data) : LOADING_COPY);

  const [phase, setPhase] = useState<Phase>("active");
  const [peReady, setPeReady] = useState(false);
  const [actionsReady, setActionsReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [emailErr, setEmailErr] = useState("");
  const [usernameErr, setUsernameErr] = useState("");
  const [payErr, setPayErr] = useState("");
  const [confirmedEmail, setConfirmedEmail] = useState("");

  const mountRef = useRef<HTMLDivElement>(null);
  const checkoutRef = useRef<StripeCheckoutElementsSdk | null>(null);
  const peRef = useRef<StripePaymentElement | null>(null);
  const actionsRef = useRef<StripeCheckoutLoadActionsSuccess | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const startedRef = useRef(false);

  const embedded =
    trpc.stripe.publicCreateEmbeddedCheckoutSession.useMutation();
  const attachIdentity = trpc.stripe.publicAttachCheckoutIdentity.useMutation();
  const utils = trpc.useUtils();

  const start = useCallback(async () => {
    const gen = ++genRef.current;
    setPhase("active");
    setPeReady(false);
    setActionsReady(false);
    setPayErr("");
    sessionIdRef.current = null;
    actionsRef.current = null;

    try {
      console.log(
        `[Checkout] [INPUT] plan=${plan} ui=elements buildTimeKey=${PUBLISHABLE_KEY ? "present" : "absent"}`
      );
      // Key resolution: build-time env first, runtime config endpoint second.
      // NEVER a hosted redirect — the elements-mode form is the only path.
      let publishableKey = PUBLISHABLE_KEY;
      if (!publishableKey) {
        const config = await utils.stripe.publicGetConfig.fetch();
        publishableKey = config.publishableKey;
        console.log(
          `[Checkout] [STEP] runtime key fetch → ${publishableKey ? "present" : "ABSENT"}`
        );
      }
      if (!publishableKey) {
        throw new Error(
          "Payments are temporarily unavailable (configuration). Please try again shortly."
        );
      }

      const { loadStripe } = await import("@stripe/stripe-js");
      const stripe = await loadStripe(publishableKey);
      if (!stripe) throw new Error("Stripe.js failed to load");
      if (gen !== genRef.current) return;

      // Session created NOW; the un-awaited clientSecret promise goes straight
      // into initCheckoutElementsSdk (synchronous, not awaited) for the fastest mount.
      const clientSecretPromise = embedded
        .mutateAsync({
          planId: plan,
          ...(priceId ? { priceId } : {}),
          origin: window.location.origin,
        })
        .then(session => {
          sessionIdRef.current = session.sessionId;
          console.log(
            `[Checkout] [STEP] elements session created session_id=${session.sessionId}`
          );
          return session.clientSecret;
        });
      // Our own rejection observer — Stripe consumes the same promise.
      clientSecretPromise.catch(() => {});

      const checkout = stripe.initCheckoutElementsSdk({
        clientSecret: clientSecretPromise,
        elementsOptions: {
          loader: "never",
          fonts: ELEMENTS_FONTS,
          appearance: APPEARANCE,
        },
      });
      checkoutRef.current = checkout;

      checkout.on("change", session => {
        if (gen !== genRef.current) return;
        if (session.status.type === "expired") {
          console.warn("[Checkout] [STATE] session expired (change event)");
          setPhase("expired");
        }
      });

      // terms: never — Stripe's auto mandate line wraps to 3 lines at 390px and
      // clipped (live audit 2026-07-10); the equivalent renewal/authorization
      // copy is our own legal line directly under the pay button.
      const paymentElement = checkout.createPaymentElement({
        layout: "tabs",
        terms: { card: "never" },
      });
      peRef.current = paymentElement;
      paymentElement.on("ready", () => {
        if (gen !== genRef.current) return;
        setPeReady(true);
        console.log(
          "[Checkout] [VERIFY] PASS — themed Payment Element mounted on-domain"
        );
      });

      // The mount node may not exist yet right after a phase switch — wait for React.
      let node = mountRef.current;
      for (let i = 0; i < 20 && !node; i++) {
        await new Promise(r => setTimeout(r, 50));
        node = mountRef.current;
      }
      if (gen !== genRef.current) return;
      if (!node)
        throw new Error("Checkout form failed to render. Please try again.");
      paymentElement.mount(node);

      const result = await checkout.loadActions();
      if (gen !== genRef.current) return;
      if (result.type !== "success") {
        throw new Error(
          result.error.message || "Could not establish a secure session."
        );
      }
      actionsRef.current = result.actions;
      setActionsReady(true);
      console.log(
        "[Checkout] [STEP] checkout actions loaded — form is confirmable"
      );
    } catch (err) {
      if (gen !== genRef.current) return;
      setErrorMsg(
        err instanceof Error ? err.message : "Could not start checkout."
      );
      setPhase("error");
      console.error(
        `[Checkout] [VERIFY] FAIL — ${err instanceof Error ? err.message : err}`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, priceId]);

  useEffect(() => {
    document.title = "Checkout — dıme";
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    return () => {
      genRef.current++;
      try {
        peRef.current?.destroy();
      } catch {
        /* element may already be gone */
      }
      peRef.current = null;
      checkoutRef.current = null;
      actionsRef.current = null;
    };
  }, [start]);

  const restart = useCallback(() => {
    console.log("[Checkout] [STEP] restarting — creating a new secure session");
    try {
      peRef.current?.destroy();
    } catch {
      /* element may already be gone */
    }
    peRef.current = null;
    setEmailErr("");
    setUsernameErr("");
    setErrorMsg("");
    void start();
  }, [start]);

  const handlePay = useCallback(async () => {
    if (phase !== "active") return;
    setEmailErr("");
    setUsernameErr("");
    setPayErr("");

    const emailTrim = email.trim();
    const usernameTrim = username.trim();
    let invalid = false;
    if (!EMAIL_RE.test(emailTrim)) {
      setEmailErr("Enter a valid email address.");
      invalid = true;
    }
    if (
      usernameTrim.length < 3 ||
      usernameTrim.length > 64 ||
      !USERNAME_RE.test(usernameTrim)
    ) {
      setUsernameErr(
        "3–64 characters — letters, numbers, spaces, underscores, dots or hyphens."
      );
      invalid = true;
    }
    const actions = actionsRef.current;
    const sessionId = sessionIdRef.current;
    if (invalid || !actions || !sessionId) return;

    setPhase("processing");
    console.log(
      `[Checkout] [STEP] pay clicked plan=${plan} session_id=${sessionId}`
    );

    // 1. Attach desired username to the session server-side (metadata).
    try {
      await attachIdentity.mutateAsync({
        sessionId,
        desiredUsername: usernameTrim,
      });
      console.log(
        "[Checkout] [STEP] desired_username attached to session metadata"
      );
    } catch (err) {
      setUsernameErr(
        err instanceof Error
          ? err.message
          : "Could not save your username. Please try again."
      );
      setPhase("active");
      return;
    }

    try {
      // 2. Buyer email → Stripe session.
      const emailResult = await actions.updateEmail(emailTrim);
      if (emailResult.type === "error") {
        console.warn(
          `[Checkout] [STATE] updateEmail rejected: ${emailResult.error.code}`
        );
        setEmailErr(emailResult.error.message);
        setPhase("active");
        return;
      }

      // 3. Confirm — cards resolve IN-PAGE; returnUrl only for redirect-based methods.
      const returnUrl = `${window.location.origin}/subscribe/success?session_id=${sessionId}&plan=${plan}`;
      const confirmed = await actions.confirm({
        redirect: "if_required",
        returnUrl,
      });

      if (confirmed.type === "error") {
        if (actions.getSession().status.type === "expired") {
          console.warn("[Checkout] [STATE] session expired at confirm time");
          setPhase("expired");
          return;
        }
        console.error(
          `[Checkout] [VERIFY] FAIL — confirm error: ${confirmed.error.message}`
        );
        setPayErr(confirmed.error.message);
        setPhase("active");
        return;
      }

      if (confirmed.session.status.type === "complete") {
        setConfirmedEmail(confirmed.session.email ?? emailTrim);
        setPhase("success");
        console.log(
          "[Checkout] [VERIFY] PASS — payment confirmed on-domain, session complete"
        );
        return;
      }

      // Redirect-based method took over navigation, or an in-between status.
      console.log(
        `[Checkout] [STATE] post-confirm status=${confirmed.session.status.type}`
      );
      setPhase("active");
    } catch (err) {
      console.error(
        `[Checkout] [VERIFY] FAIL — ${err instanceof Error ? err.message : err}`
      );
      setPayErr(
        err instanceof Error
          ? err.message
          : "Payment could not be processed. Please try again."
      );
      setPhase("active");
    }
  }, [phase, email, username, plan, attachIdentity]);

  const processing = phase === "processing";
  const canPay = phase === "active" && peReady && actionsReady;
  const legalLine = buildLegalLine(copy);

  const backLink = (
    <Link
      href="/#pricing"
      className="mono checkout-back"
      data-cta-id="checkout-back"
      data-cta-location="checkout"
      data-plan={plan}
      data-mode="paid"
    >
      ← BACK TO PRICING
    </Link>
  );

  return (
    <div className="dlv2" style={{ minHeight: "100dvh" }}>
      <nav className="nav" aria-label="Checkout">
        <div className="wrap nav-inner">
          <Link
            href="/"
            aria-label="dime home"
            style={{ textDecoration: "none" }}
          >
            <Wordmark />
          </Link>
          <span className="mono" style={{ marginLeft: "auto" }}>
            SECURE CHECKOUT · STRIPE
          </span>
        </div>
      </nav>

      <div className="checkout-wrap">
        {/* Plan summary rail */}
        <aside className="checkout-summary" aria-label="Plan summary">
          <div className="cs-plan">
            <span className="mono mono--mint">YOUR PLAN</span>
            <h2>{copy.name}</h2>
            <div className="rowline">
              <span>Price</span>
              <span className="lead" aria-hidden="true" />
              <b className="num">
                {copy.price} {copy.period}
              </b>
            </div>
            {copy.perDay && (
              <div className="rowline">
                <span>Works out to</span>
                <span className="lead" aria-hidden="true" />
                <b className="num">{copy.perDay}</b>
              </div>
            )}
            {copy.modelAccess && (
              <div className="rowline rowline--detail">
                <span>Model access</span>
                <span className="lead" aria-hidden="true" />
                <b>{copy.modelAccess}</b>
              </div>
            )}
            {copy.credits && (
              <div className="rowline rowline--detail">
                <span>AI Analyst credits</span>
                <span className="lead" aria-hidden="true" />
                <b className="num">{copy.credits}</b>
              </div>
            )}
            {copy.recurring !== false && (
              <div className="rowline rowline--detail">
                <span>Cancellation</span>
                <span className="lead" aria-hidden="true" />
                <b>Anytime, 2 clicks</b>
              </div>
            )}
            {copy.features && (
              <ul className="checkout-features">
                {copy.features.map(f => (
                  <li key={f}>
                    <MintCheck muted />
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="cs-legal">
            <span className="fine">{copy.renewal}</span>
            <span className="fine">
              By continuing you agree to the{" "}
              <Link href="/terms" style={{ color: "var(--text-secondary)" }}>
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" style={{ color: "var(--text-secondary)" }}>
                Privacy Policy
              </Link>
              .
            </span>
            <span className="fine">
              dime is analytical software — statistical model projections, no
              guaranteed outcomes. 21+ (or legal betting age in your
              jurisdiction). Bet responsibly. Gambling problem? Call
              1-800-GAMBLER.
            </span>
            {backLink}
          </div>
        </aside>

        {/* Right column: branded form (Stripe controls only the secure inputs) */}
        <div className="checkout-right">
          {phase === "error" ? (
            <div className="checkout-status" role="alert">
              <h1 className="checkout-heading">Checkout unavailable</h1>
              <span>Checkout couldn't start: {errorMsg}</span>
              <button
                type="button"
                className="btn btn--mint"
                onClick={restart}
                data-cta-id="checkout-retry"
                data-cta-location="checkout"
                data-plan={plan}
                data-mode="paid"
              >
                Try again
              </button>
              <Link
                href="/#pricing"
                className="mono"
                style={{ color: "var(--text-muted)" }}
              >
                ← Back to pricing
              </Link>
            </div>
          ) : (
            <div className="checkout-formcard">
              {phase === "success" ? (
                <div className="checkout-panel" role="status">
                  <div className="checkout-panel-stamp">
                    <span className="mono">STATUS</span>
                    <span className="mono mono--mint">ACTIVE</span>
                  </div>
                  <h2>You're in.</h2>
                  <p>
                    {copy.name} is active on this account. A receipt is on its
                    way to {confirmedEmail}.
                  </p>
                  <button
                    type="button"
                    className="btn btn--mint btn--wide btn--pay"
                    onClick={() =>
                      navigate(
                        `/subscribe/success?session_id=${sessionIdRef.current ?? ""}&plan=${plan}`
                      )
                    }
                    data-cta-id="checkout-success-continue"
                    data-cta-location="checkout"
                    data-plan={plan}
                    data-mode="paid"
                  >
                    Open the projections board
                  </button>
                </div>
              ) : phase === "expired" ? (
                <div className="checkout-panel" role="alert">
                  <span className="mono checkout-stamp">SESSION EXPIRED</span>
                  <p>
                    Secure sessions time out to protect your card. Nothing was
                    charged.
                  </p>
                  <button
                    type="button"
                    className="btn btn--mint btn--wide btn--pay"
                    onClick={restart}
                    data-cta-id="checkout-restart-session"
                    data-cta-location="checkout"
                    data-plan={plan}
                    data-mode="paid"
                  >
                    Start a new secure session
                  </button>
                  {backLink}
                </div>
              ) : (
                <form
                  className="checkout-form"
                  onSubmit={e => {
                    e.preventDefault();
                    void handlePay();
                  }}
                >
                  <div>
                    <h1 className="checkout-heading">{copy.heading}</h1>
                    <p className="checkout-sub">
                      Two fields and a card. Access is live the moment payment
                      clears.
                    </p>
                  </div>

                  <div className="checkout-field">
                    <label htmlFor="checkout-email">EMAIL</label>
                    <input
                      id="checkout-email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={email}
                      disabled={processing}
                      onChange={e => setEmail(e.target.value)}
                      aria-invalid={emailErr ? true : undefined}
                      aria-describedby={
                        emailErr ? "checkout-email-err" : undefined
                      }
                    />
                    {emailErr && (
                      <span className="field-err" id="checkout-email-err">
                        <span className="stamp">ERROR</span>
                        <span className="msg">{emailErr}</span>
                      </span>
                    )}
                  </div>

                  <div className="checkout-field">
                    <label htmlFor="checkout-username">DESIRED USERNAME</label>
                    <input
                      id="checkout-username"
                      type="text"
                      autoComplete="username"
                      placeholder="your_handle"
                      value={username}
                      disabled={processing}
                      onChange={e => setUsername(e.target.value)}
                      aria-invalid={usernameErr ? true : undefined}
                      aria-describedby={
                        usernameErr
                          ? "checkout-username-err"
                          : "checkout-username-help"
                      }
                    />
                    <span className="field-help" id="checkout-username-help">
                      Your handle inside dime.
                    </span>
                    {usernameErr && (
                      <span className="field-err" id="checkout-username-err">
                        <span className="stamp">ERROR</span>
                        <span className="msg">{usernameErr}</span>
                      </span>
                    )}
                  </div>

                  <div className="checkout-pe-block">
                    <span className="mono">PAYMENT</span>
                    {!peReady && (
                      <div
                        className="pe-skeleton"
                        role="status"
                        aria-live="polite"
                      >
                        <span className="bar" aria-hidden="true" />
                        <span className="bar" aria-hidden="true" />
                        <span className="bar" aria-hidden="true" />
                        <span className="mono pe-status">
                          <span className="pulse" aria-hidden="true" />{" "}
                          ESTABLISHING SECURE SESSION
                        </span>
                      </div>
                    )}
                    <div
                      ref={mountRef}
                      className={
                        peReady
                          ? "checkout-pe"
                          : "checkout-pe checkout-pe--hidden"
                      }
                    />
                    {payErr && (
                      <span className="field-err" role="alert">
                        <span className="stamp">ERROR</span>
                        <span className="msg">{payErr}</span>
                      </span>
                    )}
                  </div>

                  <button
                    type="submit"
                    className="btn btn--mint btn--wide btn--pay"
                    disabled={!canPay}
                    aria-busy={processing || undefined}
                    data-cta-id="checkout-pay"
                    data-cta-location="checkout"
                    data-plan={plan}
                    data-mode="paid"
                  >
                    {processing ? (
                      <>
                        <span className="pulse" aria-hidden="true" /> Processing
                        payment…
                      </>
                    ) : (
                      copy.payLabel
                    )}
                  </button>
                  <span className="checkout-legal-line">{legalLine}</span>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
