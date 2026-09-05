import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import teams from "./ncaafFeedTeams.json";
import { ncaafHelmet } from "./ncaafHelmets";

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
