import { describe, expect, it } from "vitest";
import {
  isChatLocation,
  isDimeProductLocation,
  parseDimeProductRoute,
} from "./productRoute";

describe("parseDimeProductRoute", () => {
  it("classifies chat and tracker", () => {
    expect(parseDimeProductRoute("/chat")).toEqual({ pane: "chat" });
    expect(parseDimeProductRoute("/bet-tracker")).toEqual({ pane: "tracker" });
  });

  it("preserves combined and split feed route segments", () => {
    expect(parseDimeProductRoute("/feed/model/07-11-2026")).toEqual({
      pane: "feed",
      sportSegment: "07-11-2026",
      dateSegment: undefined,
    });
    expect(parseDimeProductRoute("/feed/model/mlb-07-11-2026")).toEqual({
      pane: "feed",
      sportSegment: "mlb-07-11-2026",
      dateSegment: undefined,
    });
    expect(parseDimeProductRoute("/feed/model/wc/07-11-2026")).toEqual({
      pane: "feed",
      sportSegment: "wc",
      dateSegment: "07-11-2026",
    });
  });

  it("preserves combined, split, and bare splits route segments", () => {
    expect(parseDimeProductRoute("/betting-splits")).toEqual({
      pane: "splits",
    });
    expect(parseDimeProductRoute("/betting-splits/mlb-07-11-2026")).toEqual({
      pane: "splits",
      sportSegment: "mlb-07-11-2026",
      dateSegment: undefined,
    });
    expect(parseDimeProductRoute("/betting-splits/mlb/07-11-2026")).toEqual({
      pane: "splits",
      sportSegment: "mlb",
      dateSegment: "07-11-2026",
    });
  });

  it("classifies preview-bearing deep links exactly like their canonical paths", () => {
    expect(parseDimeProductRoute("/chat?preview=1")).toEqual({ pane: "chat" });
    expect(
      parseDimeProductRoute("/feed/model/mlb-07-11-2026?preview=1")
    ).toEqual({
      pane: "feed",
      sportSegment: "mlb-07-11-2026",
      dateSegment: undefined,
    });
    expect(
      parseDimeProductRoute("/betting-splits/mlb-07-11-2026?preview=1")
    ).toEqual({
      pane: "splits",
      sportSegment: "mlb-07-11-2026",
      dateSegment: undefined,
    });
    expect(parseDimeProductRoute("/bet-tracker?preview=1")).toEqual({
      pane: "tracker",
    });
  });

  it("does not claim mobile-owner, admin, or similarly prefixed routes", () => {
    for (const location of [
      "/m/chat",
      "/admin/model-status",
      "/chat-history",
      "/",
    ]) {
      expect(isDimeProductLocation(location)).toBe(false);
    }
  });
});

describe("isChatLocation", () => {
  // The 768px shell-mount-stability fix (App.tsx `chatShellOwnsRoute`) needs
  // an EXACT chat-route test independent of the shared viewport gate, so
  // /chat can claim the unified DimeAppShell branch at every width.
  it("matches the exact /chat route, including query and hash variants", () => {
    expect(isChatLocation("/chat")).toBe(true);
    expect(isChatLocation("/chat?preview=1")).toBe(true);
    expect(isChatLocation("/chat#top")).toBe(true);
  });

  it("rejects nested, prefixed, and unrelated routes", () => {
    for (const location of [
      "/m/chat",
      "/chat-history",
      "/chat/history",
      "/admin/model-status",
      "/",
      "/bet-tracker",
    ]) {
      expect(isChatLocation(location), location).toBe(false);
    }
  });
});

describe("trends pane routing", () => {
  it("classifies /trends as the trends pane", () => {
    expect(parseDimeProductRoute("/trends")).toEqual({ pane: "trends" });
  });

  it("strips query and hash before classifying", () => {
    expect(parseDimeProductRoute("/trends?x=1#frag")).toEqual({
      pane: "trends",
    });
  });

  it("is shell-owned but never chat", () => {
    expect(isDimeProductLocation("/trends")).toBe(true);
    expect(isChatLocation("/trends")).toBe(false);
  });

  it("does not classify sub-paths — /trends has no sport/date segments", () => {
    expect(parseDimeProductRoute("/trends/mlb")).toBeNull();
  });

  it("leaves the existing panes untouched", () => {
    expect(parseDimeProductRoute("/chat")).toEqual({ pane: "chat" });
    expect(parseDimeProductRoute("/bet-tracker")).toEqual({ pane: "tracker" });
    expect(parseDimeProductRoute("/betting-splits")).toEqual({
      pane: "splits",
    });
  });
});
