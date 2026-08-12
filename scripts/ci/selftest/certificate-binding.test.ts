/**
 * DEF-067 / DEF-068 never-regress anchors.
 *
 * DEF-068: certificate verify compared a fixed 7-hash field list, so a
 * re-pinned certificate with a tampered display binding
 * (required_contexts, toolchain, execution_history, …) verified VALID —
 * found live by the 2026-08-12 closure audit (scenario E2). compareBindings
 * is now exhaustive: any stored-vs-fresh divergence voids with the key name.
 *
 * DEF-067: .ci-verify/verify-pr/report.json carried no head/base binding,
 * so the artifact could not prove which commit it described. The report
 * writer now stamps identity derived from P01 (snapshot.mjs) plus
 * finished_at.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareBindings } from "../p10/certificate.mjs";
import { resolveBase, resolveHead } from "../snapshot.mjs";
import { identityBindings } from "../verify-pr.mjs";

const base = {
  verifier_hash: "v".repeat(64),
  head_sha: "a".repeat(40),
  merge_tree_sha: "b".repeat(40),
  lockfile_sha256: "c".repeat(64),
  contract_sha256: "d".repeat(64),
  assurance_sha256: "e".repeat(64),
  ledger_sha256: "f".repeat(64),
  ledger_pin: "f".repeat(64),
  base_sha: "9".repeat(40),
  dirty_tracked: false,
  verifier_file_count: 108,
  required_contexts: ["A", "B"],
  toolchain: { node: "v22.22.0", pnpm: "10.33.0" },
  cleanroom: { dockerfile_bases: [{ ref: "x", resolved_digest: "y" }] },
  open_units_all_p10: false,
  execution_history: { phases: { P10: "ACCEPTED" }, mandatory_total: 1 },
};
const clone = () => JSON.parse(JSON.stringify(base));

describe("P10.BIND (DEF-068)", () => {
  it("BIND01 identical bindings compare ok", () => {
    expect(compareBindings(base, clone())).toEqual({ ok: true });
  });

  it("BIND02 verifier_hash voids before head_sha (specificity order)", () => {
    const f = clone();
    f.verifier_hash = "0".repeat(64);
    f.head_sha = "1".repeat(40);
    expect(compareBindings(base, f)).toEqual({
      ok: false,
      field: "verifier_hash",
    });
  });

  it("BIND03 tampered required_contexts voids (the DEF-068 reproduction)", () => {
    const c = clone();
    c.required_contexts = ["A"];
    expect(compareBindings(c, base)).toEqual({
      ok: false,
      field: "required_contexts",
    });
  });

  it("BIND04 nested toolchain divergence voids with the key name", () => {
    const c = clone();
    c.toolchain.pnpm = "9.0.0";
    expect(compareBindings(c, base)).toEqual({ ok: false, field: "toolchain" });
  });

  it("BIND05 tampered execution_history voids", () => {
    const c = clone();
    c.execution_history.phases.P10 = "NOT_STARTED";
    expect(compareBindings(c, base)).toEqual({
      ok: false,
      field: "execution_history",
    });
  });

  it("BIND06 a key present on one side only voids", () => {
    const c = clone();
    delete (c as Record<string, unknown>).open_units_all_p10;
    expect(compareBindings(c, base)).toEqual({
      ok: false,
      field: "open_units_all_p10",
    });
  });

  it("BIND07 key order inside nested objects does not void (canonical form)", () => {
    const c = clone();
    c.toolchain = { pnpm: "10.33.0", node: "v22.22.0" };
    expect(compareBindings(c, base)).toEqual({ ok: true });
  });
});

describe("P10.RPT (DEF-067)", () => {
  it("RPT01 identityBindings matches P01 exactly", () => {
    const b = identityBindings();
    expect(b.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(b.head_sha).toBe(resolveHead());
    expect(b.base_sha).toBe(resolveBase(undefined, { fetch: false }).base_sha);
  });

  it("RPT02 the report writer stamps identity and finished_at (source anchor)", () => {
    const src = readFileSync(
      new URL("../verify-pr.mjs", import.meta.url),
      "utf8"
    );
    expect(src).toContain("Object.assign(report, identityBindings())");
    expect(src).toContain("report.finished_at");
  });
});
