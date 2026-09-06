/**
 * Feed responsive rebuild — rendered-layout harness (2026-08-02)
 * ═════════════════════════════════════════════════════════════
 * Law: design-system/dime-ai/pages/ai-model-projections.md
 * ("Owner Directives — 2026-08-02 (responsive rebuild — container-driven law)").
 *
 * Proves the CONTAINER-driven contracts in a real browser against the BUILT
 * artifact (same rationale as e2e/feed-desktop.spec.ts — container queries and
 * sticky offsets are exactly what a dev-server tree can paper over):
 *
 *   1. Columns are a pure function of league-body width: 3 at >=940px,
 *      2 at >=622px, else 1 — measured, not assumed, and identical logic in
 *      the shell pane and the standalone page.
 *   2. Zero page-level horizontal overflow at every width (320 → 1512).
 *   3. Summary anatomy is width-deterministic and UNIFORM: at <=520px card
 *      width every priced card is the fixed two-row grid; above it every
 *      priced card is one nowrap line. Never mixed within a width.
 *   4. The markets-trigger label and pitcher names render on ONE line at
 *      every card width (the old desktop 3-across band wrapped both).
 *   5. The full league name renders unclipped at the 320px floor.
 *   6. Sticky feedhead offset always equals the topbar band (one variable).
 *   7. Interactive targets keep their 44px floors.
 *   8. Dark/light parity: same geometry, correct chip tokens.
 *   9. 200% text zoom: no page overflow, no second-line trigger/name.
 *
 * Fixture rationale: LONG_PICK_GAME's model edge lands on "White Sox ML" (a
 * deliberately long spelled-out pick) while SHORT_PICK_GAME's is "Under 7" —
 * under the retired content-driven wrap these two rendered DIFFERENT summary
 * anatomies side-by-side at 3-across; the law now forbids exactly that.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import os from "node:os";

const REPO_ROOT = process.cwd();
const PREFERRED_PORT = 5311;
const SESSION_SECRET = "testsecret";
const GAME_DATE = "2026-07-23";
const DATE_SLUG = "mlb-07-23-2026";
const FEED_PATH = `/feed/model/${DATE_SLUG}`;

let serverProcess: ChildProcess | null = null;
let tlsProxy: https.Server | null = null;
let baseURL = "";

/**
 * HTTPS front for the app server — the harness must be prod-shaped.
 *
 * The production server sends CSP `upgrade-insecure-requests` (correct and
 * inert on the real HTTPS origin). Served over plain HTTP loopback instead,
 * WebKit — unlike Chromium/Firefox, which exempt loopback — upgrades every
 * subresource to https://, where nothing listens, and the app never boots.
 * An earlier repair intercepted those upgraded requests with Playwright
 * route-fulfill, but feeding module scripts through interception broke a
 * fragile lazy-mount path in the minified bundle (WebKit-only, deterministic
 * at mobile widths, NOT reproducible against the real origin — verified live).
 *
 * A real TLS reverse proxy removes the artifact entirely: every engine loads
 * the built artifact over genuine HTTPS exactly like production, the CSP
 * directive is a natural no-op, and no app asset is ever intercepted.
 * The self-signed cert is minted per-run; contexts trust it via the config's
 * `ignoreHTTPSErrors`.
 */
async function startTlsProxy(appPort: number): Promise<number> {
  const certDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "feed-responsive-tls-")
  );
  const keyPath = path.join(certDir, "tls.key");
  const crtPath = path.join(certDir, "tls.crt");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${crtPath}" ` +
      `-days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"`,
    { stdio: "ignore" }
  );
  tlsProxy = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) },
    (req, res) => {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: appPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${appPort}` },
        },
        ur => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        }
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end("tls proxy upstream error");
      });
      req.pipe(upstream);
    }
  );
  await new Promise<void>(resolve => tlsProxy!.listen(0, "127.0.0.1", resolve));
  const address = tlsProxy.address();
  if (address === null || typeof address === "string")
    throw new Error("tls proxy failed to bind");
  return address.port;
}

function waitForServerReady(
  proc: ChildProcess,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `prod server did not report ready within ${timeoutMs}ms. Output so far:\n${buffer}`
        )
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = /Server running on http:\/\/localhost:(\d+)\//.exec(buffer);
      if (m) {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        resolve(parseInt(m[1], 10));
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
    proc.on("exit", code => {
      clearTimeout(timer);
      reject(
        new Error(`prod server exited early (code ${code}). Output:\n${buffer}`)
      );
    });
    proc.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const distEntry = path.join(REPO_ROOT, "dist", "index.js");
  if (!fs.existsSync(distEntry)) {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });
  }
  serverProcess = spawn("node", ["dist/index.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PREFERRED_PORT),
      APP_SESSION_SECRET: SESSION_SECRET,
      DISABLE_BACKGROUND_JOBS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const boundPort = await waitForServerReady(serverProcess, 60_000);
  const tlsPort = await startTlsProxy(boundPort);
  baseURL = `https://127.0.0.1:${tlsPort}`;
});

test.afterAll(async () => {
  tlsProxy?.close();
  if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGTERM");
});

// ─── Fixtures (shapes carried from e2e/feed-desktop.spec.ts) ────────────────

const STUB_USER = {
  id: 1,
  email: "prez@aisportsbettingmodels.com",
  username: "prez",
  role: "user",
  hasAccess: true,
  expiryDate: null,
  termsAccepted: true,
  discordId: null,
  discordUsername: null,
  discordAvatar: null,
  discordConnectedAt: null,
  sessionExpiresAt: null,
  stripePlanId: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  cancelAtPeriodEnd: false,
};

function mlbRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    gameDate: GAME_DATE,
    startTimeEst: "7:05 PM",
    sport: "MLB",
    gameStatus: "upcoming",
    awayScore: null,
    homeScore: null,
    gameClock: null,
    venue: "Fenway Park",
    doubleHeader: "N",
    gameNumber: 1,
    awayML: null,
    homeML: null,
    awayRunLine: null,
    homeRunLine: null,
    awayRunLineOdds: null,
    homeRunLineOdds: null,
    awayBookSpread: null,
    homeBookSpread: null,
    bookTotal: null,
    overOdds: null,
    underOdds: null,
    modelRunAt: "2026-07-23T10:00:00Z",
    modelAwayML: null,
    modelHomeML: null,
    modelAwayWinPct: null,
    modelHomeWinPct: null,
    modelTotal: null,
    modelOverRate: null,
    modelUnderRate: null,
    modelOverOdds: null,
    modelUnderOdds: null,
    modelAwaySpreadOdds: null,
    modelHomeSpreadOdds: null,
    modelAwayPLOdds: null,
    modelHomePLOdds: null,
    ...overrides,
  };
}

// Long spelled-out pick ("White Sox ML" — the away ML edge).
const LONG_PICK_GAME = mlbRow({
  id: 501,
  awayTeam: "CHW",
  homeTeam: "TB",
  startTimeEst: "6:05 PM",
  venue: "Tropicana Field",
  awayML: 123,
  homeML: -145,
  modelAwayML: -125,
  modelHomeML: 105,
  modelAwayWinPct: 55.5,
  modelHomeWinPct: 44.5,
});

// Short pick ("Under 7" total edge) — the row-mate that used to stay one-line
// while LONG_PICK_GAME wrapped.
const SHORT_PICK_GAME = mlbRow({
  id: 502,
  awayTeam: "SF",
  homeTeam: "SEA",
  startTimeEst: "9:10 PM",
  venue: "T-Mobile Park",
  bookTotal: 7,
  overOdds: -108,
  underOdds: -112,
  modelOverOdds: 118,
  modelUnderOdds: -136,
});

// Zero edges → PASS.
const PASS_GAME = mlbRow({
  id: 503,
  awayTeam: "ATH",
  homeTeam: "TEX",
  startTimeEst: "6:35 PM",
  venue: "Globe Life Field",
  awayML: 130,
  homeML: -150,
  modelAwayML: 128,
  modelHomeML: -148,
  modelAwayWinPct: 42.5,
  modelHomeWinPct: 57.5,
  awayRunLine: 1.5,
  homeRunLine: -1.5,
  awayRunLineOdds: -110,
  homeRunLineOdds: -110,
  modelAwaySpreadOdds: -112,
  modelHomeSpreadOdds: -108,
  bookTotal: 8,
  overOdds: -110,
  underOdds: -110,
  modelOverOdds: -112,
  modelUnderOdds: -108,
});

// Final → lifecycle-compact anatomy.
const FINAL_GAME = mlbRow({
  id: 504,
  awayTeam: "LAD",
  homeTeam: "NYY",
  startTimeEst: "1:05 PM",
  venue: "Yankee Stadium",
  gameStatus: "final",
  awayScore: 3,
  homeScore: 5,
  awayML: -110,
  homeML: -105,
  modelAwayML: -145,
  modelHomeML: 125,
  modelAwayWinPct: 59.2,
  modelHomeWinPct: 40.8,
});

function lineupRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    gameId: 1,
    scrapedAt: 1_721_740_000_000,
    awayPitcherName: null,
    awayPitcherHand: null,
    awayPitcherEra: null,
    awayPitcherRotowireId: null,
    awayPitcherMlbamId: null,
    awayPitcherConfirmed: false,
    homePitcherName: null,
    homePitcherHand: null,
    homePitcherEra: null,
    homePitcherRotowireId: null,
    homePitcherMlbamId: null,
    homePitcherConfirmed: false,
    awayLineup: null,
    homeLineup: null,
    awayLineupConfirmed: false,
    homeLineupConfirmed: false,
    ...overrides,
  };
}

// Long names on purpose — the exact strings the audit measured wrapping.
const LINEUPS_BY_GAME_ID = {
  501: lineupRow({
    gameId: 501,
    awayPitcherName: "Matthew Liberatore",
    awayPitcherHand: "L",
    awayPitcherEra: "5-8 · 4.02 ERA",
    awayPitcherRotowireId: 14201,
    awayPitcherConfirmed: true,
    homePitcherName: "Simeon Woods Richardson",
    homePitcherHand: "R",
    homePitcherEra: "7-7 · 4.18 ERA",
    homePitcherRotowireId: 10755,
    homePitcherConfirmed: false,
  }),
  502: lineupRow({
    gameId: 502,
    awayPitcherName: "Logan Webb",
    awayPitcherHand: "R",
    awayPitcherEra: "7-4 · 3.21 ERA",
    awayPitcherRotowireId: 14222,
    awayPitcherConfirmed: true,
    homePitcherName: "George Kirby",
    homePitcherHand: "R",
    homePitcherEra: "8-5 · 3.62 ERA",
    homePitcherRotowireId: 15669,
    homePitcherConfirmed: false,
  }),
};

async function stubApi(page: Page, ncaafGames?: Record<string, unknown>[]) {
  await page.route("**/api/trpc/**", route => {
    const url = new URL(route.request().url());
    const ops = decodeURIComponent(
      url.pathname.replace(/^.*\/api\/trpc\//, "")
    ).split(",");
    const inputs = JSON.parse(url.searchParams.get("input") ?? "{}");
    const body = ops.map((op, index) => {
      if (op === "appUsers.me")
        return { result: { data: { json: STUB_USER } } };
      if (op === "games.list")
        return {
          result: {
            data: {
              json:
                ncaafGames && inputs[index]?.json?.sport === "NCAAF"
                  ? ncaafGames
                  : [LONG_PICK_GAME, SHORT_PICK_GAME, PASS_GAME, FINAL_GAME],
            },
          },
        };
      if (op === "games.mlbLineups")
        return { result: { data: { json: LINEUPS_BY_GAME_ID } } };
      if (op === "wc2026.matchesByDate")
        return { result: { data: { json: [] } } };
      return {
        error: {
          json: {
            message: "stubbed offline (e2e)",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/api/dime/**", route =>
    route.fulfill({ status: 500, body: "stubbed offline (e2e)" })
  );
  // Offline-deterministic crest/portrait assets.
  const svg = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#333"/></svg>`;
  await page.route("https://www.mlbstatic.com/**", route =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svg(150, 150),
    })
  );
  await page.route("https://img.mlbstatic.com/**", route =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svg(180, 270),
    })
  );
  await page.route("https://www.rotowire.com/images/photos/**", route =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svg(250, 250),
    })
  );
}

async function gotoFeed(
  page: Page,
  width: number,
  height = 1400,
  colorScheme: "dark" | "light" = "dark"
) {
  await stubApi(page);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width, height });
  await page.addInitScript(mode => {
    localStorage.setItem("dime-theme", mode);
  }, colorScheme);
  await page.goto(`${baseURL}${FEED_PATH}?theme=${colorScheme}`);
  await page.waitForSelector(".projection-card", { timeout: 20_000 });
  await page.waitForTimeout(300);
}

interface GridMeasure {
  bodyWidth: number;
  columns: number;
  cardWidths: number[];
  pageOverflow: number;
}

async function measureGrid(page: Page): Promise<GridMeasure> {
  return page.evaluate(() => {
    const body = document.querySelector(".dmf-leaguebody")!;
    const cols = getComputedStyle(body).gridTemplateColumns.split(" ").length;
    const cards = [...body.querySelectorAll<HTMLElement>(".projection-card")];
    const scroller = document.scrollingElement!;
    return {
      bodyWidth: body.getBoundingClientRect().width,
      columns: cols,
      cardWidths: cards.map(c => c.getBoundingClientRect().width),
      pageOverflow: scroller.scrollWidth - scroller.clientWidth,
    };
  });
}

/** The law's column function — columns must equal this everywhere. */
function expectedColumns(bodyWidth: number): number {
  if (bodyWidth >= 940) return 3;
  if (bodyWidth >= 622) return 2;
  return 1;
}

/** True when the element's content renders on a single text line. */
async function isOneLine(page: Page, selector: string): Promise<boolean[]> {
  return page.evaluate(sel => {
    return [...document.querySelectorAll<HTMLElement>(sel)].map(el => {
      const s = getComputedStyle(el);
      const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
      return el.getBoundingClientRect().height < lh * 1.6;
    });
  }, selector);
}

const WIDTHS = [
  320, 360, 375, 390, 430, 640, 700, 767, 768, 900, 1024, 1229, 1231, 1280,
  1366, 1440, 1512,
];

test.describe("content-driven columns + zero overflow", () => {
  for (const width of WIDTHS) {
    test(`columns match the 622/940 law and the page never scrolls sideways at ${width}px`, async ({
      page,
    }) => {
      await gotoFeed(page, width);
      const g = await measureGrid(page);
      expect(g.pageOverflow, `page overflow at ${width}`).toBe(0);
      expect(g.columns, `columns for body ${g.bodyWidth}px`).toBe(
        expectedColumns(g.bodyWidth)
      );
      // Every card in a multi-column grid keeps its readable width.
      if (g.columns > 1) {
        for (const w of g.cardWidths) expect(w).toBeGreaterThanOrEqual(295);
      }
    });
  }
});

test.describe("uniform summary anatomy (width-deterministic, never mixed)", () => {
  for (const width of [390, 768, 1280, 1512]) {
    test(`every priced card shares one anatomy at ${width}px`, async ({
      page,
    }) => {
      await gotoFeed(page, width);
      const anatomies = await page.evaluate(() => {
        return [...document.querySelectorAll<HTMLElement>(".projection-card")]
          .filter(card => card.querySelector(".summary__signal"))
          .map(card => {
            const cardW = card.getBoundingClientRect().width;
            const group = card.querySelector<HTMLElement>(".summary__group")!;
            const readout =
              card.querySelector<HTMLElement>(".summary__readout")!;
            const signal = card.querySelector<HTMLElement>(".summary__signal")!;
            const twoRow =
              signal.getBoundingClientRect().top >=
              readout.getBoundingClientRect().bottom - 2;
            return { cardW, display: getComputedStyle(group).display, twoRow };
          });
      });
      expect(anatomies.length).toBeGreaterThan(0);
      for (const a of anatomies) {
        const expectTwoRow = a.cardW <= 520;
        expect(a.display, `group display at card ${a.cardW}px`).toBe(
          expectTwoRow ? "grid" : "flex"
        );
        expect(a.twoRow, `signal row position at card ${a.cardW}px`).toBe(
          expectTwoRow
        );
      }
      // Determinism: all priced cards at this width agree with each other.
      const modes = new Set(anatomies.map(a => a.twoRow));
      expect(modes.size, "mixed summary anatomies in one grid").toBe(1);
    });
  }
});

test.describe("one-line text contracts", () => {
  for (const width of [320, 390, 768, 1280, 1512]) {
    test(`trigger label and pitcher names hold one line at ${width}px`, async ({
      page,
    }) => {
      await gotoFeed(page, width);
      for (const ok of await isOneLine(
        page,
        ".projection-card__markets-toggle > span"
      )) {
        expect(ok, "markets-trigger label wrapped").toBe(true);
      }
      for (const ok of await isOneLine(page, ".pregame-pitcher__name")) {
        expect(ok, "pitcher name wrapped").toBe(true);
      }
    });
  }

  test("full league name is unclipped at the 320px floor", async ({ page }) => {
    await gotoFeed(page, 320);
    const clipped = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        "#dmf-league-MLB .dmf-lgname"
      )!;
      return { sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent };
    });
    expect(clipped.text).toContain("Major League Baseball");
    expect(clipped.sw, "league name ellipsized at 320px").toBeLessThanOrEqual(
      clipped.cw + 1
    );
  });
});

test.describe("sticky chrome — one offset variable", () => {
  for (const width of [390, 767, 1024, 1512]) {
    test(`feedhead top equals the topbar band at ${width}px`, async ({
      page,
    }) => {
      await gotoFeed(page, width);
      const { feedheadTop, bandH, topbarVisible } = await page.evaluate(() => {
        const fh = document.querySelector<HTMLElement>(".dmf-feedhead")!;
        const root = document.querySelector<HTMLElement>(".dmf-root")!;
        const tb = document.querySelector<HTMLElement>(".dmf-topbar");
        return {
          feedheadTop: parseFloat(getComputedStyle(fh).top),
          bandH:
            parseFloat(
              getComputedStyle(root).getPropertyValue("--dmf-topbar-h")
            ) || (tb ? tb.getBoundingClientRect().height : NaN),
          topbarVisible: !!tb && getComputedStyle(tb).display !== "none",
        };
      });
      if (width < 768) {
        expect(
          await page
            .locator(".dmf-feedhead")
            .evaluate(el => getComputedStyle(el).position)
        ).toBe("relative");
        return;
      }
      // The sticky feedhead re-anchors exactly at the band's height — no
      // competing literals, no gaps, no overlap.
      if (topbarVisible) {
        const tbH = await page.evaluate(
          () =>
            document
              .querySelector<HTMLElement>(".dmf-topbar")!
              .getBoundingClientRect().height
        );
        expect(
          Math.abs(feedheadTop - tbH),
          `feedhead top ${feedheadTop} vs topbar ${tbH}`
        ).toBeLessThanOrEqual(0.5);
      } else {
        expect(feedheadTop).toBeGreaterThan(0);
        expect(Number.isNaN(bandH)).toBe(false);
      }
    });
  }
});

test.describe("interactive target floors", () => {
  test("date arrows (effective), next control, and LINEUPS keep >=44px", async ({
    page,
  }) => {
    await gotoFeed(page, 1512);
    const targets = await page.evaluate(() => {
      const sq = document.querySelector<HTMLElement>(
        ".feed-toolbar__icon-button"
      )!;
      const sqAfter = getComputedStyle(sq, "::after");
      const lineups = document.querySelector<HTMLElement>(
        ".pregame-pitchers__lineups"
      );
      const next = document.querySelector<HTMLElement>(".summary__next");
      // Compact-card LINEUPS is 32px visual + an invisible ::before extension
      // (inset-block: -6px) restoring the 44px WCAG floor — measure EFFECTIVE
      // height, not just the box (owner directive 2026-07-29).
      let lineupsEffective: number | null = null;
      if (lineups) {
        const before = getComputedStyle(lineups, "::before");
        const ext =
          before.content !== "none"
            ? Math.abs(parseFloat(before.top) || 0) +
              Math.abs(parseFloat(before.bottom) || 0)
            : 0;
        lineupsEffective = lineups.getBoundingClientRect().height + ext;
      }
      return {
        sqBox: sq.getBoundingClientRect().width,
        sqInset: sqAfter.inset || sqAfter.top,
        lineupsEffective,
        nextBox: next
          ? {
              w: next.getBoundingClientRect().width,
              h: next.getBoundingClientRect().height,
            }
          : null,
      };
    });
    expect(targets.sqBox).toBeGreaterThanOrEqual(44);
    if (targets.lineupsEffective != null)
      expect(targets.lineupsEffective).toBeGreaterThanOrEqual(43.5);
    if (targets.nextBox) {
      expect(targets.nextBox.w).toBeGreaterThanOrEqual(44);
      expect(targets.nextBox.h).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("theme parity", () => {
  for (const width of [390, 1440]) {
    test(`dark and light share geometry and correct chip tokens at ${width}px`, async ({
      page,
    }) => {
      await gotoFeed(page, width, 1400, "dark");
      const dark = await measureGrid(page);
      const darkChip = await page.evaluate(() => {
        const chip = document.querySelector<HTMLElement>(".edge-indicator");
        return chip ? getComputedStyle(chip).backgroundColor : null;
      });
      await gotoFeed(page, width, 1400, "light");
      const light = await measureGrid(page);
      const lightChip = await page.evaluate(() => {
        const chip = document.querySelector<HTMLElement>(".edge-indicator");
        return chip ? getComputedStyle(chip).backgroundColor : null;
      });
      expect(light.columns).toBe(dark.columns);
      expect(light.pageOverflow).toBe(0);
      // Owner September 5: EDGE is a quiet text value without a badge fill.
      expect(darkChip).toBe("rgba(0, 0, 0, 0)");
      expect(lightChip).toBe("rgba(0, 0, 0, 0)");
    });
  }
});

test.describe("text zoom (200%)", () => {
  for (const width of [1280, 390]) {
    test(`no page overflow and no wrapped trigger at 200% text scale, ${width}px`, async ({
      page,
    }) => {
      await gotoFeed(page, width);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () =>
          document.scrollingElement!.scrollWidth -
          document.scrollingElement!.clientWidth
      );
      expect(overflow, "page overflow at 200% zoom").toBe(0);
      for (const ok of await isOneLine(
        page,
        ".projection-card__markets-toggle > span"
      )) {
        expect(ok, "trigger label wrapped at 200% zoom").toBe(true);
      }
    });
  }
});

// Recorded September 6 publication shapes, not live provider/certification evidence.
const SEPTEMBER6_NCAAF = [
  mlbRow({
    id: 4350069,
    sport: "NCAAF",
    gameDate: "2026-09-06",
    venue: null,
    awayTeam: "WSU",
    homeTeam: "WASH",
    startTimeEst: "16:00",
    bookTotal: "51.5",
    overOdds: "-112",
    underOdds: "-108",
    modelRunAt: 1788721833550,
    awayModelSpread: "21.1",
    homeModelSpread: "-21.1",
    modelTotal: "52.1",
  }),
  mlbRow({
    id: 4350070,
    sport: "NCAAF",
    gameDate: "2026-09-06",
    venue: null,
    awayTeam: "WIS",
    homeTeam: "ND",
    startTimeEst: "19:30",
    modelRunAt: null,
    awayBookSpread: "21",
    homeBookSpread: "-21",
    awaySpreadOdds: "-105",
    homeSpreadOdds: "-115",
    bookTotal: "46.5",
    overOdds: "-108",
    underOdds: "-112",
    awayML: "1000",
    homeML: "-1800",
  }),
  mlbRow({
    id: 4350071,
    sport: "NCAAF",
    gameDate: "2026-09-06",
    venue: null,
    awayTeam: "LOU",
    homeTeam: "MISS",
    startTimeEst: "19:30",
    modelRunAt: null,
    awayBookSpread: "6.5",
    homeBookSpread: "-6.5",
    awaySpreadOdds: "-105",
    homeSpreadOdds: "-115",
    bookTotal: "55.5",
    overOdds: "-105",
    underOdds: "-115",
    awayML: "210",
    homeML: "-258",
  }),
];

test.describe("NCAAF Book/Model card summaries", () => {
  for (const width of [375, 768, 1024, 1440])
    for (const theme of ["dark", "light"] as const)
      test(`${width}px ${theme}: line-only and book-only summaries stay visible`, async ({
        page,
      }) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await stubApi(page, SEPTEMBER6_NCAAF);
        await page.setViewportSize({
          width,
          height: width === 375 ? 812 : 900,
        });
        await page.emulateMedia({
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await page.addInitScript(
          mode => localStorage.setItem("dime-theme", mode),
          theme
        );
        await page.goto(`${baseURL}/feed/model/09-06-2026?theme=${theme}`);
        const cards = page.locator("#dmf-league-NCAAF .projection-card");
        await expect(cards).toHaveCount(3);
        for (let i = 0; i < 3; i++) {
          const card = cards.nth(i);
          const slides = card.locator(".summary-carousel__slide");
          const count = i === 0 ? 4 : 6;
          await expect(slides).toHaveCount(count);
          await card.scrollIntoViewIfNeeded();
          for (let j = 0; j < count; j++) {
            const slide = slides.nth(j);
            await expect(slide.locator(".summary__item--book dt")).toHaveText(
              "Book"
            );
            const book = slide.locator(".summary__item--book dd");
            const model = slide.locator(".summary__item--model dd");
            await expect(book).toBeInViewport();
            await expect(model).toBeInViewport();
            if (i === 0)
              await expect(model).toHaveText(
                ["+21.1", "-21.1", "52.1", "52.1"][j]
              );
            else {
              await expect(model).toHaveText("—");
              await expect(
                slide.locator(".summary__comparison-status")
              ).toHaveText("Model unavailable");
              await expect(book).not.toHaveText("—");
            }
            const next = slide.locator("button");
            await next.focus();
            expect((await next.boundingBox())!.width).toBeGreaterThanOrEqual(
              44
            );
            await page.keyboard.press("Enter");
            await expect(
              slides.nth((j + 1) % count).locator("button")
            ).toBeFocused();
          }
          await expect(card.locator(".edge-indicator")).toHaveCount(0);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth - innerWidth
            )
          ).toBeLessThanOrEqual(1);
          await card.scrollIntoViewIfNeeded();
          await card.screenshot({
            path: `docs/audits/2026-09-06-ncaaf-card-book-model-evidence/screenshots/${width}-${theme}-${i}.png`,
          });
        }
        await expect(
          page.locator("#dmf-league-MLB .summary--priced").first()
        ).toBeAttached();
        expect(errors).toEqual([]);
      });
});
