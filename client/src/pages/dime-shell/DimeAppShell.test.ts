import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const shellSource = fs.readFileSync(
  path.join(import.meta.dirname, "DimeAppShell.tsx"),
  "utf8"
);
const chatSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "dime-chat", "DimeChatPage.tsx"),
  "utf8"
);
const appSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "App.tsx"),
  "utf8"
);
const feedSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "DimeModelFeed.tsx"),
  "utf8"
);
const splitsSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "BettingSplits.tsx"),
  "utf8"
);
const trackerSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "BetTracker.tsx"),
  "utf8"
);

describe("DimeAppShell integration contract", () => {
  // [PR #70 REMEDIATION 2026-07-12] /chat used to fall through to a SEPARATE
  // lazily-loaded component (the legacy pages/DimeChat.tsx shim, since
  // deleted) below 768px, while
  // >=768px mounted DimeAppShell at the same React tree position. Crossing
  // 768px therefore swapped which lazy component occupied that slot, which
  // remounted DimeChatPage — destroying conversation state, any in-flight
  // SSE stream, and the composer draft. The fix: ONE unified branch owns
  // /chat (and shellViewport-owned product routes) at every width, and only
  // DimeAppShell's `mode` prop changes across the boundary. See
  // e2e/chat-resize.spec.ts for the runtime (DOM-identity) proof this
  // source-shape suite cannot provide on its own.
  it("mounts DimeAppShell for chat at every width, and for other product routes only when the shared >=768 viewport owns them", () => {
    expect(appSource).toMatch(/const shellViewport = useDimeShellViewport\(\)/);
    expect(appSource).toMatch(
      /const chatShellOwnsRoute =\s*isChatLocation\(location\) \|\|\s*\(shellViewport && isDimeProductLocation\(location\)\)/
    );
    expect(appSource).toMatch(/if \(chatShellOwnsRoute\)[\s\S]*<DimeAppShell/);
    expect(appSource).toMatch(
      /const shellMode = shellViewport \? "shell" : "chat-only"/
    );
    // The standalone /chat Switch route is gone — chat is never reached by
    // the legacy <Switch> tree, at any width.
    expect(appSource).not.toMatch(/<Route path="\/chat">/);
    expect(appSource).not.toMatch(/DimeChatRoute/);
  });

  it("derives pane identity from Wouter location and keeps chat mounted via one conditional-props DimeChatPage element", () => {
    expect(shellSource).toMatch(
      /const \[location, navigate\] = useLocation\(\)/
    );
    expect(shellSource).toMatch(/parseDimeProductRoute\(location\)/);
    // Exactly one <DimeChatPage> element, at the tail of the render — only
    // its `shell` prop is conditional on `mode`. This is what keeps
    // DimeChatPage's component identity (and therefore its mounted state)
    // stable across an 768px crossing: React reconciles by element type +
    // position, never by the `mode` prop value.
    // (Narrowed to the JSX call site itself — prose in nearby comments also
    // mentions "<DimeChatPage>" when describing the contract.)
    expect(shellSource.match(/<DimeChatPage\n/g)).toHaveLength(1);
    expect(shellSource).toMatch(
      /shell=\{\s*mode !== "shell"\s*\?\s*undefined\s*:\s*\{/
    );
    expect(shellSource).toMatch(/mode\?: DimeAppShellMode/);
    expect(shellSource).toMatch(/mode = "shell",/);
    expect(chatSource).toMatch(
      /const chatActive = !shell \|\| shell\.renderedPane === "chat"/
    );
    expect(chatSource).toMatch(
      /aria-hidden=\{shell && !chatActive \? true : undefined\}/
    );
  });

  it("threads mode reactively into both the preview and RequireAuth-gated DimeAppShell mounts", () => {
    expect(appSource.match(/<DimeAppShell mode=\{shellMode\}/g)).toHaveLength(
      2
    );
  });

  it('gates shell-only bookkeeping (splits canonicalization, pane content, scroll/focus restore) on mode === "shell"', () => {
    expect(shellSource).toMatch(
      /if \(mode !== "shell"\) return;\s*\n\s*if \(actualRoute\.pane !== "splits"\) return;/
    );
    expect(shellSource).toMatch(
      /if \(mode !== "shell"\) return;\s*\n\s*renderedPaneRef\.current = renderedRoute\.pane;/
    );
    expect(shellSource).toMatch(/if \(mode === "shell"\) \{/);
  });

  it("retains the outgoing pane while lazy content resolves", () => {
    expect(shellSource).toMatch(/useDeferredValue\(actualRoute\)/);
    expect(shellSource).toMatch(
      /startTransition\(\(\) => navigate\(resolveRouteHref\(href\)\)\)/
    );
  });

  it("keeps the compile-time-gated preview capability across every shell pane and mode", () => {
    expect(appSource).toMatch(
      /const localPreview = allowsLocalDimePreview\([\s\S]*import\.meta\.env\.DEV/
    );
    expect(appSource).not.toMatch(
      /location === "\/chat" &&[\s\S]*allowsLocalDimePreview/
    );
    // localPreview is computed once and gates the WHOLE unified branch — it
    // is not re-derived per mode, so preview keeps working across the
    // 768px boundary in DEV (chat-only and shell modes alike).
    expect(appSource).toMatch(
      /localPreview \?[\s\S]*<DimeAppShell mode=\{shellMode\} previewMode \/>[\s\S]*:[\s\S]*<RequireAuth>[\s\S]*<DimeAppShell mode=\{shellMode\} \/>[\s\S]*<\/RequireAuth>/
    );
    expect(shellSource).toMatch(/withLocalDimePreview\(href, previewMode\)/);
    expect(shellSource).toMatch(
      /navigate\(resolveRouteHref\(canonical\), \{ replace: true \}\)/
    );
    // Combined feed (2026-07-18): date nav canonicalizes on the mlb- slug.
    expect(feedSource).toMatch(
      /feedModelPath\(sport === "NCAAF" \? "NCAAF" : "MLB", nextIso\)/
    );
    expect(splitsSource).toMatch(
      /setLocation\(resolveRouteHref\(bettingSplitsPath\(sport, selectedDate\)\)\)/
    );
  });

  it("shares one stable dated splits canonicalizer between standalone and shell owners", () => {
    expect(appSource).toMatch(
      /const canonical = canonicalBettingSplitsPath\(sportSegment, dateSegment\)/
    );
    expect(shellSource).toMatch(
      /const canonical = canonicalBettingSplitsPath\(\s*actualRoute\.sportSegment,\s*actualRoute\.dateSegment\s*\)/
    );
    // The canonical redirect must carry date provenance on the history entry:
    // a dated canonical URL alone cannot distinguish a deliberate deep link
    // from an application default, and auto-advance may only move defaults.
    expect(appSource).toMatch(
      /<Redirect[\s\S]*?to=\{canonical\}[\s\S]*?replace[\s\S]*?splitsDateSource:[\s\S]*?"url-explicit"[\s\S]*?"app-default"[\s\S]*?\/>/
    );
    expect(shellSource).toMatch(
      /navigate\(resolveRouteHref\(canonical\), \{ replace: true \}\)/
    );
  });

  it("carries the selected date on sport pushes and retains a sport-specific empty state", () => {
    const sportSwitchStart = splitsSource.indexOf(
      "const setSelectedSport = useCallback"
    );
    const sportSwitchEnd = splitsSource.indexOf(
      "const setSelectedDate = useCallback",
      sportSwitchStart
    );
    const sportSwitch = splitsSource.slice(sportSwitchStart, sportSwitchEnd);

    expect(sportSwitchStart).toBeGreaterThan(-1);
    expect(sportSwitch).toMatch(
      /setLocation\(resolveRouteHref\(bettingSplitsPath\(sport, selectedDate\)\)\)/
    );
    expect(sportSwitch).not.toMatch(/setSelectedDateState/);
    expect(sportSwitch).not.toMatch(/replace:\s*true/);
    expect(splitsSource).toMatch(/sortedDates\.length === 0 \?/);
    expect(splitsSource).toContain("`No ${selectedSport} games found.`");
  });

  it("restores per-pane scroll and focuses the exposed pane heading", () => {
    expect(shellSource).toMatch(/scrollPositionsRef/);
    expect(shellSource).toMatch(/externalScrollRef\.current\.scrollTop/);
    expect(shellSource).toMatch(/target\?\.focus\(\{ preventScroll: true \}\)/);
    expect(chatSource).toMatch(/className="dc-shell-sr-only"/);
    expect(chatSource).toMatch(
      /<main[\s\S]*ref=\{shell\.chatHeadingRef\}[\s\S]*>\s*Dime Chat\s*<\/h1>/
    );
    expect(chatSource).toMatch(/aria-hidden=\{!externalActive\}/);
  });

  // [PR #70 REMEDIATION 2026-07-12] Replaced an it.each([768,1024,1440])
  // whose per-pane loop asserted `[pane==="chat", pane!=="chat"]` filters to
  // one true — a tautology that passes for any source whatsoever. A
  // source-shape test also cannot vary by viewport width, so the width
  // parametrization asserted nothing either. The falsifiable contract is
  // that both pane-exposure flags derive as exact complements of the SAME
  // discriminator (shell.renderedPane === "chat"), pinned verbatim below:
  // fork either derivation (different state, flipped comparison) and this
  // fails. Runtime single-h1 exposure per width is e2e territory.
  it("derives chat/external heading exposure as exact complements of renderedPane", () => {
    expect(chatSource.match(/<h1\b/g)).toHaveLength(2);
    expect(chatSource).toMatch(
      /<main[\s\S]*?aria-hidden=\{shell && !chatActive \? true : undefined\}[\s\S]*?<h1[\s\S]*?>\s*Dime Chat\s*<\/h1>/
    );
    expect(chatSource).toMatch(
      /<section[\s\S]*?aria-hidden=\{!externalActive\}[\s\S]*?<h1[\s\S]*?>[\s\S]*?\{shell\.paneHeading\}[\s\S]*?<\/h1>/
    );
    expect(chatSource).toContain(
      'const chatActive = !shell || shell.renderedPane === "chat";'
    );
    expect(chatSource).toContain(
      'const externalActive = !!shell && shell.renderedPane !== "chat";'
    );
  });

  it("embeds feed with chrome suppression and tracker/splits heading demotion", () => {
    expect(shellSource).toMatch(/<DimeModelFeed[\s\S]*embeddedInShell/);
    // A11Y-NO-H1: embedded pages demote their own h1 (the shell pane's
    // sr-only heading is the page's sole h1), so the shell must say so.
    expect(shellSource).toMatch(
      /paneContent = <BetTracker previewMode=\{previewMode\} embeddedInShell \/>/
    );
    expect(shellSource).toMatch(/<BettingSplits[\s\S]*?embeddedInShell/);
  });

  it("renders tracker chrome in preview without granting protected query access", () => {
    expect(trackerSource).toMatch(
      /if \(!previewMode && !authLoading && !appUser\) navigate\("\/"\)/
    );
    expect(trackerSource).toMatch(
      /const canLoadProtectedData = canAccess && !!appUser/
    );
    expect(trackerSource).toMatch(
      /\{canLoadProtectedData && \(\s*<BetCalendar/
    );
    expect(trackerSource).toMatch(/if \(authLoading && !previewMode\)/);
  });

  // [PR #70 REMEDIATION 2026-07-12] This used to be titled "...when a
  // breakpoint unmounts chat" — that phrasing described the BUG (a resize
  // across 768px used to unmount DimeChatPage). Under the fixed contract a
  // breakpoint crossing only changes DimeAppShell's `mode` prop and never
  // unmounts DimeChatPage (proven at runtime by e2e/chat-resize.spec.ts).
  // This cleanup effect still matters for a REAL unmount — e.g. navigating
  // away from /chat and every shellViewport-owned product route entirely —
  // and that guarantee is unchanged, so the assertions stay as-is.
  it("aborts and disposes an active stream when DimeChatPage genuinely unmounts (never on a bare 768px resize)", () => {
    const cleanupStart = chatSource.indexOf("useEffect(\n    () => () => {");
    const cleanupEnd = chatSource.indexOf("    []", cleanupStart);
    const cleanup = chatSource.slice(cleanupStart, cleanupEnd);
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanup).toMatch(/abortRef\.current\?\.abort\(\)/);
    expect(cleanup).toMatch(/activeBatcherRef\.current\?\.dispose\(\)/);
    expect(cleanup).toMatch(/drawerAnimationRef\.current\?\.stop\(\)/);
  });

  it("keeps engagement-session tracking OFF the critical path (lazy SessionTracker, not a direct hook import)", () => {
    // Regression guard for the chat-critical-path bundle budget: the session
    // hook must be lazy-loaded, never imported straight into the shell chunk.
    expect(shellSource).toMatch(
      /lazy\(\(\) => import\("@\/components\/SessionTracker"\)\)/
    );
    expect(shellSource).toMatch(/<SessionTracker \/>/);
    expect(shellSource).not.toMatch(/from "@\/hooks\/useSessionTracking"/);
  });
});
