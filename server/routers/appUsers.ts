import { TRPCError } from "@trpc/server";
import { AppUserHasDataError } from "../appUserDeletion";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { parse as parseCookieHeader } from "cookie";
import { publicProcedure, router, stripeProcedure, csrfOriginCheck } from "../_core/trpc";
import { resolveClientIdentity } from "../_core/clientIdentity";
import { logSafe } from "../_core/logSafe";
import { getSessionCookieOptions } from "../_core/cookies";
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "../_core/env";
import type { Request } from "express";
import { postSecurityAlert } from "../discord/discordSecurityAlert";

import crypto from "crypto";
import {
  createAppUser,
  listAppUsers,
  getAppUserById,
  lookupAppUserByIdFresh,
  getAppUserByEmail,
  getAppUserByUsername,
  updateAppUser,
  deleteAppUser,
  softDeleteAppUser,
  updateAppUserLastSignedIn,
  incrementTokenVersion,
  incrementAllTokenVersions,
  insertSecurityEvent,
  invalidateAppUserByIdCache,
  updateAccountLockoutState,
  recordAccountLoginFailure,
} from "../db";
import {
  accountLockoutConfig,
  clearedLockout,
  isLockedOut,
  type AccountLockoutState,
} from "../accountLockout";
import { getDiscordClient } from "../discord/bot";
import { notifyOwner } from "../_core/notification";
import { getCachedAppUser, getCachedAppUserEntry, setCachedAppUser, invalidateCachedAppUser } from "../dbCircuitBreaker";
import { resolveOwnerIdentity } from "../ownerAuth";
import { getDb } from "../db";
import {
  discordInviteTokens,
  appUsers as appUsersTable,
  planPrices,
  subscriptionPlans,
} from "../../drizzle/schema";
import { eq, ne, and, isNull, gt, or } from "drizzle-orm";
import { emitServerEvent } from "../analytics/emitServer";
import { recordEntitlementEvent } from "../stripe/entitlementLedger";
import { listAllPlans } from "../stripe/planStore";
import {
  buildClaimUrl,
  deriveEntitlementFromPrice,
  mintClaimToken,
  resolveCreationPassword,
} from "../adminAccountProvisioning";

export const APP_USER_COOKIE = "app_session";

/**
 * retryOnce — retry a DB operation exactly once on transient TiDB cold-start errors.
 *
 * TiDB Serverless drops idle connections after ~5 minutes. When the pool is cold,
 * the first query can take 5-30s and trigger the circuit breaker timeout. A single
 * retry after a 3s delay gives TiDB time to establish a new connection and succeed.
 *
 * Only retries on transient errors. Business logic TRPCErrors are re-thrown immediately.
 */
async function retryOnce<T>(fn: () => Promise<T>, tag: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    const msg = (err as Error)?.message ?? String(err);
    const isTransient =
      msg.includes('timed out') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ER_CON_COUNT_ERROR') ||
      msg.includes('Circuit is OPEN') ||
      msg.includes('Database not available') ||
      msg.includes('ECONNRESET') ||
      msg.includes('connect EHOSTUNREACH');
    if (!isTransient) throw err;
    console.warn(`${tag} [RETRY] Transient DB error — retrying in 3s: ${msg.substring(0, 120)}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log(`${tag} [RETRY] Executing retry attempt...`);
    return await fn();
  }
}

export function getAppCookie(req: Request): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  return cookies[APP_USER_COOKIE];
}

// Helper: sign a JWT for an app user session — embeds tokenVersion (tv) for invalidation
export async function signAppUserToken(userId: number, role: string, tokenVersion: number) {
  const secret = new TextEncoder().encode(ENV.cookieSecret);
  console.log(`[AppAuth] signAppUserToken: userId=${userId} role=${role} tv=${tokenVersion}`);
  return new SignJWT({ sub: String(userId), role, type: "app_user", tv: tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("90d")
    .sign(secret);
}

// Helper: verify app user JWT from cookie — returns userId, role, tv (tokenVersion), and exp (ms)
export async function verifyAppUserToken(token: string) {
  try {
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token, secret);
    if (payload.type !== "app_user") {
      console.log(`[AppAuth] verifyAppUserToken: rejected — wrong type: ${payload.type}`);
      return null;
    }
    const tv = typeof payload.tv === "number" ? payload.tv : null;
    // Extract exp once here to avoid a second jwtVerify call in callers (e.g. appUsers.me)
    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null; // convert s → ms
    return { userId: Number(payload.sub), role: payload.role as string, tv, exp };
  } catch (e) {
    console.log(`[AppAuth] verifyAppUserToken: JWT verification failed — ${(e as Error).message}`);
    return null;
  }
}

// Owner-only middleware — validates tokenVersion against DB to support force-logout
// DB-resilient: falls back to in-memory user cache when DB is unavailable
export const ownerProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const token = getAppCookie(ctx.req);
  if (!token) {
    console.log(`[AppAuth] ownerProcedure: REJECTED — no app_session cookie`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const payload = await verifyAppUserToken(token);
  if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });

  // ── Load user from DB (authoritative source for role) ──────────────────────
  // IMPORTANT: role is checked from DB, NOT from JWT claim.
  // Reason: JWT role is baked at login time. If an admin promotes a user to owner
  // after their last login, the JWT still carries the old role. DB is always current.
  //
  // Snapshot the last-known-good row before the authoritative read. It is eligible
  // only for a short outage window and only when its tokenVersion still matches.
  const fallback = getCachedAppUserEntry(payload.userId);
  invalidateAppUserByIdCache(payload.userId);
  const lookup = await lookupAppUserByIdFresh(payload.userId);
  if (lookup.status === "found") setCachedAppUser(lookup.user);
  const resolved = resolveOwnerIdentity({ lookup, fallback, tokenVersion: payload.tv });
  if (!resolved.ok) {
    console.log(`[AppAuth] ownerProcedure: REJECTED — reason=${resolved.reason} userId=${payload.userId}`);
    if (resolved.reason === "token_version_mismatch" || resolved.reason === "token_version_missing") {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Session invalidated. Please log in again." });
    }
    throw new TRPCError({ code: "FORBIDDEN", message: "Owner access required" });
  }
  console.log(`[AppAuth] ownerProcedure: GRANTED — userId=${resolved.user.id} source=${resolved.source}`);
  return next({ ctx: { ...ctx, appUser: resolved.user } });
});

// Handicapper procedure — grants access to owner, admin, and handicapper roles
// DB-resilient: falls back to in-memory user cache when DB is unavailable
export const handicapperProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const token = getAppCookie(ctx.req);
  if (!token) {
    console.log(`[AppAuth] handicapperProcedure: REJECTED — no app_session cookie`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const payload = await verifyAppUserToken(token);
  if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });
  let user = await getAppUserById(payload.userId);
  const fromCache = !user;
  if (!user) {
    user = getCachedAppUser(payload.userId);
    if (user) console.log(`[AppAuth] handicapperProcedure: DB unavailable — serving userId=${payload.userId} from cache`);
  } else {
    setCachedAppUser(user);
  }
  if (!user || !user.hasAccess) {
    console.log(`[AppAuth] handicapperProcedure: REJECTED — user not found or no access`);
    throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
  }
  if (!fromCache && payload.tv !== null && payload.tv !== user.tokenVersion) {
    console.log(`[AppAuth] handicapperProcedure: REJECTED — tokenVersion mismatch: jwt.tv=${payload.tv} db.tv=${user.tokenVersion} userId=${user.id}`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session invalidated. Please log in again." });
  }
  const allowed = ["owner", "admin", "handicapper"] as const;
  if (!allowed.includes(user.role as typeof allowed[number])) {
    console.log(`[AppAuth] handicapperProcedure: REJECTED — role=${user.role} not in [owner, admin, handicapper]`);
    throw new TRPCError({ code: "FORBIDDEN", message: "Handicapper access required" });
  }
  return next({ ctx: { ...ctx, appUser: user } });
});

// Authenticated app user middleware — validates tokenVersion against DB to support force-logout
// DB-resilient: falls back to in-memory user cache when DB is unavailable (circuit open)
export const appUserProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const token = getAppCookie(ctx.req);
  if (!token) {
    console.log(`[AppAuth] appUserProcedure: REJECTED — no app_session cookie`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const payload = await verifyAppUserToken(token);
  if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });

  // Try DB first; fall back to cache if DB is unavailable
  let user = await getAppUserById(payload.userId);
  const fromCache = !user;
  if (!user) {
    user = getCachedAppUser(payload.userId);
    if (user) {
      console.log(`[AppAuth] appUserProcedure: DB unavailable — serving userId=${payload.userId} from cache`);
    }
  } else {
    // DB succeeded — update cache with fresh data
    setCachedAppUser(user);
  }

  if (!user) {
    console.log(`[AppAuth] appUserProcedure: REJECTED — userId=${payload.userId} not found (DB + cache miss)`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found" });
  }
  if (!user.hasAccess) {
    console.log(`[AppAuth] appUserProcedure: REJECTED — userId=${user.id} hasAccess=false`);
    throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
  }
  // tokenVersion check: only enforce when DB is available (cache may have stale tv)
  if (!fromCache && payload.tv !== null && payload.tv !== user.tokenVersion) {
    console.log(`[AppAuth] appUserProcedure: REJECTED — tokenVersion mismatch: jwt.tv=${payload.tv} db.tv=${user.tokenVersion} userId=${user.id}`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session invalidated. Please log in again." });
  }
  // Check expiry
    if (user.expiryDate && Date.now() > user.expiryDate) {
    console.log(`[AppAuth] appUserProcedure: REJECTED — userId=${user.id} account expired`);
    throw new TRPCError({ code: "FORBIDDEN", message: "Account expired" });
  }
  return next({ ctx: { ...ctx, appUser: user } });
});

/**
 * stripeAppUserProcedure — CSRF-exempt authenticated procedure for Stripe operations.
 *
 * Identical auth logic to appUserProcedure but built on stripeProcedure (no csrfOriginCheck).
 * Use this for all Stripe mutations that require an authenticated app user
 * (createCheckoutSession, createPortalSession, getSubscription).
 *
 * Security is maintained by:
 *   - app_session JWT cookie validation (tokenVersion + expiry checks)
 *   - Stripe HMAC-SHA256 webhook signature verification
 */
/**
 * AUTH-003: cookie-authenticated Stripe mutations (createCheckoutSession,
 * cancelSubscription, reactivateSubscription) are always invoked from our own
 * pages, so the CSRF origin check belongs here. The base `stripeProcedure` is
 * origin-exempt for genuinely cross-origin callers; that exemption was never
 * meant to cover browser-driven mutations carrying the session cookie, which is
 * `SameSite=None` in production. A missing Origin header is still allowed, so
 * server-to-server callers are unaffected.
 */
export const stripeAppUserProcedure = stripeProcedure.use(csrfOriginCheck).use(async ({ ctx, next }) => {
  const token = getAppCookie(ctx.req);
  if (!token) {
    console.log(`[AppAuth] stripeAppUserProcedure: REJECTED — no app_session cookie`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const payload = await verifyAppUserToken(token);
  if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });
  let user = await getAppUserById(payload.userId);
  const fromCache = !user;
  if (!user) {
    user = getCachedAppUser(payload.userId);
    if (user) {
      console.log(`[AppAuth] stripeAppUserProcedure: DB unavailable — serving userId=${payload.userId} from cache`);
    }
  } else {
    setCachedAppUser(user);
  }
  if (!user) {
    console.log(`[AppAuth] stripeAppUserProcedure: REJECTED — userId=${payload.userId} not found`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found" });
  }
  if (!user.hasAccess) {
    console.log(`[AppAuth] stripeAppUserProcedure: REJECTED — userId=${user.id} hasAccess=false`);
    throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
  }
  if (!fromCache && payload.tv !== null && payload.tv !== user.tokenVersion) {
    console.log(`[AppAuth] stripeAppUserProcedure: REJECTED — tokenVersion mismatch userId=${user.id}`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session invalidated. Please log in again." });
  }
  if (user.expiryDate && Date.now() > user.expiryDate) {
    console.log(`[AppAuth] stripeAppUserProcedure: REJECTED — userId=${user.id} account expired`);
    throw new TRPCError({ code: "FORBIDDEN", message: "Account expired" });
  }
  return next({ ctx: { ...ctx, appUser: user } });
});

/**
 * The billing catalogue, indexed for lookup.
 *
 * `plan_prices` is the authority on what a member is actually paying: the plan
 * slug alone cannot tell you the amount, the currency, or whether the SKU is
 * recurring or a one-off. A NULL `billingInterval` is the schema's encoding of
 * "not recurring" — i.e. lifetime — and is what distinguishes a $999.99 lifetime
 * seat from a $99.99/month one under the same plan.
 */
type CataloguePrice = {
  id: number;
  stripePriceId: string;
  amountCents: number;
  currency: string;
  billingInterval: string | null;
  intervalCount: number | null;
  plan: { slug: string; name: string; planType: string; active: boolean };
};

async function loadBillingCatalogue(): Promise<{
  byPriceId: Map<number, CataloguePrice>;
  byPlanSlug: Map<string, CataloguePrice["plan"]>;
}> {
  const byPriceId = new Map<number, CataloguePrice>();
  const byPlanSlug = new Map<string, CataloguePrice["plan"]>();
  const db = await getDb();
  if (!db) return { byPriceId, byPlanSlug };

  try {
    const rows = await db
      .select({
        priceId: planPrices.id,
        stripePriceId: planPrices.stripePriceId,
        amountCents: planPrices.amountCents,
        currency: planPrices.currency,
        // Drizzle property is `interval`; the DB column is `billingInterval`.
        billingInterval: planPrices.interval,
        intervalCount: planPrices.intervalCount,
        slug: subscriptionPlans.slug,
        name: subscriptionPlans.name,
        planType: subscriptionPlans.planType,
        planActive: subscriptionPlans.active,
      })
      .from(planPrices)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, planPrices.planId));

    for (const r of rows) {
      const plan = { slug: r.slug, name: r.name, planType: r.planType, active: Boolean(r.planActive) };
      byPriceId.set(r.priceId, {
        id: r.priceId,
        stripePriceId: r.stripePriceId,
        amountCents: r.amountCents,
        currency: r.currency,
        billingInterval: r.billingInterval ?? null,
        intervalCount: r.intervalCount ?? null,
        plan,
      });
      if (!byPlanSlug.has(r.slug)) byPlanSlug.set(r.slug, plan);
    }
  } catch (err) {
    // Degrade to "no plan detail" rather than failing the whole admin table —
    // roles, access and Discord state are still worth rendering.
    console.error(`[AppAdmin][loadBillingCatalogue][FAIL] ${(err as Error)?.message ?? String(err)}`);
  }
  return { byPriceId, byPlanSlug };
}

/**
 * Cap on the sanitized login identifier logged/alerted for AUTH_FAIL events.
 *
 * `sanitizeLoginIdentifier` below builds the identifier as
 * `${local.substring(0, 3)}***${domain}`, where `domain` is the ENTIRE
 * remainder of the raw input after "@" — unbounded, since the login schema
 * enforces only `.min(1)` on `emailOrUsername`, not `.max()`. A hostile
 * multi-thousand-char `emailOrUsername` therefore produced a
 * "sanitized" identifier that was itself unbounded — wrong on its own terms,
 * and (combined with the Discord embed wrapper text around it) what blew
 * through Discord's 1024-char field cap (2026-08-06 review, Critical 1b).
 * The sanitization FORMAT is unchanged here; only the finished string's
 * length is bounded.
 */
export const SANITIZED_IDENTIFIER_MAX = 128;

/**
 * Sanitize a login identifier for logging/alerting: first 3 chars of the
 * local email part + "***" + "@domain" for emails, or first 3 chars + "***"
 * for usernames. Never returns the full credential. Result is capped at
 * SANITIZED_IDENTIFIER_MAX chars — see that constant's doc comment.
 */
export function sanitizeLoginIdentifier(rawId: string): string {
  const isEmailId = rawId.includes("@");
  const sanitized = isEmailId
    ? (() => {
        const atIdx = rawId.indexOf("@");
        const local = rawId.substring(0, atIdx);
        const domain = rawId.substring(atIdx); // includes the @
        return `${local.substring(0, 3)}***${domain}`;
      })()
    : `${rawId.replace(/^@/, "").substring(0, 3)}***`;
  return sanitized.substring(0, SANITIZED_IDENTIFIER_MAX);
}

export const appUsersRouter = router({
  // ─── Auth ──────────────────────────────────────────────────────────────────

  login: publicProcedure
    .input(z.object({
      emailOrUsername: z.string().min(1),
      password: z.string().min(1),
      stayLoggedIn: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      // [STEP] Extract the TRUE client identity for rate limiting.
      // Never parse x-forwarded-for here: production XFF is
      // [CF PoP, Railway edge] and the leftmost token is a Cloudflare PoP
      // shared by an entire metro. Keying on it both aggregated unrelated
      // users onto one login-failure budget AND diluted a real attacker's
      // budget across rotating PoPs (2026-08-06 audit).
      const clientIp = resolveClientIdentity(ctx.req) || "unknown";

      // [STEP] Check login rate limit BEFORE any DB query (prevents timing attacks)
      const rateCheck = checkLoginRateLimit(clientIp);
      if (!rateCheck.allowed) {
        console.warn(`[LoginRateLimit] BLOCKED login attempt | IP=${logSafe(clientIp)}`);
        // Log as security event
        const blockedAt = Date.now();
        insertSecurityEvent({
          eventType: "AUTH_FAIL",
          ip: clientIp,
          blockedOrigin: null,
          trpcPath: "appUsers.login",
          httpMethod: ctx.req.method ?? "POST",
          userAgent: (ctx.req.headers["user-agent"] as string | undefined) ?? null,
          context: "rate_limit_exceeded",
          occurredAt: blockedAt,
        }).catch((err) =>
          console.error(`[LoginRateLimit] DB insert failed: ${(err as Error).message}`)
        );
        postSecurityAlert({
          eventType: "AUTH_FAIL",
          ip: clientIp,
          path: "appUsers.login",
          method: ctx.req.method ?? "POST",
          userAgent: (ctx.req.headers["user-agent"] as string | undefined) ?? null,
          context: "rate_limit_exceeded",
          targetIdentifier: "[rate-limited]",
          occurredAt: blockedAt,
        }).catch((err) =>
          console.error(`[LoginRateLimit] Discord alert failed: ${(err as Error).message}`)
        );
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many failed login attempts. Please wait 15 minutes and try again.",
        });
      }

      // Try email first, then username
      const isEmail = input.emailOrUsername.includes("@");
      const user = isEmail
        ? await getAppUserByEmail(input.emailOrUsername.toLowerCase())
        : await getAppUserByUsername(input.emailOrUsername.replace(/^@/, "").toLowerCase());

      // ── AUTH_FAIL helper — fire-and-forget, never blocks the response ──────
      const fireAuthFailEvent = (reason: string) => {
        const ip = clientIp; // reuse extracted IP
        const ua = (ctx.req.headers["user-agent"] as string | undefined) ?? null;
        const tag = "[AppAuth][AUTH_FAIL]";

        // Sanitize the identifier for logging — show first 3 chars + *** to avoid
        // logging full credentials in plaintext while still being useful for debugging.
        // For emails: show first 3 chars of the local part (before @) + *** + @domain
        // For usernames: show first 3 chars + ***
        // Length-bounded by sanitizeLoginIdentifier — see SANITIZED_IDENTIFIER_MAX.
        const rawId = input.emailOrUsername;
        const sanitizedId = sanitizeLoginIdentifier(rawId);

        console.warn(
          `${tag} BLOCKED | IP=${logSafe(ip)} reason="${logSafe(reason)}"` +
          ` identifier="${logSafe(sanitizedId)}" ua="${logSafe(ua?.substring(0, 60) ?? "none")}"`
        );
        const authFailAt = Date.now();
        insertSecurityEvent({
          eventType: "AUTH_FAIL",
          ip,
          blockedOrigin: null,
          trpcPath: "appUsers.login",
          httpMethod: ctx.req.method ?? "POST",
          userAgent: ua,
          context: reason,
          occurredAt: authFailAt,
        }).catch((err) =>
          console.error(`${tag} DB insert failed: ${(err as Error).message}`)
        );
        // [STEP] Post structured embed to 🗒️-𝗦𝗘𝗖𝗨𝗥𝗜𝗧𝗬-𝗘𝗩𝗘𝗡𝗧𝗦 Discord channel (async, non-blocking)
        // targetIdentifier: the sanitized login credential the attacker used.
        // Shows WHAT account was targeted without exposing the full credential in logs.
        postSecurityAlert({
          eventType: "AUTH_FAIL",
          ip,
          path: "appUsers.login",
          method: ctx.req.method ?? "POST",
          userAgent: ua,
          context: reason,
          targetIdentifier: sanitizedId,
          occurredAt: authFailAt,
        }).catch((err) =>
          console.error(`${tag} Discord alert failed: ${(err as Error).message}`)
        );
      };

      if (!user) {
        fireAuthFailEvent("user_not_found");
        recordLoginFailure(clientIp); // [RATE_LIMIT] count failure
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }
      if (!user.hasAccess) {
        fireAuthFailEvent("account_access_disabled");
        recordLoginFailure(clientIp); // [RATE_LIMIT] count failure
        throw new TRPCError({ code: "FORBIDDEN", message: "Account access disabled" });
      }
      if (user.expiryDate && Date.now() > user.expiryDate) {
        fireAuthFailEvent("account_expired");
        recordLoginFailure(clientIp); // [RATE_LIMIT] count failure
        throw new TRPCError({ code: "FORBIDDEN", message: "Account has expired" });
      }

      // ── Per-account lockout (credential-stuffing defense) ──────────────────
      // Counts failures against THIS account across ALL IPs, so a botnet can't
      // outrun the per-IP limiter. State lives on the app_users row; the pure
      // decision logic is server/accountLockout.ts.
      const lockoutCfg = accountLockoutConfig();
      const lockState: AccountLockoutState = {
        failedLoginCount: user.failedLoginCount,
        firstFailedLoginAt: user.firstFailedLoginAt,
        lockedUntil: user.lockedUntil,
      };
      // While locked, block EVERY attempt (even a correct password) — the
      // cooldown is the penalty. Time-boxed + cleared by password reset, so a
      // real user always recovers. The response is deliberately the SAME generic
      // "Invalid credentials" / UNAUTHORIZED as a wrong password, so the lock
      // state is not a username-existence oracle. (We skip bcrypt entirely, but
      // that timing difference already exists for user_not_found above.)
      if (isLockedOut(lockState, Date.now(), lockoutCfg)) {
        fireAuthFailEvent("account_locked");
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) {
        fireAuthFailEvent("invalid_password");
        recordLoginFailure(clientIp); // [RATE_LIMIT] per-IP count
        // Per-account count — ATOMIC (SELECT … FOR UPDATE) so concurrent
        // guesses can't out-race the cap; fail-open (never blocks the response).
        void recordAccountLoginFailure(user.id, Date.now(), lockoutCfg).then(
          ({ justLocked }) => {
            if (justLocked) fireAuthFailEvent("account_locked_triggered");
          }
        );
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

      // Successful login clears any accumulated lockout state (only writes when
      // there is something to clear — no needless write on every login).
      if (user.failedLoginCount > 0 || user.lockedUntil != null) {
        void updateAccountLockoutState(user.id, clearedLockout());
      }

      await updateAppUserLastSignedIn(user.id);

      // Device-tagged authoritative "last sign in" (server-derived; inert until
      // the analytics pipeline is enabled). Never blocks or breaks login.
      const loginUa = ctx.req?.headers?.["user-agent"];
      void emitServerEvent({
        eventName: "login",
        userId: user.id,
        userAgent: Array.isArray(loginUa) ? loginUa[0] : loginUa,
        props: { method: "password", is_returning: true },
      });

      console.log(`[AppAuth] login: userId=${user.id} username=${user.username} role=${user.role} tv=${user.tokenVersion} stayLoggedIn=${input.stayLoggedIn}`);

      // stayLoggedIn = 90 days; otherwise session cookie (expires on browser close)
      const sessionDays = input.stayLoggedIn ? 90 : 1;
      const token = await signAppUserToken(user.id, user.role, user.tokenVersion);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      // [LOGIN FIX 2026-07-12] Defensive clear of any legacy Domain-scoped
      // app_session cookie (from before host-only cookies). If one survives,
      // the browser sends BOTH cookies and the old identity can shadow the
      // new login — clearing the domain variant makes account switching stick.
      try {
        if (!ctx.res.headersSent) {
          ctx.res.clearCookie(APP_USER_COOKIE, {
            ...cookieOptions,
            domain: `.${ctx.req.hostname}`,
            maxAge: -1,
          });
        }
      } catch {
        /* best-effort — never block login on the legacy clear */
      }
      if (!ctx.res.headersSent) {
        if (input.stayLoggedIn) {
          ctx.res.cookie(APP_USER_COOKIE, token, {
            ...cookieOptions,
            maxAge: sessionDays * 24 * 60 * 60 * 1000,
          });
        } else {
          // Session cookie — no maxAge, expires when browser closes
          ctx.res.cookie(APP_USER_COOKIE, token, {
            ...cookieOptions,
            maxAge: undefined,
          });
        }
      }

      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          hasAccess: user.hasAccess,
          expiryDate: user.expiryDate,
        },
      };
    }),

  /**
   * getLoginStatus — read-only rate-limit status for the requesting IP.
   *
   * [INPUT]  req.ip (extracted from context)
   * [OUTPUT] { remainingAttempts, lockoutUntil, maxAttempts, isLockedOut }
   * [VERIFY] No side effects — does NOT record a failure attempt
   */
  getLoginStatus: publicProcedure.query(({ ctx }) => {
    // Must use the SAME key as the login mutation, or this public endpoint
    // reports another population's lockout state (2026-08-06 audit).
    const ip = resolveClientIdentity(ctx.req) || "unknown";
    const result = checkLoginRateLimit(ip);
    console.log(
      `[getLoginStatus] IP=${logSafe(ip)} remaining=${result.remainingAttempts} ` +
      `locked=${!result.allowed} lockoutUntil=${result.lockoutUntil}`
    );
    return {
      remainingAttempts: result.remainingAttempts,
      lockoutUntil: result.lockoutUntil,
      maxAttempts: LOGIN_RATE_MAX_FAILURES,
      isLockedOut: !result.allowed,
    };
  }),

    logout: publicProcedure.mutation(async ({ ctx }) => {
    const cookieOptions = getSessionCookieOptions(ctx.req);
    // Invalidate user cache on logout so stale entries don't persist
    const token = getAppCookie(ctx.req);
    if (token) {
      const payload = await verifyAppUserToken(token);
      if (payload) invalidateCachedAppUser(payload.userId);
    }
    if (!ctx.res.headersSent) {
      ctx.res.clearCookie(APP_USER_COOKIE, { ...cookieOptions, maxAge: -1 });
    }
    return { success: true };
  }),

  me: publicProcedure.query(async ({ ctx }) => {
    const token = getAppCookie(ctx.req);
    if (!token) return null;
    const payload = await verifyAppUserToken(token);
    if (!payload) return null;

    // [PERF] Fast path: serve from 5-minute circuit-breaker cache before hitting DB.
    // getAppUserById has its own 30s cache, but it still calls getDb() which can
    // cold-start TiDB serverless (2-5s). getCachedAppUser is pure in-memory (0ms).
    // On cache hit, we skip the DB entirely — critical for initial page load speed.
    // On cache miss, we fall through to getAppUserById which populates both caches.
    let user = getCachedAppUser(payload.userId);
    const fromCircuitBreakerCache = user !== null;
    if (!user) {
      user = await getAppUserById(payload.userId);
      if (user) {
        // Populate circuit-breaker cache for future requests
        setCachedAppUser(user);
      }
    }
    console.log(`[AppAuth] me: userId=${payload.userId} fromCache=${fromCircuitBreakerCache}`);

    if (!user || !user.hasAccess) return null;
    if (user.expiryDate && Date.now() > user.expiryDate) return null;
    // [STEP] tokenVersion check — must match appUserProcedure's check.
    // If the session was force-invalidated (admin force-logout, password reset, etc.)
    // the JWT tv will differ from the DB tokenVersion. Returning null here ensures
    // the frontend sees the user as unauthenticated BEFORE firing appUserProcedure
    // queries (e.g. games.list). Without this check, appUsers.me returns a user
    // object (enabling games.list), but games.list then returns UNAUTHORIZED due to
    // the tokenVersion mismatch — causing "No MLB games found" + unexpected logout.
    if (payload.tv !== null && payload.tv !== undefined && payload.tv !== user.tokenVersion) {
      console.log(`[AppAuth] me: session invalidated — jwt.tv=${payload.tv} db.tv=${user.tokenVersion} userId=${user.id}`);
      return null;
    }

    // [STEP] Extract JWT exp claim to surface session expiry to the frontend
    // payload.exp is already extracted by verifyAppUserToken — no second jwtVerify needed.
    // This eliminates a duplicate HMAC-SHA256 verification on every appUsers.me call.
    const sessionExpiresAt: number | null = payload.exp ?? null;

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      hasAccess: user.hasAccess,
      expiryDate: user.expiryDate,
      termsAccepted: user.termsAccepted,
      discordId: user.discordId ?? null,
      discordUsername: user.discordUsername ?? null,
      discordAvatar: user.discordAvatar ?? null,
      discordConnectedAt: user.discordConnectedAt ?? null,
      sessionExpiresAt, // null if session cookie (no maxAge), ms timestamp if persistent
      stripePlanId: user.stripePlanId ?? null,
      stripeCustomerId: user.stripeCustomerId ?? null,
      stripeSubscriptionId: user.stripeSubscriptionId ?? null,
      cancelAtPeriodEnd: user.cancelAtPeriodEnd ?? false,
    };
  }),

  // ─── Terms acceptance ──────────────────────────────────────────────────────

  acceptTerms: appUserProcedure.mutation(async ({ ctx }) => {
    await updateAppUser(ctx.appUser.id, {
      termsAccepted: true,
      termsAcceptedAt: Date.now(),
    } as Parameters<typeof updateAppUser>[1]);
    return { success: true };
  }),

  // ─── Owner-only User Management ────────────────────────────────────────────

  listUsers: ownerProcedure.query(async () => {
    let users;
    try {
      users = await listAppUsers();
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error(`[AppAdmin][listUsers][FAIL] error=${msg}`);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to load users. Please refresh the page.' });
    }

    // Resolve the billing catalogue ONCE and index it, rather than per user.
    // Both tables are small (plans × prices), so this is a single extra round
    // trip regardless of headcount — no N+1.
    const catalogue = await loadBillingCatalogue();

    const now = Date.now();
    return users.map((u) => {
      // Resolve by priceId first: it identifies the exact SKU the member is on,
      // including which of several prices under the same plan. Fall back to the
      // plan slug so members provisioned before planPriceId existed still show
      // their plan instead of rendering as "no plan".
      const price = u.planPriceId != null ? catalogue.byPriceId.get(u.planPriceId) ?? null : null;
      const plan = price?.plan ?? (u.stripePlanId ? catalogue.byPlanSlug.get(u.stripePlanId) ?? null : null);

      // The documented entitlement predicate (USERS.md): hasAccess is the master
      // switch, NULL expiry means lifetime. Computed here so the table cannot
      // drift from the contract the server enforces.
      const entitled = Boolean(u.hasAccess) && (u.expiryDate == null || now <= u.expiryDate);

      return {
        id: u.id,
        email: u.email,
        username: u.username,
        role: u.role,
        hasAccess: u.hasAccess,
        expiryDate: u.expiryDate,
        createdAt: u.createdAt,
        lastSignedIn: u.lastSignedIn,
        termsAccepted: u.termsAccepted,
        termsAcceptedAt: u.termsAcceptedAt,
        discordId: u.discordId ?? null,
        discordUsername: u.discordUsername ?? null,
        discordConnectedAt: u.discordConnectedAt ?? null,
        manualDiscordId: u.manualDiscordId ?? null,

        // ── Entitlement, resolved ────────────────────────────────────────────
        entitled,
        planPriceId: u.planPriceId ?? null,
        /**
         * The real SKU. Previously the UI had none of this and inferred the
         * plan from `stripePlanId === 'annual' ? ANNUAL : MONTHLY`, which
         * labelled every lifetime member "MONTHLY" once plan slugs stopped
         * being the literal strings "monthly"/"annual".
         */
        plan: plan
          ? {
              slug: plan.slug,
              name: plan.name,
              planType: plan.planType,
              active: plan.active,
              priceId: price?.id ?? null,
              stripePriceId: price?.stripePriceId ?? null,
              amountCents: price?.amountCents ?? null,
              currency: price?.currency ?? null,
              billingInterval: price?.billingInterval ?? null,
              intervalCount: price?.intervalCount ?? null,
              /** No recurring interval on the price === a one-off / lifetime SKU. */
              isLifetime: price ? price.billingInterval == null : null,
              priceResolved: price != null,
            }
          : null,

        // ── Stripe linkage ───────────────────────────────────────────────────
        stripeCustomerId: u.stripeCustomerId ?? null,
        stripePlanId: u.stripePlanId ?? null,
        stripeSubscriptionId: u.stripeSubscriptionId ?? null,
        stripeSubscriptionStatus: u.stripeSubscriptionStatus ?? null,
        pendingStripeSessionId: u.pendingStripeSessionId ?? null,
        lastStripeEventAt: u.lastStripeEventAt ?? null,
        pendingSetup: u.pendingSetup ?? false,
        /**
         * How this member got access. "stripe" = a Stripe customer exists;
         * "manual" = granted directly in the database (comped, migrated, or a
         * repaired drop). Made explicit because the two are indistinguishable
         * from entitlement alone, and the distinction matters for revenue.
         */
        accessSource: u.stripeCustomerId ? ("stripe" as const) : ("manual" as const),
      };
    });
  }),

  // ─── Sync Discord role for a specific user (owner-only) ───────────────────────
  syncDiscordRole: ownerProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const TAG2 = `[AppAdmin][syncDiscordRole][userId=${input.userId}]`;
      console.log(`${TAG2} [INPUT] userId=${input.userId}`);
      const user = await getAppUserById(input.userId);
      if (!user) {
        console.error(`${TAG2} [VERIFY] FAIL — user not found`);
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }
      console.log(`${TAG2} [STATE] username=${user.username} hasAccess=${user.hasAccess} discordId=${user.discordId ?? '(none)'}`);
      // Import syncDiscordRoleForUser dynamically to avoid circular deps
      const { syncDiscordRoleForUser } = await import('../discord/discordRoleSync');
      const result = await syncDiscordRoleForUser(user, user.hasAccess);
      console.log(`${TAG2} [OUTPUT] action=${result.action} reason=${result.reason}`);
      console.log(`${TAG2} [VERIFY] ${result.action !== 'error' ? 'PASS' : 'FAIL — ' + result.reason}`);
      return result;
    }),

  createUser: ownerProcedure
    .input(z.object({
      email: z.string().email(),
      username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
      /**
       * Optional ONLY when generateClaimLink is true (resolveCreationPassword
       * enforces the rule): the member then sets their own password through the
       * claim link and the row holds a CSPRNG throwaway until they do.
       */
      password: z.string().min(8).optional(),
      role: z.enum(["owner", "admin", "handicapper", "user"]).default("user"),
      hasAccess: z.boolean().default(true),
      expiryDate: z.number().nullable().default(null), // null = lifetime; IGNORED when planPriceId is set (derived instead)
      /**
       * Mint a single-use, 7-day claim link (reset-token columns, sha256 at
       * rest) returned as `claimUrl` for the owner to send to the member.
       * `origin` scopes the URL to the site the admin is on (same pattern as
       * requestPasswordReset) — required when generateClaimLink is true.
       */
      generateClaimLink: z.boolean().default(false),
      origin: z.string().url().optional(),
      /**
       * Entitlement assignment, both optional and both defaulting to NULL.
       *
       * An admin-created member used to land with hasAccess=true but NO plan and
       * NO interval, which made them invisible to every plan/interval query
       * until someone backfilled by hand. These make it settable at creation.
       *
       * There is deliberately NO default plan here: choosing which plan a
       * hand-created account lands on is a pricing/policy decision the owner has
       * not delegated to this procedure. NULL means "unassigned", not "monthly".
       */
      stripePlanId: z.string().min(1).max(64).nullable().default(null),
      /** plan_prices.id — WHICH billing interval, not just which plan. */
      planPriceId: z.number().int().positive().nullable().default(null),
    }))
    .mutation(async ({ input }) => {
      console.log(`[AppAdmin][createUser][INPUT] email=${input.email} username=${input.username} role=${input.role} stripePlanId=${input.stripePlanId ?? "(none)"} planPriceId=${input.planPriceId ?? "(none)"} generateClaimLink=${input.generateClaimLink}`);

      // ── [STEP 0] Resolve entitlement + password BEFORE any DB write ────────
      // planPriceId is the single client-sent fact; slug and expiry are derived
      // server-side through the SAME computeExpiryMsForPrice the webhook uses,
      // so the modal cannot submit a plan/expiry combination the catalog does
      // not define. Legacy calls without planPriceId keep verbatim behaviour.
      let stripePlanId = input.stripePlanId;
      let expiryDate = input.expiryDate;
      if (input.planPriceId != null) {
        const derived = deriveEntitlementFromPrice(await listAllPlans(), input.planPriceId, Date.now());
        if (!derived.ok) throw new TRPCError({ code: "BAD_REQUEST", message: derived.error });
        stripePlanId = derived.entitlement.stripePlanId;
        expiryDate = derived.entitlement.expiryDate;
        console.log(`[AppAdmin][createUser][STATE] derived stripePlanId=${stripePlanId} expiryDate=${expiryDate ?? "null (lifetime)"}`);
      }

      const pw = resolveCreationPassword({ password: input.password, generateClaimLink: input.generateClaimLink });
      if (!pw.ok) throw new TRPCError({ code: "BAD_REQUEST", message: pw.error });
      if (input.generateClaimLink && !input.origin) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "origin is required to build the claim link." });
      }

      // ── retryOnce: automatically retry on TiDB cold-start transient errors ──
      return retryOnce(async () => {
        // [STEP 1] Parallel uniqueness checks — run concurrently to halve DB round-trips
        console.log(`[AppAdmin][createUser][STEP] parallel uniqueness checks`);
        const [existingEmail, existingUsername] = await Promise.all([
          getAppUserByEmail(input.email.toLowerCase()),
          getAppUserByUsername(input.username.toLowerCase()),
        ]);
        if (existingEmail) throw new TRPCError({ code: "CONFLICT", message: "Email already in use" });
        if (existingUsername) throw new TRPCError({ code: "CONFLICT", message: "Username already taken" });

        // [STEP 2] Hash password with cost=10 (OWASP-compliant, ~110ms vs ~250ms for cost=12)
        console.log(`[AppAdmin][createUser][STEP] hashing password cost=10 generated=${pw.generated}`);
        const passwordHash = await bcrypt.hash(pw.password, 10);
        console.log(`[AppAdmin][createUser][STATE] password hash OK`);

        // [STEP 3] Insert new user
        console.log(`[AppAdmin][createUser][STEP] inserting user email=${input.email} username=${input.username}`);
        await createAppUser({
          email: input.email.toLowerCase(),
          username: input.username.toLowerCase(),
          passwordHash,
          role: input.role,
          hasAccess: input.hasAccess,
          expiryDate: expiryDate ?? undefined,
          // Written verbatim — null included. This is one of only two paths that
          // INSERT into app_users (the other is the Stripe webhook), so what is
          // omitted here can only be repaired by a backfill.
          stripePlanId,
          planPriceId: input.planPriceId,
        });
        console.log(`[AppAdmin][createUser][OUTPUT] SUCCESS username=${input.username} stripePlanId=${stripePlanId ?? "null"} planPriceId=${input.planPriceId ?? "null"}`);

        // [STEP 4] Audit trail (avenues #5/#10). A hand-created account that
        // starts with access is a manual grant and must be as reconstructable
        // as a webhook grant — this row is what makes "why does this user have
        // access with no plan?" answerable from the database (the rudedog
        // question, 2026-08-01). Best-effort: recordEntitlementEvent never throws.
        const createdUser = await getAppUserByEmail(input.email.toLowerCase());
        if (createdUser) {
          await recordEntitlementEvent({
            userId: createdUser.id,
            stripeEventId: null,
            eventType: "admin.create_user",
            reason: "manual_create",
            actor: "owner",
            after: {
              hasAccess: input.hasAccess,
              planId: stripePlanId,
              expiryDate: expiryDate ?? null,
            },
          });
        }

        // [STEP 5] Claim link — single-use, 7-day, consumed by the existing
        // resetPassword mutation (only the sha256 hash is stored). Minted after
        // the insert so a token can never exist for an account that does not.
        let claimUrl: string | null = null;
        if (input.generateClaimLink && createdUser && input.origin) {
          const claim = mintClaimToken(Date.now());
          await updateAppUser(createdUser.id, {
            passwordResetToken: claim.tokenHash,
            passwordResetExpiresAt: claim.expiresAt,
          });
          claimUrl = buildClaimUrl(input.origin, createdUser.id, claim.rawToken);
          console.log(`[AppAdmin][createUser][STATE] claim link minted userId=${createdUser.id} expiresAt=${new Date(claim.expiresAt).toISOString()}`);
        }

        return {
          success: true,
          userId: createdUser?.id ?? null,
          claimUrl,
          entitlement: { stripePlanId: stripePlanId ?? null, planPriceId: input.planPriceId ?? null, expiryDate: expiryDate ?? null },
        };
      }, '[AppAdmin][createUser]').catch((err) => {
        if (err instanceof TRPCError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[AppAdmin][createUser][FAIL] username=${input.username} error=${msg}`);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create account. Please try again.',
        });
      });
    }),

  /**
   * backfillEntitlement — owner-only bulk assignment of a plan + billing
   * interval to every member that is missing it.
   *
   * WHY THIS EXISTS: nothing wrote app_users.planPriceId on the normal paths
   * until now, so members exist with a plan and a NULL interval — and
   * admin-created members exist with neither. Repairing that took an ad-hoc
   * script run by hand against production (2026-07-31, @suprax718). This is the
   * same repair, owner-authenticated, dry-runnable and re-runnable.
   *
   * Invariants:
   *  - role='user' ONLY. `admin` and `owner` rows are never touched: their
   *    access does not come from a subscription and giving them a plan slug
   *    would misreport paid seats.
   *  - expiryDate is NOT in the SET clause. NULL already means lifetime
   *    (drizzle/schema.ts); changing an expiry is a separate decision with its
   *    own blast radius, and a backfill must not smuggle one in.
   *  - Idempotent: the WHERE clause excludes rows that ALREADY hold exactly
   *    hasAccess=1 + this slug + this price id, so a second run matches nothing.
   *    That also makes retryOnce safe here.
   */
  backfillEntitlement: ownerProcedure
    .input(z.object({
      planSlug: z.string().min(1).max(64),
      planPriceId: z.number().int().positive(),
      /** Report what WOULD change and write nothing. */
      dryRun: z.boolean().optional().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const TAG = "[AppAdmin][backfillEntitlement]";
      console.log(`${TAG} [INPUT] planSlug=${input.planSlug} planPriceId=${input.planPriceId} dryRun=${input.dryRun} owner=${ctx.appUser.username}(id=${ctx.appUser.id})`);

      return retryOnce(async () => {
        const db = await getDb();
        if (!db) {
          console.error(`${TAG} [VERIFY] FAIL — DB unavailable`);
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable. Please try again.' });
        }

        // [STEP 1] "Missing this exact entitlement" — spelled out NULL-safely.
        // `planPriceId <> 7` is NULL (not TRUE) for a NULL row in SQL, so the
        // isNull() legs are required: without them the backfill would skip
        // precisely the rows it exists to fix.
        const missingEntitlement = and(
          eq(appUsersTable.role, "user"),
          or(
            eq(appUsersTable.hasAccess, false),
            isNull(appUsersTable.stripePlanId),
            ne(appUsersTable.stripePlanId, input.planSlug),
            isNull(appUsersTable.planPriceId),
            ne(appUsersTable.planPriceId, input.planPriceId),
          ),
        );

        // [STEP 2] Read the affected rows FIRST — the usernames are the whole
        // point of dryRun, and they are also what makes the write auditable.
        // Annotated: getDb()'s handle is loosely typed here, so the row shape
        // would otherwise land as implicit `any` in the map below.
        // hasAccess/plan/expiry ride along as the audit rows' BEFORE state —
        // captured in the same read that decides membership, so the trail can
        // never describe a row this query did not actually see.
        const rows: Array<{ id: number; username: string; hasAccess: boolean; stripePlanId: string | null; expiryDate: number | null }> = await db
          .select({
            id: appUsersTable.id,
            username: appUsersTable.username,
            hasAccess: appUsersTable.hasAccess,
            stripePlanId: appUsersTable.stripePlanId,
            expiryDate: appUsersTable.expiryDate,
          })
          .from(appUsersTable)
          .where(missingEntitlement);
        const usernames = rows.map((r) => r.username);
        console.log(`${TAG} [STATE] matched=${rows.length} usernames=${usernames.length ? usernames.join(",") : "(none)"}`);

        if (input.dryRun) {
          console.log(`${TAG} [OUTPUT] DRY RUN — no rows written matched=${rows.length}`);
          console.log(`${TAG} [VERIFY] PASS`);
          return { ok: true, matched: rows.length, updated: 0, usernames };
        }
        if (rows.length === 0) {
          console.log(`${TAG} [OUTPUT] Nothing to do — every role='user' row already holds this plan + interval`);
          console.log(`${TAG} [VERIFY] PASS`);
          return { ok: true, matched: 0, updated: 0, usernames };
        }

        // [STEP 3] One UPDATE over the SAME predicate. expiryDate is absent on
        // purpose (see the invariants above).
        const result = await db.update(appUsersTable).set({
          hasAccess: true,
          stripePlanId: input.planSlug,
          planPriceId: input.planPriceId,
        }).where(missingEntitlement);

        // mysql2 returns [ResultSetHeader, FieldPacket[]]; fall back to the
        // matched count rather than reporting an unknown number of writes.
        const header = (Array.isArray(result) ? result[0] : result) as { affectedRows?: number } | undefined;
        const updated = typeof header?.affectedRows === "number" ? header.affectedRows : rows.length;

        // [STEP 4] Entitlement is cached per user (30s by-id cache + the circuit
        // breaker's fallback copy). Without this the members just granted access
        // keep being served their pre-backfill state.
        for (const r of rows) {
          invalidateAppUserByIdCache(r.id);
          invalidateCachedAppUser(r.id);
        }

        // [STEP 5] Audit trail (avenues #5/#10): one row per repaired member.
        // The 2026-07-31 ad-hoc repair left no entitlement_events rows, which
        // is why "who was backfilled, when, by whom" needed an ops memory
        // instead of a query. Best-effort and sequential — this is an
        // owner-run, low-frequency path and recordEntitlementEvent never throws.
        //
        // `after` is READ BACK from the row, never asserted from the inputs:
        // this UPDATE deliberately leaves expiryDate alone, and afterExpiryDate
        // NULL means LIFETIME in this system — writing the input's shape would
        // stamp every backfilled member with a lifetime claim their row does
        // not hold. The read-back also keeps the trail honest when a concurrent
        // write made the UPDATE skip a matched row (updated < matched): the
        // row records whatever state the member ACTUALLY ended up in.
        for (const r of rows) {
          const fresh = await getAppUserById(r.id).catch(() => null);
          await recordEntitlementEvent({
            userId: r.id,
            stripeEventId: null,
            eventType: "admin.backfill_entitlement",
            reason: "backfill",
            actor: "owner",
            before: { hasAccess: r.hasAccess, planId: r.stripePlanId, expiryDate: r.expiryDate },
            after: fresh
              ? { hasAccess: fresh.hasAccess, planId: fresh.stripePlanId ?? null, expiryDate: fresh.expiryDate ?? null }
              : { hasAccess: true, planId: input.planSlug, expiryDate: r.expiryDate },
          });
        }

        console.log(`${TAG} [OUTPUT] matched=${rows.length} updated=${updated} planSlug=${input.planSlug} planPriceId=${input.planPriceId} (expiryDate untouched)`);
        console.log(`${TAG} [VERIFY] ${updated === rows.length ? 'PASS' : `PASS (updated=${updated} differs from matched=${rows.length} — concurrent writes)`}`);
        return { ok: true, matched: rows.length, updated, usernames };
      }, TAG).catch((err) => {
        if (err instanceof TRPCError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        console.error(`${TAG} [FAIL] planSlug=${input.planSlug} planPriceId=${input.planPriceId} error=${msg}`);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to backfill entitlements. Please try again.' });
      });
    }),

  updateUser: ownerProcedure
    .input(z.object({
      id: z.number().int().positive(),
      email: z.string().email().optional(),
      username: z.string().min(2).max(64).optional(),
      password: z.string().min(8).optional(),
      role: z.enum(["owner", "admin", "handicapper", "user"]).optional(),
      hasAccess: z.boolean().optional(),
      expiryDate: z.number().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, password, ...rest } = input;
      console.log(`[AppAdmin][updateUser][INPUT] userId=${id} fields=${JSON.stringify(Object.keys({ ...rest, ...(password ? { password: '***' } : {}) }))}`);
      // ── retryOnce: automatically retry on TiDB cold-start transient errors ──
      return retryOnce(async () => {
        // [STEP 1] Fetch existing user (required for uniqueness checks)
        const existing = await getAppUserById(id);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        console.log(`[AppAdmin][updateUser][STATE] found userId=${id} username=${existing.username}`);

        // [STEP 2] Parallel uniqueness checks — only if email/username is changing
        const emailChanging = !!(rest.email && rest.email.toLowerCase() !== existing.email);
        const usernameChanging = !!(rest.username && rest.username.toLowerCase() !== existing.username);
        if (emailChanging || usernameChanging) {
          const [emailConflict, usernameConflict] = await Promise.all([
            emailChanging ? getAppUserByEmail(rest.email!.toLowerCase()) : Promise.resolve(null),
            usernameChanging ? getAppUserByUsername(rest.username!.toLowerCase()) : Promise.resolve(null),
          ]);
          if (emailConflict) throw new TRPCError({ code: "CONFLICT", message: "Email already in use" });
          if (usernameConflict) throw new TRPCError({ code: "CONFLICT", message: "Username already taken" });
        }

        // [STEP 3] Build update payload
        const updateData: Record<string, unknown> = {};
        if (rest.email) updateData.email = rest.email.toLowerCase();
        if (rest.username) updateData.username = rest.username.toLowerCase();
        if (rest.role) updateData.role = rest.role;
        if (rest.hasAccess !== undefined) updateData.hasAccess = rest.hasAccess;
        if (rest.expiryDate !== undefined) updateData.expiryDate = rest.expiryDate;

        // [STEP 4] Hash password with cost=10 (OWASP-compliant, ~110ms vs ~250ms for cost=12)
        if (password) {
          console.log(`[AppAdmin][updateUser][STEP] hashing password userId=${id} cost=10`);
          updateData.passwordHash = await bcrypt.hash(password, 10);
          console.log(`[AppAdmin][updateUser][STATE] password hash OK`);
        }

        // [STEP 5] Write to DB
        console.log(`[AppAdmin][updateUser][STEP] writing fields=${JSON.stringify(Object.keys(updateData))} userId=${id}`);
        await updateAppUser(id, updateData as Parameters<typeof updateAppUser>[1]);
        console.log(`[AppAdmin][updateUser][OUTPUT] SUCCESS userId=${id}`);

        // [STEP 6] Audit trail (avenues #5/#10) — only when an entitlement
        // field actually moved. Email/username/password edits are identity
        // maintenance, not entitlement changes, and would bury the trail in
        // noise. Best-effort: recordEntitlementEvent never throws.
        const accessChanged = rest.hasAccess !== undefined && rest.hasAccess !== existing.hasAccess;
        const expiryChanged = rest.expiryDate !== undefined && rest.expiryDate !== (existing.expiryDate ?? null);
        if (accessChanged || expiryChanged) {
          await recordEntitlementEvent({
            userId: id,
            stripeEventId: null,
            eventType: "admin.update_user",
            reason: accessChanged
              ? (rest.hasAccess ? "manual_grant" : "manual_revoke")
              : "manual_expiry_change",
            actor: "owner",
            before: {
              hasAccess: existing.hasAccess,
              planId: existing.stripePlanId ?? null,
              expiryDate: existing.expiryDate ?? null,
            },
            after: {
              hasAccess: rest.hasAccess ?? existing.hasAccess,
              planId: existing.stripePlanId ?? null,
              expiryDate: rest.expiryDate !== undefined ? rest.expiryDate : (existing.expiryDate ?? null),
            },
          });
        }
        return { success: true };
      }, '[AppAdmin][updateUser]').catch((err) => {
        if (err instanceof TRPCError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[AppAdmin][updateUser][FAIL] userId=${id} error=${msg}`);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update account. Please try again.',
        });
      });
    }),

  deleteUser: ownerProcedure
    .input(z.object({
      id: z.number().int().positive(),
      /**
       * Permanently remove the row instead of retiring it. Refused when the
       * account owns anything, since nothing would clean those rows up.
       * Default (false) sets deletedAt: the account stops existing to the app,
       * its history stays attributed, and the action is reversible.
       */
      hard: z.boolean().optional().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.appUser.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete your own account" });
      }
      try {
        // Retire by default. A hard delete is opt-in and still refuses to strand
        // data — with soft delete available that refusal costs nothing, because
        // "retire it instead" is now a real option that keeps the history.
        if (input.hard) {
          await deleteAppUser(input.id);
        } else {
          await softDeleteAppUser(input.id);
        }
      } catch (err) {
        // Refusal, not a fault: the account owns rows that nothing would clean
        // up. See appUserDeletion.ts — this is the guard that stops another
        // 60002 (278 verified bets stranded by a hard delete).
        if (err instanceof AppUserHasDataError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[AppAdmin] deleteUser: DB error for userId=${input.id}: ${msg}`);
        if (msg.includes('Circuit is OPEN') || msg.includes('Database not available') || msg.includes('timed out')) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database temporarily unavailable. Please try again in a moment.' });
        }
        throw err;
      }
      return { success: true };
    }),

  // ─── Session Invalidation ──────────────────────────────────────────────────

  /**
   * Force-logout a specific user by incrementing their tokenVersion.
   * Their existing JWT will be rejected on next request (tv mismatch).
   * The owner's own session is NOT affected.
   */
  forceLogoutUser: ownerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.appUser.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot force-logout your own account" });
      }
      try {
        const user = await getAppUserById(input.id);
        if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        const newTv = await incrementTokenVersion(input.id);
        console.log(`[AppAuth] forceLogoutUser: userId=${input.id} username=${user.username} — tokenVersion incremented to ${newTv}`);
        return { success: true, newTokenVersion: newTv };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[AppAdmin][forceLogoutUser][FAIL] userId=${input.id} error=${msg}`);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to force logout. Please try again.' });
      }
    }),

  /**
   * Force-logout ALL users EXCEPT the current owner.
   * Increments tokenVersion for every user whose id != ctx.appUser.id.
   * The owner stays logged in; all other sessions are immediately invalidated.
   */
  forceLogoutAll: ownerProcedure
    .mutation(async ({ ctx }) => {
      try {
        const count = await incrementAllTokenVersions(ctx.appUser.id);
        console.log(`[AppAuth] forceLogoutAll: invalidated sessions for ${count} users (excluded owner userId=${ctx.appUser.id})`);
        return { success: true, usersAffected: count };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[AppAdmin][forceLogoutAll][FAIL] error=${msg}`);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to force logout all users. Please try again.' });
      }
    }),

  // ─── Discord Admin Controls ────────────────────────────────────────────────
  /**
   * OWNER-ONLY: Disconnect a user's Discord account.
   *
   * POLICY: Users cannot disconnect their own Discord — once linked, it is
   * permanent from the user's perspective. Only the owner (@prez) can unlink
   * a Discord account via the User Management admin panel.
   *
   * CHECKPOINT:ADMIN_DISCORD_DISCONNECT — logs who disconnected whom and when.
   */
  adminDisconnectDiscord: ownerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      console.log(`[CHECKPOINT:ADMIN_DISCORD_DISCONNECT.1] ` +
        `owner=${ctx.appUser.username}(id=${ctx.appUser.id}) ` +
        `target=userId(${input.id}) ` +
        `action=UNLINK_DISCORD ` +
        `timestamp=${new Date().toISOString()}`);

      const user = await getAppUserById(input.id);
      if (!user) {
        console.log(`[CHECKPOINT:ADMIN_DISCORD_DISCONNECT.ERR] userId=${input.id} NOT_FOUND`);
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      if (!user.discordId) {
        console.log(`[CHECKPOINT:ADMIN_DISCORD_DISCONNECT.SKIP] userId=${input.id} username=${user.username} — no Discord linked, nothing to do`);
        throw new TRPCError({ code: "BAD_REQUEST", message: "This user has no Discord account linked" });
      }

      console.log(`[CHECKPOINT:ADMIN_DISCORD_DISCONNECT.2] ` +
        `unlinking discordId=${user.discordId} discordUsername=${user.discordUsername} ` +
        `from userId=${input.id} username=${user.username}`);

      try {
        await updateAppUser(input.id, {
          discordId: null,
          discordUsername: null,
          discordAvatar: null,
          discordConnectedAt: null,
        });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[CHECKPOINT:ADMIN_DISCORD_DISCONNECT.DB_FAIL] userId=${input.id} error=${msg}`);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to disconnect Discord. Please try again.' });
      }

      console.log(`[CHECKPOINT:ADMIN_DISCORD_DISCONNECT.SUCCESS] ` +
        `userId=${input.id} username=${user.username} ` +
        `previousDiscordId=${user.discordId} previousDiscordUsername=${user.discordUsername} ` +
        `unlinkedBy=owner(${ctx.appUser.username}) ` +
        `timestamp=${new Date().toISOString()}`);

      return {
        success: true,
        unlinkedDiscordId: user.discordId,
        unlinkedDiscordUsername: user.discordUsername,
      };
    }),

  // ─── Discord Invite Link Generation ───────────────────────────────────────
  /**
   * generateDiscordInvite
   *
   * OWNER-ONLY: Generate a unique, single-use Discord invite link for a user
   * who has no Discord account linked. The link is valid for 7 days.
   *
   * Security invariants:
   *   - Token is 32 random bytes (256-bit entropy) — brute force infeasible
   *   - Single-use: token is marked used on first successful callback
   *   - Expires after 7 days
   *   - Bound to a specific userId (targetUserId)
   *   - Only one active token per user (old tokens revoked on new generation)
   *
   * [INPUT]  userId  — the app_users.id to generate the invite for
   * [INPUT]  origin  — the frontend origin for building the invite URL
   * [OUTPUT] { inviteUrl: string, expiresAt: number }
   */
  generateDiscordInvite: ownerProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      origin: z.string().url(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { userId, origin } = input;
      const requestId = Math.random().toString(36).slice(2, 8).toUpperCase();

      console.log(
        `[DiscordInvite][GENERATE][INPUT] requestId=${requestId}` +
        ` owner=${ctx.appUser.username}(id=${ctx.appUser.id})` +
        ` targetUserId=${userId}`
      );

      // [STEP 1] Verify target user exists
      const user = await getAppUserById(userId);
      if (!user) {
        console.warn(`[DiscordInvite][GENERATE][FAIL] requestId=${requestId} userId=${userId} NOT_FOUND`);
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      // [STEP 2] Check if user already has Discord linked
      if (user.discordId) {
        console.warn(
          `[DiscordInvite][GENERATE][FAIL] requestId=${requestId}` +
          ` userId=${userId} username=${user.username} already has discordId=${user.discordId}`
        );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This user already has a Discord account linked. Disconnect it first.",
        });
      }

      // [STEP 3] Get DB connection
      const db = await getDb();
      if (!db) {
        console.error(`[DiscordInvite][GENERATE][FAIL] requestId=${requestId} DB unavailable`);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable. Please try again." });
      }

      // [STEP 4] Revoke any existing active tokens for this user (single active token per user)
      await db
        .delete(discordInviteTokens)
        .where(
          and(
            eq(discordInviteTokens.targetUserId, userId),
            isNull(discordInviteTokens.usedAt)
          )
        );
      console.log(
        `[DiscordInvite][GENERATE][STATE] requestId=${requestId}` +
        ` revoked previous active tokens for userId=${userId}`
      );

      // [STEP 5] Generate cryptographically random 32-byte token (64 hex chars)
      const token = crypto.randomBytes(32).toString("hex");
      const now = Date.now();
      const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days

      // [STEP 6] Insert the new invite token
      await db.insert(discordInviteTokens).values({
        token,
        targetUserId: userId,
        expiresAt,
        createdAt: now,
        usedAt: null,
        linkedDiscordId: null,
        createdBy: ctx.appUser.id,
      });

      // [STEP 7] Build the invite URL
      const cleanOrigin = origin.replace(/\/$/, "");
      const inviteUrl = `${cleanOrigin}/api/auth/discord-invite/connect?token=${token}`;

      console.log(
        `[DiscordInvite][GENERATE][OUTPUT] requestId=${requestId}` +
        ` SUCCESS userId=${userId} username=${user.username}` +
        ` tokenPrefix=${token.slice(0, 8)}... expiresAt=${new Date(expiresAt).toISOString()}`
      );

      return { inviteUrl, expiresAt };
    }),

  // ─── Forgot Password ──────────────────────────────────────────────────────
  /**
   * requestPasswordReset
   *
   * Generates a 30-minute password reset token and delivers it via:
   *   1. Discord DM (if the user has Discord linked and the bot is running)
   *   2. Owner notification (fallback — owner relays the link manually)
   *
   * Security design:
   *   - Token is a 32-byte CSPRNG secret, stored as SHA-256 hex in the DB.
   *   - The raw token (never stored) is sent to the user; the server only
   *     stores the hash. This means a DB breach cannot be used to reset passwords.
   *   - Rate-limited: max 3 requests per email per 15 minutes (in-memory).
   *   - Always returns success=true regardless of whether the email exists
   *     (prevents user enumeration).
   *
   * [INPUT]  emailOrUsername — the user's email or username
   * [INPUT]  origin          — the frontend origin for building the reset URL
   * [OUTPUT] { success: true } always (no enumeration)
   */
  requestPasswordReset: publicProcedure
    .input(z.object({
      emailOrUsername: z.string().min(1).max(320),
      origin: z.string().url(),
    }))
    .mutation(async ({ input }) => {
      const ident = input.emailOrUsername.trim().toLowerCase().replace(/^@/, "");
      console.log(`[PasswordReset] requestPasswordReset | ident=${ident}`);

      // [STEP] Rate-limit: max 3 reset requests per identifier per 15 minutes
      const now = Date.now();
      const RATE_WINDOW_MS = 15 * 60 * 1000;
      const RATE_MAX = 3;
      const existing = resetRateMap.get(ident);
      if (existing) {
        // Prune expired entries
        existing.timestamps = existing.timestamps.filter(t => now - t < RATE_WINDOW_MS);
        if (existing.timestamps.length >= RATE_MAX) {
          console.warn(`[PasswordReset] RATE_LIMIT | ident=${ident} count=${existing.timestamps.length}`);
          // Return success to prevent enumeration — silently drop
          return { success: true };
        }
        existing.timestamps.push(now);
      } else {
        resetRateMap.set(ident, { timestamps: [now] });
      }

      // [STEP] Look up user by email or username
      const isEmail = ident.includes("@");
      const user = isEmail
        ? await getAppUserByEmail(ident)
        : await getAppUserByUsername(ident);

      if (!user) {
        // [VERIFY] User not found — return success to prevent enumeration
        console.log(`[PasswordReset] user not found for ident=${ident} — returning success (anti-enumeration)`);
        return { success: true };
      }

      // [STEP] Generate CSPRNG token (32 bytes = 256 bits of entropy)
      const rawToken = crypto.randomBytes(32).toString("hex"); // 64 hex chars
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = now + 30 * 60 * 1000; // 30 minutes

      console.log(`[PasswordReset] Generated token | userId=${user.id} username=${user.username} expiresAt=${new Date(expiresAt).toISOString()}`);

      // [STEP] Store hash in DB
      await updateAppUser(user.id, {
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: expiresAt,
      });

      // [STEP] Build reset URL with raw token
      const origin = input.origin.replace(/\/$/, "");
      const resetUrl = `${origin}/reset-password?token=${rawToken}&uid=${user.id}`;

      // [STEP] Send branded password reset email via Google Workspace SMTP
      // Primary delivery: email to user's registered address
      // Fallback: Discord DM (if linked and bot is running)
      const { sendPasswordResetEmail } = await import('../email');
      let emailDelivered = false;
      try {
        await sendPasswordResetEmail({
          toEmail: user.email,
          username: user.username,
          resetUrl,
          expiresAt: new Date(expiresAt),
        });
        emailDelivered = true;
        console.log(`[PasswordReset] [STATE] Email delivered to ${user.email} userId=${user.id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PasswordReset] Email delivery failed | userId=${user.id} error=${msg}`);
      }

      // [STEP] Discord DM fallback (only if email delivery failed)
      let dmDelivered = false;
      if (!emailDelivered && user.discordId) {
        try {
          const discordClient = getDiscordClient();
          if (discordClient) {
            const dmChannel = await discordClient.users.createDM(user.discordId);
            await dmChannel.send(
              `🔐 **Password Reset — AI Sports Betting**\n\n` +
              `A password reset was requested for **@${user.username}**.\n` +
              `Click the link below to reset your password (expires in 30 minutes):\n\n` +
              `${resetUrl}\n\n` +
              `If you did not request this, ignore this message.`
            );
            dmDelivered = true;
            console.log(`[PasswordReset] Discord DM fallback delivered | userId=${user.id} discordId=${user.discordId}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[PasswordReset] Discord DM fallback failed | userId=${user.id} error=${msg}`);
        }
      }

      console.log(`[PasswordReset] [OUTPUT] success | userId=${user.id} username=${user.username} emailDelivered=${emailDelivered} dmDelivered=${dmDelivered}`);
      return { success: true };
    }),

  /**
   * resetPassword
   *
   * Validates the reset token and sets a new password.
   *
   * Security design:
   *   - Token is validated by SHA-256 hashing the raw input and comparing to the stored hash.
   *   - Token is single-use: cleared from DB immediately after successful reset.
   *   - Expired tokens are rejected.
   *   - After reset, all existing sessions are invalidated (tokenVersion increment).
   *
   * [INPUT]  uid      — app_users.id (from URL param)
   * [INPUT]  token    — raw 64-hex reset token (from URL param)
   * [INPUT]  password — new password (min 8 chars)
   * [OUTPUT] { success: true } on success
   */
  resetPassword: publicProcedure
    .input(z.object({
      uid: z.number().int().positive(),
      /**
       * Two token eras, one consumer: legacy 64-hex reset tokens and compact
       * 22-char base64url invite tokens (adminAccountProvisioning.mintClaimToken).
       * Validation is format-only — authenticity is the sha256 comparison below.
       */
      token: z.string().min(20).max(64).regex(/^[0-9a-zA-Z_-]+$/, "Invalid token format"),
      password: z.string().min(8, "Password must be at least 8 characters"),
    }))
    .mutation(async ({ input, ctx }) => {
      console.log(`[PasswordReset] resetPassword | uid=${input.uid}`);

      // [STEP] Load user
      const user = await getAppUserById(input.uid);
      if (!user) {
        console.warn(`[PasswordReset] resetPassword | user not found | uid=${input.uid}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset link." });
      }

      // [STEP] Validate token exists
      if (!user.passwordResetToken || !user.passwordResetExpiresAt) {
        console.warn(`[PasswordReset] resetPassword | no pending reset | uid=${input.uid}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset link." });
      }

      // [STEP] Check expiry
      const now = Date.now();
      if (now > user.passwordResetExpiresAt) {
        console.warn(`[PasswordReset] resetPassword | token expired | uid=${input.uid} expiredAt=${new Date(user.passwordResetExpiresAt).toISOString()}`);
        // Clear expired token
        await updateAppUser(input.uid, { passwordResetToken: null, passwordResetExpiresAt: null });
        throw new TRPCError({ code: "BAD_REQUEST", message: "Reset link has expired. Please request a new one." });
      }

      // [STEP] Validate token hash
      const inputHash = crypto.createHash("sha256").update(input.token).digest("hex");
      const tokenValid = inputHash === user.passwordResetToken;
      if (!tokenValid) {
        console.warn(`[PasswordReset] resetPassword | token mismatch | uid=${input.uid}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset link." });
      }

      // [STEP] Hash new password (cost=10: OWASP-compliant, ~110ms vs ~250ms for cost=12)
      const passwordHash = await bcrypt.hash(input.password, 10);

      // [STEP] Update password, clear reset token, invalidate all sessions.
      // Also CLEAR any per-account lockout: a password reset is the sanctioned
      // recovery path for a user who got locked out (their own fat-fingering or
      // a targeted lockout attempt), so it must lift the lock immediately.
      await updateAppUser(input.uid, {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        failedLoginCount: 0,
        firstFailedLoginAt: null,
        lockedUntil: null,
      });
      // Invalidate all existing sessions by incrementing tokenVersion
      const newTokenVersion = await incrementTokenVersion(input.uid);
      invalidateCachedAppUser(input.uid);

      // [STEP] Auto-login: possession of the single-use token + a fresh
      // password is the same trust basis completeAccountSetup already logs in
      // on. Signed with the NEW tokenVersion (old sessions stay dead). This is
      // what makes the invite claim seamless: set password → signed in → the
      // "Connect Discord" CTA on the welcome screen works immediately.
      const token = await signAppUserToken(input.uid, user.role, newTokenVersion);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(APP_USER_COOKIE, token, {
        ...cookieOptions,
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days — same as completeAccountSetup
      });

      console.log(`[PasswordReset] [OUTPUT] success | uid=${input.uid} username=${user.username} sessionsInvalidated=true autoLoggedIn=true`);
      return { success: true, autoLoggedIn: true };
    }),
  // ─── Manual Discord ID Pre-Registration ─────────────────────────────────────
  /*
   * setManualDiscordId (IMMEDIATE CONNECT)
   *
   * OWNER-ONLY: Given a Discord snowflake ID, immediately:
   *   1. Validate the snowflake format (17-20 digits)
   *   2. Resolve the Discord username via Bot API GET /users/{id}
   *   3. Check uniqueness against all existing discordId + manualDiscordId values
   *   4. Write discordId + discordUsername + discordAvatar + discordConnectedAt
   *      directly to the app_users row — NO login required from the user.
   *   5. Clear manualDiscordId (no longer needed — account is fully connected)
   *
   * RESULT: The DISCORD USERNAME column shows @username immediately, the
   *         DISCORD STATUS shows "Connected", and the user can log in via Discord
   *         on their next visit without any additional steps.
   *
   * VALIDATION:
   *   - Snowflake must be 17-20 digits (Discord spec)
   *   - Discord Bot API must return a valid user profile for the ID
   *   - Must not already be live discordId on ANY user (prevents account takeover)
   *   - Target user must not already have a live discordId (disconnect first)
   *   - Pass empty string to CLEAR a previously set manualDiscordId
   *
   * [INPUT]  userId    - app_users.id to connect
   * [INPUT]  discordId - Discord snowflake string (17-20 digits), or empty string to clear
   * [OUTPUT] { success: true, userId, discordId, discordUsername, immediate: true }
   */
  setManualDiscordId: ownerProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      discordId: z.string().max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      const requestId = crypto.randomBytes(4).toString("hex");
      const { userId, discordId: rawInput } = input;
      const trimmed = rawInput.trim();
      const isClear = trimmed === "";

      console.log(
        `[AdminDiscordConnect][INPUT] requestId=${requestId}` +
        ` owner=${ctx.appUser.username}(id=${ctx.appUser.id})` +
        ` targetUserId=${userId} rawInput="${rawInput}" isClear=${isClear}`
      );

      // ── CP-1: Validate snowflake format (skip if clearing) ─────────────────
      if (!isClear) {
        const SNOWFLAKE_RE = /^\d{17,20}$/;
        if (!SNOWFLAKE_RE.test(trimmed)) {
          console.warn(
            `[AdminDiscordConnect][VALIDATE_FAIL] requestId=${requestId}` +
            ` value="${trimmed}" reason=NOT_A_SNOWFLAKE (must be 17-20 digits)`
          );
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid Discord ID. Must be a 17-20 digit snowflake (e.g. 123456789012345678).",
          });
        }
        console.log(
          `[AdminDiscordConnect][VALIDATE_OK] requestId=${requestId}` +
          ` snowflake="${trimmed}" length=${trimmed.length}`
        );
      }

      // ── CP-2: Load target user ──────────────────────────────────────────────
      const user = await getAppUserById(userId);
      if (!user) {
        console.error(
          `[AdminDiscordConnect][USER_NOT_FOUND] requestId=${requestId} userId=${userId}`
        );
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      }
      console.log(
        `[AdminDiscordConnect][STATE] requestId=${requestId}` +
        ` username=${user.username} currentDiscordId=${user.discordId ?? "null"}` +
        ` currentManualDiscordId=${user.manualDiscordId ?? "null"}`
      );

      // ── CP-3: Guard — target user already has a live discordId ─────────────
      if (!isClear && user.discordId) {
        console.warn(
          `[AdminDiscordConnect][ALREADY_LINKED] requestId=${requestId}` +
          ` userId=${userId} username=${user.username}` +
          ` existingDiscordId=${user.discordId}` +
          ` action=REJECTED (use adminDisconnectDiscord first)`
        );
        throw new TRPCError({
          code: "CONFLICT",
          message: `User @${user.username} already has Discord @${user.discordUsername ?? user.discordId} linked. Disconnect it first.`,
        });
      }

      // ── CP-4: Uniqueness check — snowflake must not exist on any other user ─
      if (!isClear) {
        const db = await getDb();
        if (!db) {
          console.error(`[AdminDiscordConnect][DB_FAIL] requestId=${requestId} DB unavailable`);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable." });
        }
        const conflicts = await db
          .select({ id: appUsersTable.id, username: appUsersTable.username })
          .from(appUsersTable)
          .where(
            or(
              eq(appUsersTable.discordId, trimmed),
              eq(appUsersTable.manualDiscordId, trimmed)
            )
          )
          .limit(5);

        const otherConflicts = conflicts.filter((r: { id: number; username: string }) => r.id !== userId);
        if (otherConflicts.length > 0) {
          const conflictUser = otherConflicts[0]!;
          console.warn(
            `[AdminDiscordConnect][CONFLICT] requestId=${requestId}` +
            ` snowflake="${trimmed}" already exists on userId=${conflictUser.id}` +
            ` username=${conflictUser.username}`
          );
          throw new TRPCError({
            code: "CONFLICT",
            message: `Discord ID ${trimmed} is already registered to another user (@${conflictUser.username}).`,
          });
        }
        console.log(
          `[AdminDiscordConnect][UNIQUENESS_OK] requestId=${requestId}` +
          ` snowflake="${trimmed}" no conflicts found`
        );
      }

      // ── CP-5: CLEAR path — remove discordId + manualDiscordId ──────────────
      if (isClear) {
        try {
          await updateAppUser(userId, {
            manualDiscordId: null,
          });
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          console.error(
            `[AdminDiscordConnect][CLEAR_FAIL] requestId=${requestId}` +
            ` userId=${userId} error=${msg}`
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to clear Discord ID. Please try again.",
          });
        }
        console.log(
          `[AdminDiscordConnect][CLEAR_SUCCESS] requestId=${requestId}` +
          ` userId=${userId} username=${user.username}` +
          ` clearedBy=owner(${ctx.appUser.username})`
        );
        return { success: true, userId, discordId: null, discordUsername: null, immediate: false };
      }

      // ── CP-6: Resolve Discord username via Bot API ──────────────────────────
      // Uses Bot token to call GET /users/{snowflake} — no OAuth flow needed.
      // Returns: { id, username, discriminator, global_name, avatar, ... }
      const DISCORD_API = "https://discord.com/api/v10";
      const botToken = ENV.discordBotToken;

      if (!botToken) {
        // Bot token not configured — fall back to manualDiscordId (pending) mode
        console.warn(
          `[AdminDiscordConnect][BOT_TOKEN_MISSING] requestId=${requestId}` +
          ` DISCORD_BOT_TOKEN not set — falling back to manualDiscordId pending mode`
        );
        await updateAppUser(userId, { manualDiscordId: trimmed });
        return { success: true, userId, discordId: null, discordUsername: null, immediate: false, pending: true };
      }

      console.log(
        `[AdminDiscordConnect][BOT_LOOKUP_START] requestId=${requestId}` +
        ` snowflake="${trimmed}" endpoint=GET ${DISCORD_API}/users/${trimmed}`
      );

      let discordProfile: {
        id: string;
        username: string;
        discriminator: string;
        global_name: string | null;
        avatar: string | null;
      };

      try {
        const t_bot = Date.now();
        const botRes = await fetch(`${DISCORD_API}/users/${trimmed}`, {
          headers: {
            Authorization: `Bot ${botToken}`,
            "User-Agent": "AISportsBetting/1.0",
          },
        });

        const botMs = Date.now() - t_bot;
        console.log(
          `[AdminDiscordConnect][BOT_LOOKUP_RESPONSE] requestId=${requestId}` +
          ` status=${botRes.status} latencyMs=${botMs}`
        );

        if (!botRes.ok) {
          const errBody = await botRes.text().catch(() => "(unreadable)");
          console.error(
            `[AdminDiscordConnect][BOT_LOOKUP_FAIL] requestId=${requestId}` +
            ` status=${botRes.status} body="${errBody.slice(0, 200)}"` +
            ` snowflake="${trimmed}"`
          );
          if (botRes.status === 404) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Discord user ID ${trimmed} does not exist. Please verify the ID is correct.`,
            });
          }
          if (botRes.status === 401 || botRes.status === 403) {
            console.error(
              `[AdminDiscordConnect][BOT_TOKEN_INVALID] requestId=${requestId}` +
              ` status=${botRes.status} — Bot token is expired or revoked.` +
              ` ACTION: Regenerate the token at discord.com/developers/applications and update DISCORD_BOT_TOKEN secret.`
            );
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Discord Bot token is expired or revoked. Please regenerate it in the Discord Developer Portal and update the DISCORD_BOT_TOKEN secret.",
            });
          }
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Discord API returned ${botRes.status}. Please try again.`,
          });
        }

        discordProfile = await botRes.json() as typeof discordProfile;
        console.log(
          `[AdminDiscordConnect][BOT_LOOKUP_OK] requestId=${requestId}` +
          ` id="${discordProfile.id}" username="${discordProfile.username}"` +
          ` global_name="${discordProfile.global_name ?? "null"}"` +
          ` discriminator="${discordProfile.discriminator}" latencyMs=${botMs}`
        );
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        console.error(
          `[AdminDiscordConnect][BOT_LOOKUP_EXCEPTION] requestId=${requestId}` +
          ` error="${msg}"`
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to reach Discord API. Please try again.",
        });
      }

      // ── CP-7: Derive display username (same logic as discordLogin.ts) ────────
      const resolvedDiscordId = discordProfile.id;
      const resolvedUsername = (discordProfile.discriminator && discordProfile.discriminator !== "0")
        ? `${discordProfile.username}#${discordProfile.discriminator}`
        : (discordProfile.global_name || discordProfile.username);
      const resolvedAvatar = discordProfile.avatar ?? null;

      console.log(
        `[AdminDiscordConnect][RESOLVED_USERNAME] requestId=${requestId}` +
        ` resolvedDiscordId="${resolvedDiscordId}" resolvedUsername="${resolvedUsername}"` +
        ` resolvedAvatar="${resolvedAvatar ?? "null"}"`
      );

      // Sanity check: resolved ID must match the input snowflake
      if (resolvedDiscordId !== trimmed) {
        console.error(
          `[AdminDiscordConnect][ID_MISMATCH] requestId=${requestId}` +
          ` input="${trimmed}" resolved="${resolvedDiscordId}" — CRITICAL mismatch`
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Discord API returned unexpected user ID. Please try again.",
        });
      }

      // ── CP-8: Write full Discord connection to DB ────────────────────────────
      // Sets discordId, discordUsername, discordAvatar, discordConnectedAt
      // Clears manualDiscordId (no longer needed — account is fully connected)
      try {
        await updateAppUser(userId, {
          discordId: resolvedDiscordId,
          discordUsername: resolvedUsername,
          discordAvatar: resolvedAvatar,
          discordConnectedAt: Date.now(),
          manualDiscordId: null,
        });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.error(
          `[AdminDiscordConnect][DB_WRITE_FAIL] requestId=${requestId}` +
          ` userId=${userId} error="${msg}"`
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to save Discord connection. Please try again.",
        });
      }

      // Invalidate cache so next request picks up the new discordId
      invalidateCachedAppUser(userId);

      console.log(
        `[AdminDiscordConnect][SUCCESS] requestId=${requestId}` +
        ` userId=${userId} username=${user.username}` +
        ` discordId="${resolvedDiscordId}" discordUsername="${resolvedUsername}"` +
        ` connectedBy=owner(${ctx.appUser.username})` +
        ` timestamp=${new Date().toISOString()}`
      );

      return {
        success: true,
        userId,
        discordId: resolvedDiscordId,
        discordUsername: resolvedUsername,
        immediate: true,
      };
    }),

});

// ─── Password reset rate-limit map ────────────────────────────────────────────
// In-memory map: identifier (email/username) → list of request timestamps
// Pruned on each access; not persisted across restarts (intentional — restart clears limits)
const resetRateMap = new Map<string, { timestamps: number[] }>();

// ─── Login rate-limit map ─────────────────────────────────────────────────────
/**
 * In-memory rate limiter for the login endpoint.
 *
 * Tracks failed login attempts per IP address.
 * Key: IP address string
 * Value: array of UTC timestamps (ms) of failed attempts
 *
 * Limits:
 *   - Max 10 failed attempts per IP per 15-minute window
 *   - On breach: throw TRPCError FORBIDDEN (429-equivalent) and log security event
 *   - Successful login does NOT reset the counter (prevents bypass via success)
 *   - Counter resets naturally as old timestamps fall outside the 15-min window
 *
 * Design notes:
 *   - In-memory only — cleared on server restart (intentional: restarts are rare,
 *     and persistent storage would add latency to every login attempt)
 *   - Per-IP, not per-account — prevents distributed attacks targeting one account
 *     from different IPs, and prevents account enumeration via rate limit responses
 *   - The limit is applied BEFORE password check to prevent timing attacks
 */
export const loginRateMap = new Map<string, { failTimestamps: number[] }>();

export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_RATE_MAX_FAILURES = 10;           // max failures per window

/**
 * Check and record a login attempt for the given IP.
 *
 * [INPUT]  ip      — client IP address
 * [OUTPUT] boolean — true if the attempt is allowed, false if rate-limited
 *
 * Side effect: appends the current timestamp to the failure list if allowed.
 * Call this BEFORE the password check; call recordLoginFailure() on auth failure.
 */
export function checkLoginRateLimit(ip: string): { allowed: boolean; remainingAttempts: number; lockoutUntil: number | null } {
  const now = Date.now();
  const entry = loginRateMap.get(ip);

  if (!entry) {
    // First attempt from this IP — allow
    return { allowed: true, remainingAttempts: LOGIN_RATE_MAX_FAILURES, lockoutUntil: null };
  }

  // Prune expired timestamps
  entry.failTimestamps = entry.failTimestamps.filter(t => now - t < LOGIN_RATE_WINDOW_MS);

  if (entry.failTimestamps.length >= LOGIN_RATE_MAX_FAILURES) {
    const oldestFailure = Math.min(...entry.failTimestamps);
    const windowResetMs = LOGIN_RATE_WINDOW_MS - (now - oldestFailure);
    const windowResetMin = Math.ceil(windowResetMs / 60_000);
    console.warn(
      `[LoginRateLimit] BLOCKED | IP=${logSafe(ip)} failures=${entry.failTimestamps.length} ` +
      `windowResetIn=${windowResetMin}min`
    );
    const lockoutUntil = oldestFailure + LOGIN_RATE_WINDOW_MS;
    return { allowed: false, remainingAttempts: 0, lockoutUntil };
  }

  return { allowed: true, remainingAttempts: LOGIN_RATE_MAX_FAILURES - entry.failTimestamps.length, lockoutUntil: null };
}

/**
 * Record a failed login attempt for the given IP.
 * Call this after a confirmed auth failure (wrong password, user not found, etc.).
 */
export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginRateMap.get(ip);
  if (entry) {
    entry.failTimestamps.push(now);
  } else {
    loginRateMap.set(ip, { failTimestamps: [now] });
  }
}
