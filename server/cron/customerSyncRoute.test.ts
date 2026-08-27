/**
 * customerSyncRoute.test.ts — EXECUTES the POST /api/cron/customer-sync route
 * registered by registerCronRoutes, in the style of cronRoutes.register.test.ts:
 * a fake Express app with the heavy service modules mocked.
 *
 * Proves the wiring: the route exists, sits behind the same fail-closed
 * cronAuth gate as its neighbors, forwards pushCustomerSnapshot's result
 * verbatim, and maps outcomes to HTTP statuses (200 ok / 502 failed push /
 * 500 unexpected throw). pushCustomerSnapshot itself is unit-tested in
 * customerSync.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Heavy collaborators: mocked so importing cronRoutes does not drag in the DB,
// Stripe, or the scrapers — same block as cronRoutes.register.test.ts.
vi.mock("../vsinAutoRefresh", () => ({
  runVsinRefresh: vi.fn(),
  refreshAllScoresNow: vi.fn(),
  runMlbCycleOnce: vi.fn(),
}));
vi.mock("../mlbAllStarGameSync", () => ({ runMlbAllStarGameSync: vi.fn() }));
vi.mock("../betAutoGradeScheduler", () => ({
  runBetGradeCycle: vi.fn(),
  runBetGradeSweep: vi.fn(),
}));
vi.mock("../stripe/reconcile", () => ({
  reconcileStripeSubscriptions: vi.fn(),
  formatReconcileReport: vi.fn(),
}));
vi.mock("../_core/billingAlerts", () => ({ billingAlert: vi.fn() }));
vi.mock("../mlbOutcomeIngestor", () => ({ ingestMlbOutcomes: vi.fn() }));
vi.mock("../mlbScheduleHistoryService", () => ({
  captureClosingLines: vi.fn(),
}));
vi.mock("../mlbMultiMarketBacktest", () => ({
  runMultiMarketBacktestForDate: vi.fn(),
}));
vi.mock("./customerSync", () => ({ pushCustomerSnapshot: vi.fn() }));

import { registerCronRoutes } from "./cronRoutes";
import { pushCustomerSnapshot } from "./customerSync";

const pushMock = vi.mocked(pushCustomerSnapshot);

type Handler = (req: unknown, res: unknown) => unknown;

function fakeApp() {
  const posts: string[] = [];
  const handlers = new Map<string, Handler>();
  return {
    posts,
    handlers,
    app: {
      post: (p: string, h: Handler) => {
        posts.push(p);
        handlers.set(`POST ${p}`, h);
      },
      get: (p: string, h: Handler) => {
        handlers.set(`GET ${p}`, h);
      },
    } as never,
  };
}

function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status: (code: number) => {
      captured.status = code;
      return {
        json: (b: unknown) => {
          captured.body = b;
        },
      };
    },
  };
  return { captured, res };
}

function request(secret?: string) {
  return {
    headers: secret ? { "x-cron-secret": secret } : {},
    query: {},
    body: {},
    ip: "1.2.3.4",
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  pushMock.mockReset();
});

describe("POST /api/cron/customer-sync", () => {
  it("is registered alongside the existing cron endpoints", () => {
    const { app, posts } = fakeApp();
    registerCronRoutes(app);
    expect(posts).toContain("/api/cron/customer-sync");
    expect(posts).toContain("/api/cron/stripe-reconcile"); // neighbors intact
  });

  it("rejects a missing secret with the same status the other cron routes use (401), without pushing", async () => {
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request(), res);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ ok: false, error: "missing-cron-secret" });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret with 401, without pushing", async () => {
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("wrong"), res);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ ok: false, error: "invalid-cron-secret" });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when CRON_SECRET is unset (matching cronAuth)", async () => {
    delete process.env.CRON_SECRET;
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("anything"), res);
    expect(captured.status).toBe(503);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("authenticated: calls pushCustomerSnapshot and returns its result verbatim with 200", async () => {
    pushMock.mockResolvedValue({
      ok: true,
      users: 3,
      status: 200,
      bytes: 1234,
    });
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("s3cret"), res);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      ok: true,
      users: 3,
      status: 200,
      bytes: 1234,
    });
    // The [OUTPUT] log line carries the payload size for runway observability.
    const outputLine = vi
      .mocked(console.log)
      .mock.calls.map(args => args.map(String).join(" "))
      .find(l => l.includes("[Cron:customer-sync] [OUTPUT]"));
    expect(outputLine).toBeDefined();
    expect(outputLine!).toContain("bytes=1234");
  });

  it("unconfigured env: returns 200 {ok:true, skipped:'unconfigured'} verbatim", async () => {
    pushMock.mockResolvedValue({ ok: true, skipped: "unconfigured" });
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("s3cret"), res);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true, skipped: "unconfigured" });
  });

  it("failed push (ok:false, HTTP 404): returns the result verbatim with 502 so the workflow goes red", async () => {
    pushMock.mockResolvedValue({ ok: false, status: 404 });
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("s3cret"), res);
    expect(captured.status).toBe(502);
    expect(captured.body).toEqual({ ok: false, status: 404 });
  });

  it("failed push (ok:false, HTTP 500): stays 502 — receiver faults must redden the workflow", async () => {
    pushMock.mockResolvedValue({ ok: false, status: 500 });
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("s3cret"), res);
    expect(captured.status).toBe(502);
    expect(captured.body).toEqual({ ok: false, status: 500 });
  });

  it("receiver 409 (superseded snapshot correctly rejected): 200 {ok:true, skipped:'superseded_snapshot'}", async () => {
    // A 409 means the receiver did its job — refused a stale/superseded
    // snapshot (e.g. a manual dispatch racing the scheduled run). A CORRECT
    // rejection must not redden the workflow.
    pushMock.mockResolvedValue({ ok: false, status: 409 });
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("s3cret"), res);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      ok: true,
      skipped: "superseded_snapshot",
      status: 409,
    });
  });

  it("unexpected throw: responds 500 {ok:false, error} instead of crashing", async () => {
    pushMock.mockRejectedValue(new Error("boom"));
    const { app, handlers } = fakeApp();
    registerCronRoutes(app);
    const h = handlers.get("POST /api/cron/customer-sync")!;
    const { captured, res } = fakeRes();
    await h(request("s3cret"), res);
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: "boom" });
  });
});
