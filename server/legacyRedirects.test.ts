import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Regression guards for the 2026-07-11 navigation reconstruction
 * (docs/plans/2026-07-11-navigation-reconstruction.md).
 *
 * Protected properties:
 *   1. ERADICATION — no client link/redirect may emit the legacy slugs
 *      (/feed, /feed?tab=…, /splits, /projections, /dashboard).
 *   2. PERMANENCE — the server issues real HTTP 308s for full-page loads of
 *      the legacy slugs, and App.tsx redirects SPA navigations.
 *   3. CANONICAL ROUTES — /feed/model/:sport(-date) and /betting-splits/:sport
 *      stay registered behind RequireAuth.
 */

const read = (...segs: string[]) =>
  fs.readFileSync(path.join(import.meta.dirname, ...segs), "utf8");

const serverSrc = read("_core", "index.ts");
const appSrc = read("..", "client", "src", "App.tsx");
const configSrc = read(
  "..",
  "client",
  "src",
  "features",
  "mobileNav",
  "config.ts"
);
const tabsSrc = read(
  "..",
  "client",
  "src",
  "features",
  "mobileNav",
  "MobileFloatingNav.tsx"
);
const homeSrc = read("..", "client", "src", "pages", "Home.tsx");

describe("Legacy slug eradication — server 308 layer", () => {
  it("registers the 308 handler for all four legacy slugs", () => {
    expect(serverSrc).toMatch(
      /app\.get\(\["\/feed", "\/splits", "\/projections", "\/dashboard"\]/
    );
    expect(serverSrc).toMatch(/res\.redirect\(308, target\)/);
  });

  it("maps /splits and ?tab=splits to /betting-splits/NCAAF", () => {
    expect(serverSrc).toMatch(/req\.path === "\/splits" \|\| tab === "splits"/);
    expect(serverSrc).toMatch(/target = "\/betting-splits\/NCAAF"/);
  });

  it("maps everything else to the dated canonical feed slug", () => {
    expect(serverSrc).toMatch(
      /target = `\/feed\/model\/\$\{sport\}-\$\{slugDate\}`/
    );
  });

  it("uses the 07:00 UTC (00:00 PT) feed rollover for the default date", () => {
    // Scope the assertion to the feedSlugDate helper — index.ts also carries
    // an unrelated FEED_CUTOFF_UTC_HOUR = 11 (games-cache pre-warm), so a
    // whole-file match could not catch the redirect being rewired to it.
    const start = serverSrc.indexOf("const feedSlugDate");
    const end = serverSrc.indexOf('app.get(["/feed"', start);
    expect(start).toBeGreaterThan(-1);
    const helper = serverSrc.slice(start, end);
    expect(helper).toMatch(/const FEED_CUTOFF_UTC_HOUR = 7;/);
  });

  it("forbids caching of the date-varying 308 and forwards unconsumed query params", () => {
    expect(serverSrc).toMatch(/res\.set\("Cache-Control", "no-store"\)/);
    expect(serverSrc).toMatch(
      /key === "tab" \|\| key === "sport" \|\| key === "date"/
    );
  });
});

describe("Legacy slug eradication — server-side emitters", () => {
  const emailSrc = read("email.ts");
  const discordAuthSrc = read("discordAuth.ts");
  const discordLoginSrc = read("discordLogin.ts");
  const discordInviteSrc = read("discordInvite.ts");

  it("welcome email CTA links the canonical feed, not the legacy slug", () => {
    expect(emailSrc).toContain("aisportsbettingmodels.com/feed/model/mlb");
    expect(emailSrc).not.toMatch(/aisportsbettingmodels\.com\/feed(?!\/model)/);
  });

  it("Discord account-linking redirects carry state to the canonical feed", () => {
    expect(discordAuthSrc).toContain("/feed/model/mlb?discord_");
    expect(discordAuthSrc).not.toContain("/dashboard");
  });

  it("Discord login errors land on /login where the error banner lives", () => {
    expect(discordLoginSrc).not.toMatch(/redirect\(302, `\/\?/);
    expect(discordLoginSrc).toContain("/login?discord_error=");
  });

  it("Discord login sanitizes returnPath against open redirects", () => {
    expect(discordLoginSrc).toMatch(/function sanitizeReturnPath/);
    expect(discordLoginSrc).toMatch(
      /sanitizeReturnPath\(req\.query\.returnPath\)/
    );
    expect(discordLoginSrc).toMatch(
      /sanitizeReturnPath\(payload\.returnPath\)/
    );
  });

  it("Discord invite success lands on the canonical feed", () => {
    expect(discordInviteSrc).toContain('res.redirect(302, "/feed/model/mlb")');
  });
});

describe("Legacy slug eradication — client router", () => {
  it("App.tsx no longer routes ModelProjections or SplitsLive", () => {
    expect(appSrc).not.toMatch(/ModelProjections/);
    expect(appSrc).not.toMatch(/SplitsLive/);
  });

  it("legacy slugs are wouter Redirects into the canonical helpers", () => {
    // whitespace-tolerant: prettier may fold the route JSX across lines
    const flat = appSrc.replace(/\s+/g, " ");
    expect(flat).toMatch(
      /path="\/feed"> ?\{\(\) => ?\( ?<Redirect to=\{legacyFeedRedirectTarget\(window\.location\.search\)\} replace \/> ?\) ?\}|path="\/feed">\{\(\) => <Redirect to=\{legacyFeedRedirectTarget\(window\.location\.search\)\} replace \/>/
    );
    expect(flat).toMatch(
      /path="\/splits"> ?\{\(\) => <Redirect to=\{bettingSplitsPath\(\)\} replace \/>/
    );
    expect(flat).toMatch(
      /path="\/dashboard"> ?\{\(\) => ?\(? ?<Redirect to=\{feedModelPath\("MLB"\)\} replace \/>/
    );
    expect(flat).toMatch(
      /path="\/projections"> ?\{\(\) => ?\(? ?<Redirect to=\{feedModelPath\("MLB"\)\} replace \/>/
    );
  });

  it("canonical routes stay registered behind RequireAuth", () => {
    expect(appSrc).toMatch(/path="\/feed\/model\/:sport\/:date"/);
    expect(appSrc).toMatch(/path="\/feed\/model\/:sport"/);
    expect(appSrc).toMatch(
      /path="\/betting-splits\/:sport\/:date">[\s\S]*?<StandaloneSplitsRoute[\s\S]*?sportSegment=\{p\.sport\}[\s\S]*?dateSegment=\{p\.date\}[\s\S]*?\/>/
    );
    expect(appSrc).toMatch(
      /path="\/betting-splits\/:sport">[\s\S]*?<StandaloneSplitsRoute sportSegment=\{p\.sport\} \/>/
    );
    // Splits render target: behind RequireAuth, fed by the parsed canonical
    // URL, and carrying explicit date provenance so auto-advance can tell an
    // app default from a deliberate deep link.
    expect(appSrc).toMatch(
      /<RequireAuth>\s*<BettingSplits[\s\S]*?initialSport=\{parsed\.sport\}[\s\S]*?initialDate=\{parsed\.isoDate\}[\s\S]*?initialDateSource=\{[\s\S]*?\/>\s*<\/RequireAuth>/
    );
  });

  it("RootRoute lands authenticated users on the canonical feed", () => {
    expect(appSrc).toMatch(/const target = feedModelPath\("MLB"\)/);
    expect(appSrc).not.toMatch(/navigate\("\/splits"\)/);
  });
});

describe("Legacy slug eradication — navigation hooks", () => {
  it("mobile tab config carries no query-string hooks", () => {
    expect(configSrc).not.toMatch(/\?tab=/);
    expect(configSrc).toMatch(/"\/feed\/model\/mlb"/);
    expect(configSrc).toMatch(/"\/betting-splits\/NCAAF"/);
    expect(configSrc).toMatch(/"\/bet-tracker"/);
  });

  it("floating nav never falls back to full-page query navigation", () => {
    expect(tabsSrc).not.toMatch(/window\.location\.href/);
    expect(tabsSrc).not.toMatch(/tab\.path\.includes\("\?"\)/);
    // Real links: destinations render as wouter <Link> anchors, not buttons.
    expect(tabsSrc).toMatch(/import \{ Link, useLocation \} from "wouter"/);
  });

  it("login returnPath uses the shared viewport-aware default, never /splits", () => {
    expect(homeSrc).toMatch(
      /import \{ resolvePostLoginPath \} from "\.\/dime-shell\/breakpoints"/
    );
    // [2026-07-12] /login no longer force-redirects authenticated visitors
    // (account switching); the shared resolver is still the only path source.
    expect(homeSrc).toMatch(
      /resolvePostLoginPath\((?:explicitReturnPath|explicit|searchParams\.get\("returnPath"\)|null)\)/
    );
    expect(homeSrc).not.toMatch(/\?\? "\/splits"/);
  });
});
