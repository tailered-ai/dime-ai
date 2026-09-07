/**
 * MobileFloatingNav
 * ═════════════════
 * Top-floating mobile primary navigation: the bare Dime wordmark (a brand
 * mark, not a button) above a fully-rounded pill menu, both on a solid
 * page-colored band so scrolling content never shows through or overlaps the
 * chrome. Replaces the retired bottom tab bar
 * (docs/plans/2026-07-18-mobile-floating-nav.md).
 *
 * DESIGN SPEC — Dime brand law (dime-ai/THREE-COLOR-LAW.md v2/v3, which
 * supersedes design-system/dime-ai/MASTER.md where they disagree):
 * ────────────────────────────────────────────────────────────────
 * - Solid raised surfaces (`--dime-surface-raised`) + quiet 1px `--dime-border`
 *   hairline + floating-surface shadow. Alpha lives ONLY inside box-shadow —
 *   no translucent fills, no backdrop blur (the reference menu's glass surface
 *   is adapted to the Law's solid tiers).
 * - Mint `#45E0A8` (`--dime-mint`, verified exact) is reserved for signal:
 *   here that is the Chat primary pill, the active-destination dot, and the
 *   wordmark coin-dot. Chat pill ink is #000000 (~12:1 on mint, both themes);
 *   the coin-dot inside the mint pill flips to white (brand coin-dot rule).
 * - Familjen Grotesk only. Motion: 160ms var(--dime-ease); pressed-state
 *   compression is transform-only; everything collapses under
 *   prefers-reduced-motion (CSS media query — no JS gating needed).
 *
 * Geometry contract:
 * - grid-template-columns: 1fr 1fr auto 1fr 1fr — the Chat pill occupies the
 *   mathematical center of the menu regardless of neighbor label widths.
 * - Every destination is a real wouter <Link> (anchor) with min 44×44px
 *   targets; aria-current="page" only on the genuinely active destination.
 * - The wrapper measures its own rendered height (ResizeObserver) and
 *   publishes `--dime-floating-nav-h` on <html>; page clearance derives from
 *   that variable, never from fixed pixel offsets.
 *
 * zIndex 40: below the app modals (AgeModal/LoginModal at z-50) and the chat
 * drawer stack (60-100), above page sticky headers (≤40 via DOM order).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { preserveFootballContext } from "@/lib/feedRoutes";
import { MOBILE_NAV_TABS, type MobileNavTabId } from "./config";
import { getActiveTabId } from "./activeTab";
import { mobileNavLogger } from "./logger";
import "./mobileFloatingNav.css";

/** Published on <html>; consumed by body clearance + sticky-chrome offsets. */
export const NAV_CLEARANCE_VAR = "--dime-floating-nav-h";
/** Breathing room between the floating assembly and page content. Mirrored as
 *  the CSS token --dime-floating-nav-gap (mobileFloatingNav.css) so sticky
 *  consumers can subtract it without hard-coding this constant. */
const CLEARANCE_GAP_PX = 8;

/** Brand wordmark: lowercase "dıme", dotless ı (U+0131) + coin-dot. */
function DimeWordmark({ decorative = false }: { decorative?: boolean }) {
  return (
    <span
      className="mfn-wordmark"
      {...(decorative ? { "aria-hidden": true } : { "aria-label": "dime" })}
    >
      d
      <span className="mfn-i">
        ı<span className="mfn-coindot" />
      </span>
      me
    </span>
  );
}

export function MobileFloatingNav() {
  const [location] = useLocation();
  const search = useSearch();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activeTabId = getActiveTabId(location);

  // Reserve document space equal to the rendered assembly height. The wrapper
  // starts at the viewport top (its padding absorbs the safe-area inset), so
  // offsetHeight IS the assembly's bottom edge — robust against text scaling,
  // label wrapping, and safe-area changes.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty(
        NAV_CLEARANCE_VAR,
        `${Math.ceil(el.offsetHeight) + CLEARANCE_GAP_PX}px`
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(NAV_CLEARANCE_VAR);
    };
  }, []);

  // Same logging contract as the retired bottom bar (in-memory logger only —
  // there is no external analytics product; see logger.ts).
  function handleTap(tabId: MobileNavTabId, path: string, isActive: boolean) {
    mobileNavLogger.log("tab_tapped", tabId, { from: location, to: path });
    mobileNavLogger.log("mobile_nav_tab_clicked", tabId, {
      current_path: location,
      target_path: path,
      tab_name: tabId,
      is_mobile: true,
      timestamp: Date.now(),
    });
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(10);
        mobileNavLogger.log("haptic_triggered", tabId);
      } catch {
        // Silent — not all browsers support vibrate
      }
    }
    if (location !== path) {
      mobileNavLogger.log("tab_changed", tabId, {
        from: activeTabId,
        to: tabId,
      });
      mobileNavLogger.log("route_navigated", tabId, { path });
      mobileNavLogger.log("mobile_nav_tab_navigated", tabId, {
        current_path: location,
        target_path: path,
        tab_name: tabId,
        is_mobile: true,
        timestamp: Date.now(),
      });
    }
    void isActive; // replace-vs-push is handled by the Link `replace` prop
  }

  // Chat publishes --dc-kb-progress + .dc-kb-open on <html> while the OS
  // keyboard is up; mirror the fully-hidden end state into an attribute so
  // hit-testing drops without touching the resting band's contract.
  const [kbHidden, setKbHidden] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const open = root.classList.contains("dc-kb-open");
      const p = parseFloat(
        getComputedStyle(root).getPropertyValue("--dc-kb-progress") || "0"
      );
      setKbHidden(open && p > 0.98);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="mfn-wrap"
      ref={wrapRef}
      data-testid="mobile-floating-nav"
      // Fully receded behind the chat keyboard → drop hit-testing (the CSS
      // opacity/lift ride --dc-kb-progress; this flips only at the ends).
      data-kb-hidden={kbHidden ? "true" : undefined}
    >
      <div className="mfn-logo">
        <DimeWordmark />
      </div>
      <nav className="mfn-nav" aria-label="Main navigation">
        <div className="mfn-grid">
          {MOBILE_NAV_TABS.map(tab => {
            const path = preserveFootballContext(tab.path, location, search);
            const isActive = activeTabId === tab.id;
            const isChat = tab.id === "chat";
            return (
              <Link
                key={tab.id}
                href={path}
                // Re-tapping the active destination (e.g. Feed from a dated
                // URL back to /feed/model/mlb) replaces instead of pushing —
                // no history pile-up (behavior carried over from the old bar).
                replace={isActive}
                className={isChat ? "mfn-item mfn-chat" : "mfn-item"}
                aria-current={isActive ? "page" : undefined}
                // Tracker displays the short label but keeps its full product
                // name for assistive tech ("Bet Tracker" contains the visible
                // "Tracker" — WCAG 2.5.3 label-in-name holds).
                aria-label={
                  isChat
                    ? "Chat with Dime AI"
                    : tab.id === "tracker"
                      ? "Bet Tracker"
                      : undefined
                }
                data-testid={`tab-${tab.id}`}
                data-active={isActive}
                onClick={() => handleTap(tab.id, path, isActive)}
              >
                {isChat ? (
                  // The credits readout (directive 2026-07-29) returns when the
                  // credits system ships REAL balances — the audit pulled the
                  // hardcoded "3,000 credits" placeholder (DIME-UI-010): a
                  // fabricated number on a transparency-first product. Until
                  // then the pill keeps its label in both states; the mint
                  // fill carries the active treatment (see mobileFloatingNav.css).
                  <>
                    <span className="mfn-chat-text">Chat with</span>
                    <DimeWordmark decorative />
                  </>
                ) : (
                  tab.label
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
