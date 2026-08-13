// PRX v1.1 trusted-policy selection (SOL-PRX-004). CI checks out the
// event's BASE SHA into a separate directory and asks this module which
// policy tree may produce the verdict. Pull-request head content is data,
// never policy. scripts/prx/trusted-boundary.test.ts mutates a simulated
// head checker and proves the selection (and the selected bytes) do not
// change.
import { existsSync } from "node:fs";
import { join } from "node:path";

const POLICY_MARKER = join("scripts", "prx", "check-commit.mjs");

export function selectPolicySource({ trustedDir, headDir }) {
  if (trustedDir && existsSync(join(trustedDir, POLICY_MARKER))) {
    return {
      dir: trustedDir,
      trusted: true,
      reason: "policy loaded from the trusted base ref",
    };
  }
  return {
    dir: headDir,
    trusted: false,
    reason:
      "bootstrap: policy is absent on the base ref; the head copy runs " +
      "explicitly UNTRUSTED and the lane stays audit-only",
  };
}

// NUL-delimited file-list transfer (SOL-PRX-017): safe for filenames
// containing spaces, tabs, newlines, and leading hyphens.
export function parseNulList(input) {
  return input.split("\0").filter(name => name.length > 0);
}
