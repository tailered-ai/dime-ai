/**
 * securityEventWriterClamps.test.ts
 *
 * WHY THIS FILE EXISTS (2026-08-09 revalidation of the §1 remediation
 * baseline). `securityEventLimits.test.ts` has a describe block titled
 * "insertSecurityEvent field clamping (regression)" — but every assertion in
 * it calls `truncateForColumn()` directly. Nothing executed the WRITER. That
 * was verified, not assumed: with BOTH clamps deleted from the real
 * `insertSecurityEvent` in server/db.ts —
 *
 *     trpcPath: event.trpcPath,   // clamp removed
 *     context:  event.context,    // byte clamp removed
 *
 * — the entire security suite (securityEventLimits, db.securityEvents,
 * securityDigest, weeklySecurityDigest, clientIdentityCallSites,
 * securityAlertLogSafety = 120 tests) stayed GREEN, and so did the full
 * 4,584-test run. The erasure primitive the clamps exist to close (an
 * attacker sends a >256-char path, `ER_DATA_TOO_LONG` kills the INSERT, and
 * the security event recording their own probe silently vanishes — the same
 * defect class as the k-props NAME_MATCH_FAILED sentinel, PR #418) could be
 * reintroduced by a refactor with nothing to stop it.
 *
 * These tests drive the REAL `insertSecurityEvent`, mocking only the driver
 * layer (mysql2 pool + drizzle) and capturing the row it actually hands to
 * `.values()`. They assert two things the helper-level tests cannot:
 *
 *   1. every column-bound value the writer emits fits its schema width
 *      (VARCHAR in CHARACTERS, TEXT in BYTES), and
 *   2. the oversized hostile event still PERSISTS — `.values()` is called
 *      exactly once and the writer does not swallow the row.
 *
 * Column widths are read from SECURITY_EVENT_LIMITS, which
 * securityEventLimits.test.ts independently pins to drizzle/schema.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rows the real writer handed to drizzle's `.values()` during a test. */
let insertedRows: Record<string, unknown>[] = [];

vi.mock("mysql2/promise", () => ({
  default: { createPool: () => ({ end: async () => {} }) },
}));

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => ({
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve(undefined);
      },
    }),
  }),
}));

import { insertSecurityEvent } from "../db";
import { SECURITY_EVENT_LIMITS } from "./securityEventLimits";

beforeEach(() => {
  // getDb() only checks this for truthiness before handing the URI to mysql2,
  // which is mocked above — it is never parsed or dialled. Deliberately
  // carries NO user:password component (gitleaks connection-string rule).
  process.env.DATABASE_URL = "mysql://localhost:3306/testdb";
  insertedRows = [];
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The exact attack shape: every attacker-reachable column oversized at once. */
function hostileEvent() {
  return {
    eventType: "RATE_LIMIT",
    // ip is header-derived (resolveClientIdentity) → attacker-influenced.
    ip: "9".repeat(500),
    blockedOrigin: "https://" + "o".repeat(4000),
    // The original defect: >256 chars into a varchar(256) killed the INSERT.
    trpcPath: "/" + "a".repeat(4000),
    httpMethod: "P".repeat(200),
    userAgent: "u".repeat(4000),
    // TEXT is bounded in BYTES: 30,000 four-byte emoji = 120,000 bytes, well
    // over MySQL's 65,535-byte TEXT cap, while being only 60,000 JS code
    // units — a character-based clamp would pass this straight through.
    context: "😀".repeat(30000),
    occurredAt: 1_754_500_000_000,
  };
}

describe("insertSecurityEvent — the WRITER clamps every column it emits", () => {
  it("persists the hostile event rather than dropping it (the erasure primitive)", async () => {
    await insertSecurityEvent(hostileEvent());
    expect(insertedRows).toHaveLength(1);
  });

  it("clamps trpcPath to the varchar(256) width", async () => {
    await insertSecurityEvent(hostileEvent());
    const row = insertedRows[0];
    expect(typeof row.trpcPath).toBe("string");
    expect((row.trpcPath as string).length).toBeLessThanOrEqual(
      SECURITY_EVENT_LIMITS.trpcPath
    );
  });

  it("clamps every VARCHAR column by CHARACTER count", async () => {
    await insertSecurityEvent(hostileEvent());
    const row = insertedRows[0];
    const varcharColumns = [
      "ip",
      "blockedOrigin",
      "trpcPath",
      "httpMethod",
      "userAgent",
    ] as const;
    for (const col of varcharColumns) {
      const value = row[col];
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeLessThanOrEqual(
        SECURITY_EVENT_LIMITS[col]
      );
    }
  });

  it("clamps the TEXT context column by BYTE count, not character count", async () => {
    await insertSecurityEvent(hostileEvent());
    const row = insertedRows[0];
    expect(typeof row.context).toBe("string");
    const bytes = new TextEncoder().encode(row.context as string).length;
    expect(bytes).toBeLessThanOrEqual(SECURITY_EVENT_LIMITS.context);
    // A character-based clamp would emit 65,535 EMOJI = 262,140 bytes and
    // still satisfy a naive `.length` assertion — so pin the discriminator:
    // the byte-clamped result must be far SHORTER in characters than the cap.
    expect((row.context as string).length).toBeLessThan(
      SECURITY_EVENT_LIMITS.context
    );
  });

  it("never emits a broken code point at the TEXT cut point", async () => {
    await insertSecurityEvent(hostileEvent());
    expect(insertedRows[0].context as string).not.toContain("�");
  });

  it("leaves an ordinary event untouched — the clamps are not lossy in the normal case", async () => {
    await insertSecurityEvent({
      eventType: "AUTH_FAIL",
      ip: "203.0.113.7",
      trpcPath: "appUsers.login",
      httpMethod: "POST",
      userAgent: "Mozilla/5.0",
      context: "invalid_password",
      occurredAt: 1_754_500_000_000,
    });
    const row = insertedRows[0];
    expect(row.ip).toBe("203.0.113.7");
    expect(row.trpcPath).toBe("appUsers.login");
    expect(row.httpMethod).toBe("POST");
    expect(row.userAgent).toBe("Mozilla/5.0");
    expect(row.context).toBe("invalid_password");
  });
});
