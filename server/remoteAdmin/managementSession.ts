/** PREZ's Tailered session authorizes only the copied User Management procedures.
 * The existing sync secret signs a purpose-bound, short-lived request; no Dime
 * cookie or login credential is created, returned, or stored by this channel.
 */
import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { verifyTaileredSignature } from "./userMutation";

export const MANAGEMENT_ACTOR = "1098485718734602281@discord.tailered.ai";
export const MANAGEMENT_KIND = "tailered-user-management-v1";
export const MANAGEMENT_METHODS: Record<string, string> = {
  "appUsers.me": "GET",
  "appUsers.listUsers": "GET",
  "subscriptionPlans.list": "GET",
  "appUsers.createUser": "POST",
  "appUsers.updateUser": "POST",
  "appUsers.deleteUser": "POST",
  "appUsers.forceLogoutUser": "POST",
  "appUsers.forceLogoutAll": "POST",
  "appUsers.adminDisconnectDiscord": "POST",
  "appUsers.generateDiscordInvite": "POST",
  "appUsers.syncDiscordRole": "POST",
  "appUsers.setManualDiscordId": "POST",
};
const WINDOW_MS = 60_000;
// ponytail: single Railway replica; use a shared atomic nonce store before scaling replicas.
const usedNonces = new Map<string, number>();

/** Resolve a signed request to the current, enabled, Discord-linked PREZ owner. */
export async function getManagementSession(req: Request) {
  const signature = req.headers["x-tailered-management-signature"];
  if (!signature) return null; // The existing Dime cookie flow stays authoritative otherwise.
  const deny = () =>
    new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid Tailered management proof",
    });
  if (typeof signature !== "string") throw deny();
  const secret = process.env.TAILERED_SYNC_SECRET;
  const sentAt = Number(req.get("x-tailered-management-timestamp"));
  const nonce = req.get("x-tailered-management-nonce") ?? "";
  const actor = req.get("x-tailered-management-actor");
  const url = new URL(req.originalUrl, "https://aisportsbettingmodels.com");
  const procedure = url.pathname.replace(/^\/api\/trpc\//, "");
  const now = Date.now();
  if (
    !secret ||
    actor !== MANAGEMENT_ACTOR ||
    !Number.isSafeInteger(sentAt) ||
    Math.abs(now - sentAt) > WINDOW_MS ||
    !/^[0-9a-f-]{36}$/.test(nonce) ||
    MANAGEMENT_METHODS[procedure] !== req.method ||
    url.pathname !== `/api/trpc/${procedure}` ||
    Array.from(url.searchParams.keys()).some(key => key !== "input")
  )
    throw deny();
  const input =
    req.method === "GET" ? url.searchParams.get("input") : (req.body ?? null);
  const proof = JSON.stringify({
    kind: MANAGEMENT_KIND,
    actor,
    sentAt,
    nonce,
    method: req.method,
    path: url.pathname,
    input,
  });
  if (!verifyTaileredSignature(proof, signature, secret)) throw deny();
  for (const [key, expires] of Array.from(usedNonces))
    if (expires <= now) usedNonces.delete(key);
  if (usedNonces.has(nonce) || usedNonces.size >= 10_000) throw deny();
  usedNonces.set(nonce, sentAt + WINDOW_MS);

  const { getAppUserByUsername, lookupAppUserByIdFresh } =
    await import("../db");
  const candidate = await getAppUserByUsername("prez");
  const lookup = candidate ? await lookupAppUserByIdFresh(candidate.id) : null;
  const user = lookup?.status === "found" ? lookup.user : null;
  if (
    !user ||
    user.username !== "prez" ||
    user.discordId !== MANAGEMENT_ACTOR.split("@")[0] ||
    user.role !== "owner" ||
    !user.hasAccess ||
    user.deletedAt ||
    (user.expiryDate !== null && user.expiryDate <= now)
  )
    throw deny();
  return {
    userId: user.id,
    role: user.role,
    tv: user.tokenVersion,
    exp: sentAt + WINDOW_MS,
  };
}
