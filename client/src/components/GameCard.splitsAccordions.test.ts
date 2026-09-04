import { describe, expect, it } from "vitest";
import { getTeamColors } from "@shared/teamColors";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "GameCard.tsx"),
  "utf8"
);

const Q = `["']`; // quote-style tolerant (prettier may rewrite quotes)

describe("splits-surface accordion gating (Last 5 + Trends live on the Trends tab)", () => {
  it("imports the shared shell-boundary hook", () => {
    expect(src).toMatch(
      new RegExp(`import \\{ useIsMdUp \\} from ${Q}@/hooks/useIsMdUp${Q}`)
    );
  });

  it("never renders Last 5 Games + Trends on the Betting Splits surface (any width)", () => {
    // The gate: mode === 'full' && !isMdUp && mobileTab === 'splits'
    // — splits mode is excluded entirely; the persisted mobileTab state can
    // never leak the panels onto desktop feeds either.
    expect(src).toMatch(
      new RegExp(
        `mode === ${Q}full${Q} &&\\s*!isMdUp &&\\s*mobileTab === ${Q}splits${Q}[\\s\\S]{0,300}game\\.sport === ${Q}MLB${Q}`
      )
    );
    // No `mode === 'splits' &&` clause may gate the panels back in.
    expect(src).not.toMatch(
      new RegExp(
        `mode === ${Q}splits${Q} &&[\\s\\S]{0,400}<RecentSchedulePanel`
      )
    );
  });

  it("keeps ODDS & SPLITS HISTORY on the splits surface at every width", () => {
    expect(src).toMatch(
      new RegExp(
        `\\(mode === ${Q}splits${Q} \\|\\|\\s*\\(mode === ${Q}full${Q} && !isMdUp && mobileTab === ${Q}splits${Q}\\)\\) &&\\s*isCardVisible &&\\s*game\\.id != null`
      )
    );
  });
});

describe("NCAAF splits publication", () => {
  it("does not resolve college Miami as the MLB Marlins", () => {
    expect(getTeamColors("MIA", "MLB")).not.toBeNull();
    expect(getTeamColors("MIA", "NCAAF")).toBeNull();
  });
  it("keeps the viewport hook unconditional when empty split data populates", () => {
    const panel = fs.readFileSync(
      path.join(import.meta.dirname, "BettingSplitsPanel.tsx"),
      "utf8"
    );
    const hook = panel.indexOf("const isMdUp = useIsMdUp()");
    const emptyReturn = panel.indexOf("if (!hasAnySplits)");
    expect(hook).toBeGreaterThan(-1);
    expect(emptyReturn).toBeGreaterThan(hook);
  });
});
