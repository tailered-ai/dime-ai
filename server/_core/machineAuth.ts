/**
 * machineAuth.ts — Tailered OS sports-read machine principal.
 * Fail-closed shared secret, distinct from CRON_SECRET. No cookie impersonation.
 */

import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import { TRPCError } from "@trpc/server";
import { publicProcedure } from "./trpc";
import { getAppCookie, verifyAppUserToken } from "../routers/appUsers";
import { getAppUserById } from "../db";
import { getCachedAppUser, setCachedAppUser } from "../dbCircuitBreaker";

export const SPORTS_READ_SECRET_ENV = "TAILERED_OS_SPORTS_READ_SECRET";
export const SPORTS_READ_HEADER = "x-tailered-sports-secret";

export type SportsReadAuthResult =
  | { ok: true; principal: "machine" }
  | { ok: false; status: 401 | 503; error: string };

type HeadersBag = { headers: Record<string, string | string[] | undefined> };

function extractPresentedToken(req: HeadersBag): string | null {
  const raw = req.headers ?? {};
  const x = raw[SPORTS_READ_HEADER];
  if (typeof x === "string" && x.length > 0) return x.trim();
  const authz = raw["authorization"] ?? raw["Authorization"];
  const authStr = Array.isArray(authz) ? authz[0] : authz;
  if (typeof authStr !== "string") return null;
  const trimmed = authStr.trim();
  if (!/^Bearer\s/i.test(trimmed)) return null;
  const token = trimmed.slice("Bearer".length).trim();
  return token.length > 0 ? token : null;
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

export function verifySportsReadSecret(req: HeadersBag): SportsReadAuthResult {
  const secret = process.env[SPORTS_READ_SECRET_ENV];
  if (!secret)
    return { ok: false, status: 503, error: "sports-read-not-configured" };
  const presented = extractPresentedToken(req);
  if (!presented)
    return { ok: false, status: 401, error: "missing-sports-read-secret" };
  if (!constantTimeEqual(presented, secret)) {
    return { ok: false, status: 401, error: "invalid-sports-read-secret" };
  }
  return { ok: true, principal: "machine" };
}

export function isMachineSportsReadRequest(req: Request | HeadersBag): boolean {
  return verifySportsReadSecret(req as HeadersBag).ok === true;
}

/** Subscriber cookie OR Tailered OS machine principal. Machine path sets no appUser. */
export const sportsReadProcedure = publicProcedure.use(
  async ({ ctx, next }) => {
    if (isMachineSportsReadRequest(ctx.req)) {
      return next({ ctx: { ...ctx, sportsPrincipal: "machine" as const } });
    }

    const token = getAppCookie(ctx.req);
    if (!token)
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    const payload = await verifyAppUserToken(token);
    if (!payload)
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session" });

    let user = await getAppUserById(payload.userId);
    const fromCache = !user;
    if (!user) user = getCachedAppUser(payload.userId);
    else setCachedAppUser(user);

    if (!user)
      throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found" });
    if (!user.hasAccess)
      throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
    if (!fromCache && payload.tv !== null && payload.tv !== user.tokenVersion) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Session invalidated. Please log in again.",
      });
    }
    if (user.expiryDate && Date.now() > user.expiryDate) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Account expired" });
    }

    return next({
      ctx: { ...ctx, sportsPrincipal: "subscriber" as const, appUser: user },
    });
  }
);
