import { createHmac, randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGamesListAuthenticated,
  isRequestAuthenticated,
  GATED_FEED_VARY,
} from "./feedGating";
const owner = {
  id: 9,
  username: "prez",
  role: "owner",
  hasAccess: true,
  deletedAt: null,
  expiryDate: null,
  tokenVersion: 4,
  discordId: "1098485718734602281",
};
const db = vi.hoisted(() => ({
  getAppUserByUsername: vi.fn(),
  lookupAppUserByIdFresh: vi.fn(),
}));
vi.mock("./db", () => db);
vi.mock("./routers/appUsers", () => ({
  APP_USER_COOKIE: "app_session",
  verifyAppUserToken: vi.fn(async () => null),
}));
vi.mock("./_core/machineAuth", () => ({
  isMachineSportsReadRequest: vi.fn(() => false),
}));
const secret = "test-only-secret";
function request(path = "/api/trpc/games.list") {
  vi.stubEnv("TAILERED_SYNC_SECRET", secret);
  db.getAppUserByUsername.mockResolvedValue(owner);
  db.lookupAppUserByIdFresh.mockResolvedValue({ status: "found", user: owner });
  const actor = "1098485718734602281@discord.tailered.ai";
  const sentAt = Date.now();
  const nonce = randomUUID();
  const input = JSON.stringify({ json: {} });
  const proof = JSON.stringify({
    kind: "tailered-user-management-v1",
    actor,
    sentAt,
    nonce,
    method: "GET",
    path,
    input,
  });
  const headers: Record<string, string> = {
    "x-tailered-management-actor": actor,
    "x-tailered-management-timestamp": String(sentAt),
    "x-tailered-management-nonce": nonce,
    "x-tailered-management-signature": `sha256=${createHmac("sha256", secret).update(proof).digest("hex")}`,
  };
  return {
    method: "GET",
    originalUrl: `${path}?input=${encodeURIComponent(input)}`,
    headers,
    get: (key: string) => headers[key],
  } as Request;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("games management proof", () => {
  it("accepts a verified live PREZ proof exactly once", async () => {
    const req = request();
    expect(await isGamesListAuthenticated(req)).toBe(true);
    expect(await isGamesListAuthenticated(req)).toBe(false);
    expect(db.lookupAppUserByIdFresh).toHaveBeenCalledTimes(1);
  });
  it("rejects forged proof, changed input, and wrong route without auth widening", async () => {
    const forged = request();
    forged.headers["x-tailered-management-signature"] = "forged";
    expect(await isGamesListAuthenticated(forged)).toBe(false);
    const changed = request();
    changed.originalUrl += "&batch=1";
    expect(await isGamesListAuthenticated(changed)).toBe(false);
    expect(
      await isGamesListAuthenticated(request("/api/trpc/waitlist.list"))
    ).toBe(false);
    expect(db.lookupAppUserByIdFresh).not.toHaveBeenCalled();
  });
  it("denies deleted PREZ and does not authorize other feeds", async () => {
    const req = request();
    db.lookupAppUserByIdFresh.mockResolvedValue({
      status: "found",
      user: { ...owner, deletedAt: new Date() },
    });
    expect(await isGamesListAuthenticated(req)).toBe(false);
    expect(await isRequestAuthenticated(request())).toBe(false);
  });
  it("separates the shared management credential in feed caches", () => {
    expect(GATED_FEED_VARY).toContain("x-tailered-management-signature");
  });
});
