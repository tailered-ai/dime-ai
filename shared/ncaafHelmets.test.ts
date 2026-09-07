import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import teams from "./ncaafFeedTeams.json";
import { ncaafHelmet } from "./ncaafHelmets";
import { footballHelmet, footballRefreshDates } from "./footballMarkets";
import windowEvidence from "../docs/audits/2026-09-07-football-markets-evidence/helmets-window-complete.json";
import generation from "../docs/audits/2026-09-07-football-markets-evidence/helmet-generation.json";
import nflTeams from "../scripts/data/nfl-2026/teams.json";

it("loads a distinct generated PNG helmet for every team in the September 5 slate", () => {
  const hashes = new Set<string>();
  expect(Object.keys(teams)).toHaveLength(136);
  for (const team of Object.keys(teams)) {
    const asset = ncaafHelmet(team);
    expect(asset, team).toMatch(/^\/brand\/ncaaf-helmets\/sept5-.*-v2\.png$/);
    const png = readFileSync(
      new URL(`../client/public${asset}`, import.meta.url)
    );
    expect(png.subarray(0, 8).toString("hex"), team).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], team).toEqual([
      512, 384,
    ]);
    expect(png[25], `${team} RGBA`).toBe(6);
    hashes.add(createHash("sha256").update(png).digest("hex"));
  }
  expect(hashes.size).toBe(136);
});

it("covers every verified September 7–13 football team with an existing helmet, never a logo fallback", () => {
  expect(footballRefreshDates(new Date("2026-09-07T12:00Z"))).toEqual(
    windowEvidence.window
  );
  expect(windowEvidence.leagues.map(league => league.teams.length)).toEqual([
    173, 30,
  ]);
  for (const league of windowEvidence.leagues) {
    expect(league.unresolved).toEqual([]);
    for (const team of league.teams) {
      const path = footballHelmet(league.sport, team.code);
      expect(path, `${league.sport}:${team.code}`).toBe(team.path);
      expect(path).toMatch(/^\/brand\/(?:ncaaf|nfl)-helmets\//);
      const file = readFileSync(
        new URL(`../client/public${path}`, import.meta.url)
      );
      expect(createHash("sha256").update(file).digest("hex")).toBe(team.sha256);
    }
  }
  const hashes = new Set<string>();
  for (const asset of generation.assets) {
    const png = readFileSync(new URL(`../${asset.target}`, import.meta.url));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png[25], `${asset.code}: alpha channel`).toBe(6);
    hashes.add(createHash("sha256").update(png).digest("hex"));
  }
  expect(hashes.size).toBe(49);
  expect(ncaafHelmet("UNKNOWN")).toBeNull();
  expect(footballHelmet("NFL", "UNKNOWN")).toBeNull();
  expect(nflTeams).toHaveLength(32);
  for (const team of nflTeams) {
    const path = footballHelmet("NFL", team.abbreviation);
    expect(path).toBe(`/brand/nfl-helmets/${team.abbreviation}.webp`);
    const webp = readFileSync(
      new URL(`../client/public${path}`, import.meta.url)
    );
    expect(webp.subarray(8, 12).toString()).toBe("WEBP");
  }
});
