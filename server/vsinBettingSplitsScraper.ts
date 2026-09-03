/**
 * vsinBettingSplitsScraper.ts
 *
 * Scrapes VSiN DraftKings betting splits from exactly two canonical URLs:
 *
 *   https://data.vsin.com/betting-splits/?source=DK&view=today    (today's games)
 *   https://data.vsin.com/betting-splits/?source=DK&view=tomorrow (tomorrow's games)
 *
 * Both URLs serve ALL sports (MLB, NBA, NHL, CBB, CFB) from a single unified page.
 * NO other VSIN URLs are used for betting splits. No sport-specific subpages.
 * No auth required — data is publicly accessible.
 *
 * ─── sp-table row structure (11 <td> cells per game row, 0-indexed) ───────────
 *   td[0]:  action cell — contains <button data-gamecode="20260330MLB00008">
 *   td[1]:  team cell  — contains <a class="sp-team-link" href="/mlb/teams/minnesota-twins">
 *   td[2]:  spread/run-line value (ignored — we only need percentages)
 *   td[3]:  spread handle %  ← away team row = away handle; home row = home handle
 *   td[4]:  spread bets %    ← away team row = away bets;   home row = home bets
 *   td[5]:  total line value (ignored)
 *   td[6]:  total handle %   ← away row = over handle
 *   td[7]:  total bets %     ← away row = over bets
 *   td[8]:  moneyline value (ignored)
 *   td[9]:  ML handle %      ← away team row = away ML handle
 *   td[10]: ML bets %        ← away team row = away ML bets
 *
 * Column order is IDENTICAL for all sports (NBA, MLB, NHL, CBB, CFB).
 * Game rows come in pairs: away row first, home row second.
 * We only read the away row for all percentages.
 * Sport is detected from the data-gamecode value (e.g. "20260330MLB00008" → MLB).
 */

import * as cheerio from "cheerio";

export type VsinSplitsSport = "NBA" | "CBB" | "CFB" | "NHL" | "MLB";

export interface VsinSplitsGame {
  /** VSiN game ID, e.g. "20260330MLB00008" */
  gameId: string;
  /** Sport: "NBA" | "CBB" | "CFB" | "NHL" | "MLB" */
  sport: VsinSplitsSport;
  /** Away team VSiN slug, e.g. "minnesota-twins" */
  awayVsinSlug: string;
  /** Home team VSiN slug, e.g. "kansas-city-royals" */
  homeVsinSlug: string;
  /** Away team display name from VSiN */
  awayName: string;
  /** Home team display name from VSiN */
  homeName: string;
  /** % of spread/run-line handle on away team (0-100), null if not available */
  spreadAwayMoneyPct: number | null;
  /** % of spread/run-line bets on away team (0-100), null if not available */
  spreadAwayBetsPct: number | null;
  /** % of total handle on Over (0-100), null if not available */
  totalOverMoneyPct: number | null;
  /** % of total bets on Over (0-100), null if not available */
  totalOverBetsPct: number | null;
  /** % of ML handle on away team (0-100), null if not available */
  mlAwayMoneyPct: number | null;
  /** % of ML bets on away team (0-100), null if not available */
  mlAwayBetsPct: number | null;
}

// ── The ONLY two URLs used for VSIN betting splits ───────────────────────────
const VSIN_TODAY_URL =
  "https://data.vsin.com/betting-splits/?source=DK&view=today";
const VSIN_TOMORROW_URL =
  "https://data.vsin.com/betting-splits/?source=DK&view=tomorrow";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://data.vsin.com/",
};

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extract the first integer percentage from a <td> element.
 * Looks for text matching "XX%" inside sp-badge spans.
 * Strips arrow indicators (▲▼) before parsing.
 * Returns null if not found or if the badge has no numeric content.
 */
function extractPctFromTd($: cheerio.CheerioAPI, td: any): number | null {
  const badge = $(td).find("span.sp-badge").first();
  if (!badge.length) return null;
  const raw = badge.clone().find("span").remove().end().text().trim();
  const m = raw.match(/(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract VSiN team slug from an anchor href.
 * e.g. "/mlb/teams/minnesota-twins" → "minnesota-twins"
 */
function extractVsinSlug(href: string): string {
  const parts = href.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Detect sport from a VSiN game ID string.
 * e.g. "20260330MLB00008" → "MLB"
 */
function detectSportFromGameId(gameId: string): VsinSplitsSport | null {
  const m = gameId.match(/^\d{8}([A-Z]+)\d+$/);
  if (!m) return null;
  const code = m[1];
  if (code === "NBA") return "NBA";
  if (code === "CBB") return "CBB";
  if (code === "CFB") return "CFB";
  if (code === "NHL") return "NHL";
  if (code === "MLB") return "MLB";
  return null;
}

/**
 * Parse all game rows from all sp-table blocks on a page.
 * Optionally filter to a specific sport.
 */
function parseAllSpTables(
  $: cheerio.CheerioAPI,
  logTag: string,
  filterSport?: VsinSplitsSport
): VsinSplitsGame[] {
  const tables = $("table.sp-table");

  if (!tables.length) {
    // Fallback: check for legacy freezetable format
    const legacyTable = $("table.freezetable");
    if (legacyTable.length) {
      console.warn(
        `${logTag} ⚠️  Found legacy freezetable — VSiN may have reverted to old format. Scraper update required.`
      );
    } else {
      console.error(
        `${logTag} ❌ No sp-table or freezetable found — page structure unknown`
      );
    }
    return [];
  }

  console.log(`${logTag} Found ${tables.length} sp-table block(s)`);
  const allResults: VsinSplitsGame[] = [];

  tables.each((_i, table) => {
    const sportHeader = $(table).find("th.sp-sport-name").text().trim();
    const blockSport = sportHeader.includes("NBA")
      ? "NBA"
      : sportHeader.includes("MLB")
        ? "MLB"
        : sportHeader.includes("NHL")
          ? "NHL"
          : sportHeader.includes("CFB")
            ? "CFB"
            : sportHeader.includes("CBB") || sportHeader.includes("College")
              ? "CBB"
              : null;

    const blockTag = `${logTag}[${blockSport ?? "UNKNOWN"}]`;
    console.log(
      `${blockTag} Parsing block (header: "${sportHeader.substring(0, 60)}")`
    );

    // Collect sp-row rows (skip header rows)
    const gameRows: cheerio.Cheerio<any>[] = [];
    $(table)
      .find("tr.sp-row")
      .each((_j, row) => {
        gameRows.push($(row));
      });

    console.log(
      `${blockTag} Found ${gameRows.length} sp-row rows (${Math.floor(gameRows.length / 2)} games)`
    );

    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < gameRows.length - 1; i += 2) {
      const awayRow = gameRows[i];
      const homeRow = gameRows[i + 1];

      // Extract game ID
      const gameId =
        awayRow.find("button[data-gamecode]").attr("data-gamecode") ?? "";
      if (!gameId) {
        console.warn(`${blockTag} Row pair ${i}: no data-gamecode, skipping`);
        skipped++;
        continue;
      }

      // Detect sport from game ID
      const sport = detectSportFromGameId(gameId);
      if (!sport) {
        console.warn(
          `${blockTag} Game ${gameId}: unrecognized sport code, skipping`
        );
        skipped++;
        continue;
      }

      // Apply sport filter
      if (filterSport && sport !== filterSport) {
        continue; // silently skip — different sport block
      }

      // Extract team slugs and names
      const awayLink = awayRow.find("a.sp-team-link").first();
      const homeLink = homeRow.find("a.sp-team-link").first();

      if (!awayLink.length || !homeLink.length) {
        console.warn(
          `${blockTag} Game ${gameId}: missing sp-team-link, skipping`
        );
        skipped++;
        continue;
      }

      const awayName = awayLink.text().trim();
      const homeName = homeLink.text().trim();
      const awayVsinSlug = extractVsinSlug(awayLink.attr("href") ?? "");
      const homeVsinSlug = extractVsinSlug(homeLink.attr("href") ?? "");

      if (!awayVsinSlug || !homeVsinSlug) {
        console.warn(
          `${blockTag} Game ${gameId}: empty slug (away="${awayVsinSlug}" home="${homeVsinSlug}"), skipping`
        );
        skipped++;
        continue;
      }

      // Validate column count
      const awayTds = awayRow.find("td");
      if (awayTds.length < 11) {
        console.warn(
          `${blockTag} Game ${gameId}: expected 11 tds, got ${awayTds.length}, skipping`
        );
        skipped++;
        continue;
      }

      // Extract all six percentage values from the away row
      // td[3]=spread_handle%, td[4]=spread_bets%
      // td[6]=total_handle%,  td[7]=total_bets%
      // td[9]=ml_handle%,     td[10]=ml_bets%
      const spreadAwayMoneyPct = extractPctFromTd($, awayTds.eq(3));
      const spreadAwayBetsPct = extractPctFromTd($, awayTds.eq(4));
      const totalOverMoneyPct = extractPctFromTd($, awayTds.eq(6));
      const totalOverBetsPct = extractPctFromTd($, awayTds.eq(7));
      const mlAwayMoneyPct = extractPctFromTd($, awayTds.eq(9));
      const mlAwayBetsPct = extractPctFromTd($, awayTds.eq(10));

      console.log(
        `${blockTag} ✅ ${gameId} | ${sport} | ${awayName} @ ${homeName}` +
          ` | Spread: ${spreadAwayMoneyPct ?? "—"}%H ${spreadAwayBetsPct ?? "—"}%B` +
          ` | Total: ${totalOverMoneyPct ?? "—"}%H ${totalOverBetsPct ?? "—"}%B` +
          ` | ML: ${mlAwayMoneyPct ?? "—"}%H ${mlAwayBetsPct ?? "—"}%B`
      );

      allResults.push({
        gameId,
        sport,
        awayVsinSlug,
        homeVsinSlug,
        awayName,
        homeName,
        spreadAwayMoneyPct,
        spreadAwayBetsPct,
        totalOverMoneyPct,
        totalOverBetsPct,
        mlAwayMoneyPct,
        mlAwayBetsPct,
      });

      processed++;
    }

    console.log(
      `${blockTag} Parsed ${processed} games, skipped ${skipped} pairs`
    );
  });

  return allResults;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scrapes ONE of the two canonical VSIN URLs.
 *
 * @param view - "today" → VSIN_TODAY_URL | "tomorrow" → VSIN_TOMORROW_URL
 * @param filterSport - Optional: only return games for this sport
 */
export async function scrapeVsinBettingSplits(
  view: "today" | "tomorrow" = "today",
  filterSport?: VsinSplitsSport
): Promise<VsinSplitsGame[]> {
  const url = view === "today" ? VSIN_TODAY_URL : VSIN_TOMORROW_URL;
  const logTag = `[VSiNSplits][${view}${filterSport ? `/${filterSport}` : ""}]`;
  console.log(`${logTag} Fetching ${url} ...`);
  const startTime = Date.now();

  const resp = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`${logTag} HTTP ${resp.status} fetching ${url}`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);

  const results = parseAllSpTables($, logTag, filterSport);

  console.log(
    `${logTag} ✅ DONE — ${results.length} games parsed in ${Date.now() - startTime}ms`
  );
  return results;
}

/**
 * Scrapes BOTH canonical URLs (today + tomorrow) and merges results.
 *
 * Fetches in parallel for speed. Deduplicates by gameId — today takes priority.
 * This is the primary entry point for all three sports (MLB, NBA, NHL).
 *
 * @param filterSport - Optional: only return games for this sport
 */
export async function scrapeVsinBettingSplitsBothDays(
  filterSport?: VsinSplitsSport
): Promise<VsinSplitsGame[]> {
  const logTag = `[VSiNSplits][both${filterSport ? `/${filterSport}` : ""}]`;
  console.log(`${logTag} Fetching view=today + view=tomorrow in parallel...`);
  const startTime = Date.now();

  const [todayResult, tomorrowResult] = await Promise.allSettled([
    scrapeVsinBettingSplits("today", filterSport),
    scrapeVsinBettingSplits("tomorrow", filterSport),
  ]);

  const todayGames =
    todayResult.status === "fulfilled" ? todayResult.value : [];
  const tomorrowGames =
    tomorrowResult.status === "fulfilled" ? tomorrowResult.value : [];

  if (todayResult.status === "rejected") {
    console.error(`${logTag} ❌ view=today fetch failed:`, todayResult.reason);
  }
  if (tomorrowResult.status === "rejected") {
    console.error(
      `${logTag} ❌ view=tomorrow fetch failed:`,
      tomorrowResult.reason
    );
  }

  // Deduplicate: today takes priority over tomorrow
  const seen = new Set<string>();
  const merged: VsinSplitsGame[] = [];

  for (const g of todayGames) {
    seen.add(g.gameId);
    merged.push(g);
  }
  for (const g of tomorrowGames) {
    if (!seen.has(g.gameId)) {
      seen.add(g.gameId);
      merged.push(g);
    }
  }

  // Health check: warn if both views returned 0 games for the filtered sport
  if (
    merged.length === 0 &&
    (todayGames.length > 0 || tomorrowGames.length > 0)
  ) {
    console.warn(
      `${logTag} ⚠️  WARN: today=${todayGames.length} tomorrow=${tomorrowGames.length} but merged=0 ` +
        `— sport filter "${filterSport}" may not match any game codes on these pages`
    );
  }

  console.log(
    `${logTag} ✅ DONE — today=${todayGames.length} tomorrow=${tomorrowGames.length} merged=${merged.length} in ${Date.now() - startTime}ms`
  );
  return merged;
}

/**
 * Convenience alias: scrape MLB splits from both canonical URLs.
 * Equivalent to scrapeVsinBettingSplitsBothDays("MLB").
 */
export async function scrapeVsinMlbBettingSplits(): Promise<VsinSplitsGame[]> {
  return scrapeVsinBettingSplitsBothDays("MLB");
}

/**
 * Convenience alias: scrape NBA splits from both canonical URLs.
 * Equivalent to scrapeVsinBettingSplitsBothDays("NBA").
 */
export async function scrapeVsinNbaBettingSplits(): Promise<VsinSplitsGame[]> {
  return scrapeVsinBettingSplitsBothDays("NBA");
}

/**
 * Convenience alias: scrape NHL splits from both canonical URLs.
 * Equivalent to scrapeVsinBettingSplitsBothDays("NHL").
 */
export async function scrapeVsinNhlBettingSplits(): Promise<VsinSplitsGame[]> {
  return scrapeVsinBettingSplitsBothDays("NHL");
}
