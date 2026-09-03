/**
 * Mobile Nav — Feature Flags & Configuration
 * ═══════════════════════════════════════════
 * Mobile primary navigation for ALL authenticated users (<768px).
 * There are no role-gated tabs: every destination is default and
 * project-wide. All flags are compile-time constants for tree-shaking.
 */

// ─── Feature Flags ───────────────────────────────────────────────────────────
export const MOBILE_NAV_ENABLED = true;
// Debug overlay stays off in production — it renders for everyone who can
// reach /m/* (MobileNavDebugPanel gates on this flag only).
export const MOBILE_NAV_DEBUG_PANEL = false;

// ─── Tab Definitions ─────────────────────────────────────────────────────────
export type MobileNavTabId = "feed" | "tools" | "chat" | "tracker" | "profile";

export interface MobileNavTabConfig {
  id: MobileNavTabId;
  label: string;
  path: string;
  badge?: number | null;
  disabled?: boolean;
}

// [NAV RECONSTRUCTION 2026-07-11] Legacy query-string hooks are eradicated —
// tabs target the canonical path-based routes only.
// /feed/model/mlb canonicalizes to today's dated URL inside DimeModelFeed.
// [FLOATING NAV 2026-07-18] Destination contract for the top floating pill nav
// (docs/plans/2026-07-18-mobile-floating-nav.md). Order is load-bearing: Chat
// must occupy the exact center of the five. "Tools" is the Betting Splits +
// Odds History surface (the only live betting-tools destination — no /tools
// route exists); "Bet Tracker" replaces the Props tab (the /m/props route and
// screen stay reachable by URL, just not from the primary bar).
export const MOBILE_NAV_TABS: MobileNavTabConfig[] = [
  { id: "feed", label: "Feed", path: "/feed/model/mlb" },
  { id: "tools", label: "Tools", path: "/betting-splits/NCAAF" },
  { id: "chat", label: "Chat", path: "/chat" },
  // Visible label is the short "Tracker" (product directive 2026-07-18); the
  // product name stays "Bet Tracker" (aria-label + everywhere off the pill).
  { id: "tracker", label: "Tracker", path: "/bet-tracker" },
  { id: "profile", label: "Profile", path: "/profile" },
];

/** Index of the Chat destination — the visual + mathematical center pill. */
export const CHAT_TAB_INDEX = MOBILE_NAV_TABS.findIndex(t => t.id === "chat");

// ─── Access Decision Type ────────────────────────────────────────────────────
export type MobileNavAccessDecision =
  | { granted: true; reason: "authenticated" }
  | { granted: false; reason: "feature_disabled" | "not_authenticated" };

// ─── Access Logic ────────────────────────────────────────────────────────────
// Authentication is the only requirement: every destination behind the nav is
// itself auth-guarded (RequireAuth), and unauthenticated visitors belong on
// the public landing/login surfaces without app chrome. No role checks.
export function decideMobileNavAccess(
  isAuthenticated: boolean
): MobileNavAccessDecision {
  if (!MOBILE_NAV_ENABLED) {
    return { granted: false, reason: "feature_disabled" };
  }
  if (!isAuthenticated) {
    return { granted: false, reason: "not_authenticated" };
  }
  return { granted: true, reason: "authenticated" };
}

// ─── Logging Event Types ─────────────────────────────────────────────────────
export type MobileNavEvent =
  | "tabs_rendered"
  | "tab_tapped"
  | "tab_changed"
  | "access_granted"
  | "access_denied"
  | "shell_mounted"
  | "shell_unmounted"
  | "debug_panel_opened"
  | "debug_panel_closed"
  | "feature_flag_checked"
  | "route_navigated"
  | "haptic_triggered"
  | "animation_started"
  | "animation_completed"
  | "error_boundary_caught"
  | "chat_chip_tapped"
  | "bet_tracker_action"
  | "profile_action"
  | "scroll_position_saved"
  | "scroll_position_restored"
  | "viewport_resized"
  | "safe_area_detected"
  | "theme_applied"
  // Data connection events (/m/* screens)
  | "mobile_feed_data_fetch_started"
  | "mobile_feed_data_fetch_completed"
  | "mobile_feed_data_fetch_failed"
  | "mobile_feed_empty_state_rendered"
  | "mobile_splits_data_fetch_started"
  | "mobile_splits_data_fetch_completed"
  | "mobile_splits_data_fetch_failed"
  | "mobile_splits_empty_state_rendered"
  | "mobile_chat_state_loaded"
  | "mobile_chat_preview_action_clicked"
  | "mobile_chat_preview_action_blocked"
  | "mobile_chat_avenue_selected"
  | "mobile_bet_tracker_data_fetch_started"
  | "mobile_bet_tracker_data_fetch_completed"
  | "mobile_bet_tracker_data_fetch_failed"
  | "mobile_bet_tracker_empty_state_rendered"
  | "mobile_profile_data_loaded"
  | "mobile_profile_data_failed"
  // Global mount events
  | "mount_attempted"
  | "mount_success"
  | "mount_skipped"
  | "mount_skipped_feature_disabled"
  | "mount_skipped_not_mobile"
  | "global_layout_mount_enabled"
  | "role_resolution"
  | "feature_flags_detected"
  | "css_visibility_checked"
  | "route_render_verified"
  // Global nav interaction events
  | "mobile_nav_tab_clicked"
  | "mobile_nav_tab_navigated"
  | "mobile_nav_rendered"
  | "mobile_nav_m_route_rendered";

export interface MobileNavLogEntry {
  timestamp: number;
  event: MobileNavEvent;
  tabId?: MobileNavTabId;
  metadata?: Record<string, unknown>;
}
