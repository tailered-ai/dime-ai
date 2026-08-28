/**
 * machineAuth.ts — Tailered OS sports-read machine principal.
 *
 * Distinct from CRON_SECRET (write/trigger). Fail-closed. No cookie impersonation.
 * Headers: Authorization: Bearer <secret> | x-tailered-sports-secret
 */

import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import { TRPCError } from "@trpc/server";
import { publicProcedure } from "./trpc";
import { getAppCookie, verifyAppUserToken, APP_USER_COOKIE } from "../routers/appUsers";
import { getAppUserById } from "../db";
import { getCachedAppUser, setCachedAppUser } from "../dbCircuitBreaker";

export const SPORTS_READ_SECRET_ENV = "TAILERED_OS_SPORTS_READ_SECRET";
export const SPORTS_READ_HEADER = "x-tailered-sports-secret";

export type SportsReadAuthResult =
  | { ok: true; principal: "machine" }
  | { ok: false; status: 401 | 503; error: string };

interface HeadersBag {
  headers: Record<string, string | string[] | undefined>;
}

function extractPresentedToken(req: HeadersBag): string | null {
  const raw = req.headers ?? {};
  const x = raw[SPORTS_READ_HEADER];
  if (typeof x === "string" && x.length > 0) return x.trim();

  const authz = raw["authorization"] ?? raw["Authorization"];
  const authStr = Array.isArray(authz) ? authz[0] : authz;
  if (typeof authStr === "string") {
    const trimmed = authStr.trim();
    if (/^Bearer\s/i.test(trimmed)) {
      const token = trimmed.slice("Bearer".length).trim();
      if (token.length > 0) return token;
    }
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Pure verifier — unit-testable. */
export function verifySportsReadSecret(req: HeadersBag): SportsReadAuthResult {
  const secret = process.env[SPORTS_READ_SECRET_ENV];
  if (!secret || secret.length === 0) {
    return { ok: false, status: 503, error: "sports-read-not-configured" };
  }
  const presented = extractPresentedToken(req);
  if (!presented) {
    return { ok: false, status: 401, error: "missing-sports-read-secret" };
  }
  if (!constantTimeEqual(presented, secret)) {
    return { ok: false, status: 401, error: "invalid-sports-read-secret" };
  }
  return { ok: true, principal: "machine" };
}

export function isMachineSportsReadRequest(req: Request | HeadersBag): boolean {
  const r = verifySportsReadSecret(req as HeadersBag);
  return r.ok === true;
}

/**
 * Allows app_session cookie subscribers OR Tailered OS machine principal.
 * Machine path does NOT attach ctx.appUser (no human impersonation).
 */
export const sportsReadProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (isMachineSportsReadRequest(ctx.req)) {
    return next({
      ctx: {
        ...ctx,
        sportsPrincipal: "machine" as const,
        appUser: undefined,
      },
    });
  }

  const token = getAppCookie(ctx.req);
  if (!token) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const payload = await verifyAppUserToken(token);
  if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });

  let user = await getAppUserById(payload.userId);
  const fromCache = !user;
  if (!user) {
    user = getCachedAppUser(payload.userId);
  } else {
    setCachedAppUser(user);
  }
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found" });
  if (!user.hasAccess) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
  if (!fromCache && payload.tv !== null && payload.tv !== user.tokenVersion) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session invalidated. Please log in again." });
  }
  if (user.expiryDate && Date.now() > user.expiryDate) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Account expired" });
  }

  return next({
    ctx: {
      ...ctx,
      sportsPrincipal: "subscriber" as const,
      appUser: user,
    },
  });
});

// Re-export cookie name for tests that assert no cookie impersonation
export { APP_USER_COOKIE };
