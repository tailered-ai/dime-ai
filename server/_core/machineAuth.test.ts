/**
 * machineAuth.test.ts — Tailered OS sports-read machine principal contract.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { verifySportsReadSecret, SPORTS_READ_SECRET_ENV, SPORTS_READ_HEADER } from "./machineAuth";

const SECRET = "s3cr3t-sports-read-token-abcdef0123456789";

function headers(h: Record<string, string> = {}) {
  return { headers: h };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[SPORTS_READ_SECRET_ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[SPORTS_READ_SECRET_ENV];
  else process.env[SPORTS_READ_SECRET_ENV] = saved;
});

describe("verifySportsReadSecret — fail closed", () => {
  it("rejects 503 when secret not configured", () => {
    delete process.env[SPORTS_READ_SECRET_ENV];
    const r = verifySportsReadSecret(headers({ authorization: `Bearer ${SECRET}` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it("rejects 503 when secret empty", () => {
    process.env[SPORTS_READ_SECRET_ENV] = "";
    const r = verifySportsReadSecret(headers({ authorization: `Bearer ${SECRET}` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });
});

describe("verifySportsReadSecret — negatives", () => {
  beforeEach(() => {
    process.env[SPORTS_READ_SECRET_ENV] = SECRET;
  });

  it("MISSING_PRINCIPAL → 401", () => {
    const r = verifySportsReadSecret(headers({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("INVALID_PRINCIPAL → 401", () => {
    const wrong = "x".repeat(SECRET.length);
    const r = verifySportsReadSecret(headers({ authorization: `Bearer ${wrong}` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("wrong length does not throw", () => {
    const r = verifySportsReadSecret(headers({ authorization: "Bearer short" }));
    expect(r.ok).toBe(false);
  });

  it("CUSTOMER_TOKEN / CRON-shaped bearer cannot become sports principal when wrong", () => {
    const r = verifySportsReadSecret(headers({ authorization: "Bearer customer-session-token-xyz" }));
    expect(r.ok).toBe(false);
  });

  it("VALID_MACHINE_PRINCIPAL via Bearer", () => {
    const r = verifySportsReadSecret(headers({ authorization: `Bearer ${SECRET}` }));
    expect(r).toEqual({ ok: true, principal: "machine" });
  });

  it("VALID_MACHINE_PRINCIPAL via x-tailered-sports-secret", () => {
    const r = verifySportsReadSecret(headers({ [SPORTS_READ_HEADER]: SECRET }));
    expect(r).toEqual({ ok: true, principal: "machine" });
  });
});
