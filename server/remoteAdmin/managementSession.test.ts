import { createHmac, randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getManagementSession,
  MANAGEMENT_ACTOR,
  MANAGEMENT_KIND,
} from "./managementSession";
const db = vi.hoisted(() => ({
  getAppUserByUsername: vi.fn(),
  lookupAppUserByIdFresh: vi.fn(),
}));
vi.mock("../db", () => db);
const secret = "test-only-management-secret";
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
function request(
  procedure = "appUsers.listUsers",
  method = "GET",
  body?: unknown
) {
  vi.stubEnv("TAILERED_SYNC_SECRET", secret);
  db.getAppUserByUsername.mockResolvedValue(owner);
  db.lookupAppUserByIdFresh.mockResolvedValue({ status: "found", user: owner });
  const path = `/api/trpc/${procedure}`;
  const sentAt = Date.now();
  const nonce = randomUUID();
  const proof = JSON.stringify({
    kind: MANAGEMENT_KIND,
    actor: MANAGEMENT_ACTOR,
    sentAt,
    nonce,
    method,
    path,
    input: body ?? null,
  });
  const headers: Record<string, string> = {
    "x-tailered-management-signature": `sha256=${createHmac("sha256", secret).update(proof).digest("hex")}`,
    "x-tailered-management-timestamp": String(sentAt),
    "x-tailered-management-nonce": nonce,
    "x-tailered-management-actor": MANAGEMENT_ACTOR,
  };
  return {
    req: {
      method,
      originalUrl: path,
      body,
      headers,
      get: (key: string) => headers[key],
    } as Request,
    headers,
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("PREZ management proof", () => {
  it("uses a fresh linked owner without issuing a cookie and rejects replay", async () => {
    const { req } = request();
    expect(await getManagementSession(req)).toMatchObject({
      userId: 9,
      role: "owner",
      tv: 4,
    });
    await expect(getManagementSession(req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.lookupAppUserByIdFresh).toHaveBeenCalledTimes(1);
  });
  it("leaves the original Dime cookie authentication path available", async () => {
    const { req, headers } = request();
    delete headers["x-tailered-management-signature"];
    expect(await getManagementSession(req)).toBeNull();
    expect(db.getAppUserByUsername).not.toHaveBeenCalled();
  });
  it.each(["actor", "timestamp", "signature", "nonce"])(
    "rejects a changed %s before any database read",
    async key => {
      const { req, headers } = request();
      headers[`x-tailered-management-${key}`] = "invalid";
      await expect(getManagementSession(req)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(db.getAppUserByUsername).not.toHaveBeenCalled();
    }
  );
  it("binds GET inputs and rejects additional query parameters", async () => {
    const input = JSON.stringify({ json: { search: "prez" } });
    const valid = request("appUsers.listUsers", "GET", input);
    valid.req.originalUrl += `?input=${encodeURIComponent(input)}`;
    expect(await getManagementSession(valid.req)).toMatchObject({ userId: 9 });
    const changed = request("appUsers.listUsers", "GET", input);
    changed.req.originalUrl += `?input=${encodeURIComponent("changed")}`;
    await expect(getManagementSession(changed.req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const extra = request();
    extra.req.originalUrl += "?batch=1";
    await expect(getManagementSession(extra.req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("binds mutations to their exact inputs", async () => {
    const valid = request("appUsers.updateUser", "POST", {
      json: { id: 20, hasAccess: true },
    });
    expect(await getManagementSession(valid.req)).toMatchObject({
      userId: 9,
      role: "owner",
    });
    const { req } = request("appUsers.updateUser", "POST", {
      json: { id: 20, hasAccess: true },
    });
    req.body.json.id = 9;
    await expect(getManagementSession(req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it.each([
    "appUsers.login",
    "appUsers.listUsers,appUsers.deleteUser",
    "games.listPostponed",
  ])("rejects unrelated or batched procedure %s", async procedure => {
    const { req } = request(procedure);
    await expect(getManagementSession(req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it.each([
    { role: "user" },
    { discordId: "different" },
    { hasAccess: false },
    { deletedAt: 1 },
    { expiryDate: 1 },
  ])("rejects a revoked or mismatched Dime owner: %j", async change => {
    const { req } = request();
    db.lookupAppUserByIdFresh.mockResolvedValue({
      status: "found",
      user: { ...owner, ...change },
    });
    await expect(getManagementSession(req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("fails closed during a database outage", async () => {
    const { req } = request();
    db.lookupAppUserByIdFresh.mockResolvedValue({ status: "unavailable" });
    await expect(getManagementSession(req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

// The shared ADMIN session adds only these existing read procedures.
describe("operational management reads", () => {
  const reads = [
    "metrics.getSessionMetrics",
    "metrics.getMemberMetrics",
    "analytics.overview",
    "waitlist.list",
    "waitlist.stats",
    "subscriptionPlans.list",
    "games.list",
    "mlbBacktest.getRollingAccuracy",
    "adminModelStatus.mlb",
    "adminModelStatus.nhl",
  ];
  it.each(reads)(
    "authorizes the signed GET %s for fresh PREZ",
    async procedure => {
      const { req } = request(procedure);
      expect(await getManagementSession(req)).toMatchObject({
        userId: 9,
        role: "owner",
      });
    }
  );
  it.each(reads)("never authorizes POST %s", async procedure => {
    await expect(
      getManagementSession(request(procedure, "POST", {}).req)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it.each([
    "waitlist.updateStatus",
    "subscriptionPlans.create",
    "games.publishAll",
    "mlbBacktest.runForDate",
    "metrics.openSession",
  ])("does not add adjacent mutation %s", async procedure => {
    await expect(
      getManagementSession(request(procedure, "POST", {}).req)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
