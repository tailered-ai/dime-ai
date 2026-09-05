import { describe, expect, it } from "vitest";
import sourceTeams from "../scripts/data/cfb-2026/teams.json";
import feedTeams from "./ncaafFeedTeams.json";
import { NCAAF_CONFERENCE_TEAMS, ncaafConference } from "./ncaafConferences";

describe("2026 NCAAF conference source parity", () => {
  it("contains exactly the source affiliations with no duplicate identities", () => {
    const codes = Object.values(NCAAF_CONFERENCE_TEAMS).flatMap(codes =>
      codes.split(" ")
    );
    expect(codes).toHaveLength(sourceTeams.length);
    expect(new Set(codes).size).toBe(codes.length);
    for (const team of sourceTeams) {
      expect(ncaafConference(team.espnAbbreviation)).toBe(team.conference);
    }
  });

  it("joins feed identity by ESPN id and never guesses absent affiliations", () => {
    for (const [code, team] of Object.entries(feedTeams)) {
      const source = sourceTeams.find(row => row.espnId === team.espnId);
      expect(ncaafConference(code)).toBe(source?.conference ?? null);
    }
    expect(ncaafConference(" ala ")).toBe("Southeastern Conference");
    for (const unknown of [
      "BRY",
      "UNH",
      "",
      "UNKNOWN",
      "constructor",
      "__proto__",
    ]) {
      expect(ncaafConference(unknown)).toBeNull();
    }
  });
});
