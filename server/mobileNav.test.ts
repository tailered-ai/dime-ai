/**
 * Mobile Floating Nav (mobileNav feature) — Test Suite
 * ═══════════════════════════════════════════════════════════
 * Tests feature flags, access decisions, destination config, active-route
 * matching, and logger. The feature directory keeps its historical
 * "mobileNav" name; the rendered surface is the top floating nav
 * (docs/plans/2026-07-18-mobile-floating-nav.md).
 * Run: pnpm test -- mobileNav
 */

import { describe, it, expect, beforeEach } from "vitest";

// We test the pure logic modules (config + activeTab + logger) which are
// framework-agnostic and can be imported directly without React/DOM.

import {
  MOBILE_NAV_TABS,
  MOBILE_NAV_ENABLED,
  MOBILE_NAV_DEBUG_PANEL,
  CHAT_TAB_INDEX,
  decideMobileNavAccess,
} from "../client/src/features/mobileNav/config";

import { getActiveTabId } from "../client/src/features/mobileNav/activeTab";
import { mobileNavLogger } from "../client/src/features/mobileNav/logger";

describe("Mobile Floating Nav — Config & Feature Flags", () => {
  it("should have exactly 5 destinations defined", () => {
    expect(MOBILE_NAV_TABS).toHaveLength(5);
  });

  it("should have the mandated order: Feed, Tools, Chat, Bet Tracker, Profile", () => {
    expect(MOBILE_NAV_TABS.map(t => t.id)).toEqual([
      "feed",
      "tools",
      "chat",
      "tracker",
      "profile",
    ]);
    expect(MOBILE_NAV_TABS.map(t => t.label)).toEqual([
      "Feed",
      "Tools",
      "Chat",
      "Tracker", // short visible label; full name "Bet Tracker" lives in the aria-label
      "Profile",
    ]);
  });

  it("Chat occupies the exact center of the five destinations", () => {
    expect(CHAT_TAB_INDEX).toBe(2);
    expect(MOBILE_NAV_TABS[2].id).toBe("chat");
  });

  it("should have correct canonical paths for each destination (no query hooks)", () => {
    const paths = MOBILE_NAV_TABS.map(t => t.path);
    expect(paths).toEqual([
      "/feed/model/mlb",
      "/betting-splits/NCAAF",
      "/chat",
      "/bet-tracker",
      "/profile",
    ]);
  });

  it("no destination path may carry a legacy query-string hook", () => {
    for (const tab of MOBILE_NAV_TABS) {
      expect(tab.path).not.toContain("?");
      expect(tab.path).not.toMatch(/^\/feed$|^\/feed\?|^\/splits/);
    }
  });

  it("should have non-empty labels for all destinations", () => {
    for (const tab of MOBILE_NAV_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
    }
  });

  it("feature flag MOBILE_NAV_ENABLED should be true", () => {
    expect(MOBILE_NAV_ENABLED).toBe(true);
  });
});

describe("Mobile Floating Nav — Active-route matcher", () => {
  it("feed stays active across dated/sport variants", () => {
    expect(getActiveTabId("/feed/model/mlb")).toBe("feed");
    expect(getActiveTabId("/feed/model/mlb-07-18-2026")).toBe("feed");
    expect(getActiveTabId("/feed/model/wc-07-18-2026")).toBe("feed");
    expect(getActiveTabId("/feed/model/mlb/07-18-2026")).toBe("feed");
  });

  it("tools activates on the betting-splits surface (any sport/date)", () => {
    expect(getActiveTabId("/betting-splits")).toBe("tools");
    expect(getActiveTabId("/betting-splits/MLB")).toBe("tools");
    expect(getActiveTabId("/betting-splits/mlb-07-18-2026")).toBe("tools");
    expect(getActiveTabId("/betting-splits/NBA/07-18-2026")).toBe("tools");
  });

  it("chat, tracker, and profile match their exact routes and nested paths", () => {
    expect(getActiveTabId("/chat")).toBe("chat");
    expect(getActiveTabId("/bet-tracker")).toBe("tracker");
    expect(getActiveTabId("/profile")).toBe("profile");
  });

  it("query strings and hashes never change activation", () => {
    expect(getActiveTabId("/chat?preview=1")).toBe("chat");
    expect(getActiveTabId("/betting-splits/MLB?x=1#top")).toBe("tools");
  });

  it("orphaned /m/* screens highlight their owning destinations", () => {
    expect(getActiveTabId("/m/feed")).toBe("feed");
    expect(getActiveTabId("/m/splits")).toBe("tools");
    expect(getActiveTabId("/m/chat")).toBe("chat");
    expect(getActiveTabId("/m/profile")).toBe("profile");
  });

  it("returns null (NO default) when no destination is active", () => {
    // aria-current="page" belongs only to a genuinely active destination —
    // the retired bottom bar's default-to-feed behavior was a semantics bug.
    expect(getActiveTabId("/")).toBeNull();
    expect(getActiveTabId("/wc2026")).toBeNull();
    expect(getActiveTabId("/account")).toBeNull();
    expect(getActiveTabId("/admin/users")).toBeNull();
    expect(getActiveTabId("/m/props")).toBeNull();
    expect(getActiveTabId("/login")).toBeNull();
    // /mlb/team/:slug merely starts with "/m" — must not match anything
    expect(getActiveTabId("/mlb/team/yankees")).toBeNull();
  });
});

// ─── Access — authentication only ────────────────────────────────────────────
// Every tab and page is default and project-wide for all users; the nav has
// no role checks. Authentication is the single requirement (the destinations
// themselves are RequireAuth-guarded).
describe("Mobile Floating Nav — Access Decision Logic", () => {
  it("pins the feature on and the debug panel off", () => {
    expect(MOBILE_NAV_ENABLED).toBe(true);
    expect(MOBILE_NAV_DEBUG_PANEL).toBe(false);
  });

  it("grants every authenticated user", () => {
    const result = decideMobileNavAccess(true);
    expect(result.granted).toBe(true);
    if (result.granted) expect(result.reason).toBe("authenticated");
  });

  it("denies unauthenticated visitors", () => {
    const result = decideMobileNavAccess(false);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("not_authenticated");
  });

  it("the decision function takes no role argument at all", () => {
    // one boolean in, decision out — a refactor cannot quietly reintroduce
    // role-gated navigation
    expect(decideMobileNavAccess.length).toBe(1);
  });
});

describe("Mobile Floating Nav — Logger", () => {
  beforeEach(() => {
    mobileNavLogger.clear();
  });

  it("should start with zero entries after clear", () => {
    expect(mobileNavLogger.getEntries()).toHaveLength(0);
  });

  it("should log events with correct structure", () => {
    mobileNavLogger.log("tabs_rendered", "feed", { test: true });
    const entries = mobileNavLogger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("tabs_rendered");
    expect(entries[0].tabId).toBe("feed");
    expect(entries[0].metadata).toEqual({ test: true });
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it("should track multiple events in order", () => {
    mobileNavLogger.log("tab_tapped", "feed");
    mobileNavLogger.log("tab_changed", "tools");
    mobileNavLogger.log("route_navigated", "tools");
    const entries = mobileNavLogger.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].event).toBe("tab_tapped");
    expect(entries[1].event).toBe("tab_changed");
    expect(entries[2].event).toBe("route_navigated");
  });

  it("should generate unique session IDs", () => {
    const id1 = mobileNavLogger.getSessionId();
    mobileNavLogger.clear();
    const id2 = mobileNavLogger.getSessionId();
    expect(id1).not.toBe(id2);
  });

  it("should track session duration", () => {
    const duration = mobileNavLogger.getSessionDuration();
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("should count events by type", () => {
    mobileNavLogger.log("tab_tapped", "feed");
    mobileNavLogger.log("tab_tapped", "tools");
    mobileNavLogger.log("tab_changed", "chat");
    expect(mobileNavLogger.getEventCount("tab_tapped")).toBe(2);
    expect(mobileNavLogger.getEventCount("tab_changed")).toBe(1);
    expect(mobileNavLogger.getEventCount()).toBe(3);
  });

  it("should get last event", () => {
    mobileNavLogger.log("tab_tapped", "feed");
    mobileNavLogger.log("tab_changed", "tools");
    const last = mobileNavLogger.getLastEvent();
    expect(last?.event).toBe("tab_changed");
    expect(last?.tabId).toBe("tools");
  });

  it("should export valid JSON", () => {
    mobileNavLogger.log("tabs_rendered");
    const json = mobileNavLogger.exportJSON();
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.totalEvents).toBe(1);
  });

  it("should cap entries at MAX_LOG_ENTRIES (500)", () => {
    for (let i = 0; i < 550; i++) {
      mobileNavLogger.log("tab_tapped", "feed");
    }
    expect(mobileNavLogger.getEntries().length).toBeLessThanOrEqual(500);
  });
});

describe("Mobile Floating Nav — Destination Configuration Integrity", () => {
  it("all destinations should have unique IDs", () => {
    const ids = MOBILE_NAV_TABS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all destinations should have unique paths", () => {
    const paths = MOBILE_NAV_TABS.map(t => t.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("no destinations should be disabled by default", () => {
    for (const tab of MOBILE_NAV_TABS) {
      expect(tab.disabled).toBeFalsy();
    }
  });

  it("feed destination should be first", () => {
    expect(MOBILE_NAV_TABS[0].id).toBe("feed");
  });

  it("profile destination should be last", () => {
    expect(MOBILE_NAV_TABS[MOBILE_NAV_TABS.length - 1].id).toBe("profile");
  });
});

describe("Mobile Floating Nav — New Event Types Validity", () => {
  beforeEach(() => {
    mobileNavLogger.clear();
  });

  const structuralEvents = [
    "mount_attempted",
    "mount_success",
    "mount_skipped",
    "mount_skipped_feature_disabled",
    "mount_skipped_not_mobile",
    "global_layout_mount_enabled",
    "role_resolution",
    "feature_flags_detected",
    "css_visibility_checked",
    "route_render_verified",
  ] as const;

  for (const event of structuralEvents) {
    it(`should accept ${event} event`, () => {
      mobileNavLogger.log(event, undefined, { test: true });
      expect(mobileNavLogger.getLastEvent()?.event).toBe(event);
    });
  }
});

describe("Mobile Floating Nav — Destinations Map Onto Existing Routes", () => {
  it("Feed/Tools/Tracker destinations route to their canonical path-based surfaces", () => {
    const byId = new Map(MOBILE_NAV_TABS.map(t => [t.id, t.path]));
    expect(byId.get("feed")).toBe("/feed/model/mlb");
    expect(byId.get("tools")).toBe("/betting-splits/NCAAF");
    expect(byId.get("tracker")).toBe("/bet-tracker");
  });

  it("Chat and Profile destinations should route to their dedicated paths", () => {
    const chatTab = MOBILE_NAV_TABS.find(t => t.id === "chat");
    const profileTab = MOBILE_NAV_TABS.find(t => t.id === "profile");
    expect(chatTab?.path).toBe("/chat");
    expect(profileTab?.path).toBe("/profile");
  });

  it("only the Tools destination targets /betting-splits, at its canonical sport path", () => {
    const splitsTabs = MOBILE_NAV_TABS.filter(t =>
      t.path.startsWith("/betting-splits")
    );
    expect(splitsTabs.map(t => t.id)).toEqual(["tools"]);
    expect(splitsTabs[0]?.path).toBe("/betting-splits/NCAAF");
  });

  it("no destination targets an /m/* screen (the bar left /m/props behind)", () => {
    // /m/props stays routed and deep-linkable; it just isn't primary nav.
    for (const tab of MOBILE_NAV_TABS) {
      expect(tab.path.startsWith("/m/")).toBe(false);
    }
  });
});

describe("Mobile Floating Nav — Nav Interaction Events", () => {
  beforeEach(() => {
    mobileNavLogger.clear();
  });

  it("should accept mobile_nav_tab_clicked event with full metadata", () => {
    mobileNavLogger.log("mobile_nav_tab_clicked", "feed", {
      current_path: "/chat",
      target_path: "/feed/model/mlb",
      tab_name: "feed",
      is_mobile: true,
      timestamp: Date.now(),
    });
    const last = mobileNavLogger.getLastEvent();
    expect(last?.event).toBe("mobile_nav_tab_clicked");
    expect(last?.tabId).toBe("feed");
    expect(last?.metadata?.current_path).toBe("/chat");
    expect(last?.metadata?.target_path).toBe("/feed/model/mlb");
  });

  it("should accept mobile_nav_tab_navigated event", () => {
    mobileNavLogger.log("mobile_nav_tab_navigated", "tools", {
      current_path: "/feed/model/mlb",
      target_path: "/betting-splits/MLB",
      tab_name: "tools",
      is_mobile: true,
      timestamp: Date.now(),
    });
    const last = mobileNavLogger.getLastEvent();
    expect(last?.event).toBe("mobile_nav_tab_navigated");
    expect(last?.tabId).toBe("tools");
    expect(last?.metadata?.target_path).toBe("/betting-splits/MLB");
  });

  it("should accept mobile_nav_rendered event", () => {
    mobileNavLogger.log("mobile_nav_rendered", undefined, {
      current_path: "/betting-splits",
      is_mobile: true,
      timestamp: Date.now(),
      user_id: 1,
    });
    const last = mobileNavLogger.getLastEvent();
    expect(last?.event).toBe("mobile_nav_rendered");
    expect(last?.metadata?.current_path).toBe("/betting-splits");
  });

  it("should accept mobile_nav_m_route_rendered event", () => {
    mobileNavLogger.log("mobile_nav_m_route_rendered", undefined, {
      current_path: "/m/props",
      target_path: "/m/props",
      tab_name: "props",
      is_mobile: true,
      timestamp: Date.now(),
    });
    const last = mobileNavLogger.getLastEvent();
    expect(last?.event).toBe("mobile_nav_m_route_rendered");
    expect(last?.metadata?.tab_name).toBe("props");
  });

  it("all nav interaction events carry the required metadata fields", () => {
    const events = [
      "mobile_nav_tab_clicked",
      "mobile_nav_tab_navigated",
      "mobile_nav_rendered",
      "mobile_nav_m_route_rendered",
    ] as const;

    for (const event of events) {
      mobileNavLogger.log(event, undefined, {
        current_path: "/test",
        target_path: "/m/test",
        tab_name: "feed",
        is_mobile: true,
        timestamp: Date.now(),
      });
    }

    const entries = mobileNavLogger.getEntries();
    expect(entries).toHaveLength(4);

    for (const entry of entries) {
      expect(entry.metadata).toBeDefined();
      expect(entry.metadata?.current_path).toBeDefined();
      expect(entry.metadata?.target_path).toBeDefined();
      expect(entry.metadata?.tab_name).toBeDefined();
      expect(entry.metadata?.is_mobile).toBeDefined();
      expect(entry.metadata?.timestamp).toBeDefined();
    }
  });
});
