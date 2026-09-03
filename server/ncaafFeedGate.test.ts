import { afterEach, describe, expect, it, vi } from "vitest";
import { zodSport } from "./securityMiddleware";
import { scrapeVsinBettingSplits } from "./vsinBettingSplitsScraper";
import { isValidGame } from "./routers";

afterEach(() => vi.unstubAllGlobals());

describe("NCAAF feed gates", () => {
  it("accepts NCAAF but not an unapproved sport", () => {
    expect(zodSport.parse("NCAAF")).toBe("NCAAF");
    expect(() => zodSport.parse("NFL")).toThrow();
    expect(isValidGame("MASS", "RUTG", "NCAAF")).toBe(true);
    expect(isValidGame("MASS", "NOTATEAM", "NCAAF")).toBe(false);
  });

  it("parses CFB rows from the shared VSiN table", async () => {
    const badge = (value: number) => `<span class="sp-badge">${value}%</span>`;
    const away = `<tr class="sp-row"><td><button data-gamecode="20260903CFB00206"></button><a class="sp-team-link" href="/cfb/teams/massachusetts-minutemen">Massachusetts Minutemen</a></td><td></td><td></td><td>${badge(87)}</td><td>${badge(89)}</td><td></td><td>${badge(30)}</td><td>${badge(23)}</td><td></td><td>${badge(50)}</td><td>${badge(6)}</td></tr>`;
    const home = `<tr class="sp-row"><td><a class="sp-team-link" href="/cfb/teams/rutgers-scarlet-knights">Rutgers Scarlet Knights</a></td>${"<td></td>".repeat(10)}</tr>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<table class="sp-table"><thead><tr><th class="sp-sport-name">CFB</th></tr></thead><tbody>${away}${home}</tbody></table>`, { status: 200 })));
    const rows = await scrapeVsinBettingSplits("today", "CFB");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sport: "CFB", awayVsinSlug: "massachusetts-minutemen", homeVsinSlug: "rutgers-scarlet-knights" });
  });
});
