// PRX v1.1 rollout modes (SOL-PRX-010). The committed mode state is
// scripts/prx/prx-mode.json; CI reads it from the TRUSTED policy source, so
// a pull request cannot flip its own enforcement level. Transitions
// (audit -> advisory -> enforcing) are owner-authorized reviewed changes to
// that file plus, for enforcing, the separate owner ruleset action that
// makes the check required — this lane never adds itself to the ruleset.
import { ruleClass } from "./rules.mjs";

export const MODES = Object.freeze(["audit", "advisory", "enforcing"]);

// Enforcing mode may block ONLY on rules in this list (Section 12 of the
// execution contract: "explicitly approved deterministic blocking rules").
// Advisory- and heuristic-class rules can never appear here; ruleClass()
// guards against registry drift at module load.
export const APPROVED_BLOCKING = Object.freeze(
  [
    "PRX-C-SIZE",
    "PRX-C-SUBJECT",
    "PRX-C-PREFIX",
    "PRX-C-SEPARATOR",
    "PRX-C-FENCE",
    "PRX-C-TRAILER",
    "PRX-C-GOV",
    "PRX-C-FIXUP",
    "PRX-B-SIZE",
    "PRX-B-VISIBLE",
    "PRX-B-SECTION",
    "PRX-B-CAPSULE",
  ].filter(id => {
    if (ruleClass(id) !== "deterministic") {
      throw new Error(
        `APPROVED_BLOCKING may only contain deterministic rules; ${id} is ` +
          ruleClass(id)
      );
    }
    return true;
  })
);

export function parseModeState(json) {
  let state;
  try {
    state = JSON.parse(json);
  } catch {
    throw new Error("prx-mode.json is not valid JSON");
  }
  if (state?.version !== 1 || !MODES.includes(state?.mode)) {
    throw new Error(
      `prx-mode.json must be {"version":1,"mode":"audit|advisory|enforcing"}`
    );
  }
  return state;
}

// The verdict: audit and advisory NEVER produce a blocking exit; enforcing
// blocks only on approved deterministic findings. Tool crashes are handled
// by the CLI wrappers with exit 2 and are outside this function.
export function resolveVerdict(mode, findings) {
  if (!MODES.includes(mode)) throw new Error(`unknown PRX mode: ${mode}`);
  const blocking =
    mode === "enforcing"
      ? findings.filter(
          f => f.level === "error" && APPROVED_BLOCKING.includes(f.rule)
        )
      : [];
  return { mode, blocking, exitCode: blocking.length > 0 ? 1 : 0 };
}
