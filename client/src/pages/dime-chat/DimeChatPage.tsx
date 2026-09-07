/**
 * Dime AI — Chat page (home + conversation states of the /chat route).
 * Visual source of truth: design/frozen/dime-ai-home-{dark,light}.html — do not restyle.
 * Styles: frozen-tokens.css (verbatim extraction, D:n/L:n cited) +
 *         conversation.css (derived conversation state, spec-cited).
 * Behavior sources:
 *  - SSE streaming core preserved from the previous DimeChat.tsx
 *    (fetch → reader → `data:` frame parse, AbortController, single send path).
 *  - Conversation anatomy / FLIP transition / scroll policy / chrome copy:
 *    scratchpad chat-derivation-spec.md (§ refs in conversation.css).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  Fragment,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useTheme } from "../../contexts/ThemeContext";
import {
  chatReducer,
  initialChatState,
  type ChatMessage,
  type DataFreshness,
} from "./chatReducer";
import {
  parseAssistantContent,
  segmentNumerals,
  type EdgeBlock,
} from "./edgeParser";
import {
  classifyPointerIntent,
  resolveDrawerAccessibility,
  resolveDrawerTarget,
  rubberBand,
} from "./drawerMotion";
import { createRafDeltaBatcher, type RafDeltaBatcher } from "./streamBatcher";
import type {
  DimeChatClientTraceState,
  DimeChatTraceRequest,
} from "./chatTrace";
import {
  REDUCED_MOTION_QUERY,
  useReducedMotionPreference,
} from "./useReducedMotionPreference";
import {
  createSpringSettle,
  type SpringSettleHandle,
} from "@/lib/springSettle";
import {
  applyDimeAvenueScope,
  loadDimeChatAvenue,
  saveDimeChatAvenue,
  type DimeChatAvenue,
} from "@/lib/dimeChatAvenue";
import { DimeAvenueToggle } from "@/components/DimeAvenueToggle";
import {
  deriveTierLabel,
  displaySidebarName,
  formatExpiryLine,
  formatHandle,
  isLifetimeMember,
  isPrezAccount,
  type SidebarUser,
} from "./sidebarIdentity";
import {
  bettingSplitsPath,
  feedModelPath,
  preserveFootballContext,
} from "@/lib/feedRoutes";
// Sidebar icon vocabulary (owner directive 2026-07-21): distinctive Lucide
// picks over the generic ChatGPT pair — TextSearch/PanelLeft* for the header
// controls, one semantic mark per nav destination, Ellipsis/Trash2/Eraser for
// the recent-chat management surface. One set, one 1.8 stroke.
import {
  BrainCircuit,
  ChartCandlestick,
  ChartSpline,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Eraser,
  Moon,
  MessageSquarePlus,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  SunMoon,
  Target,
  TextSearch,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { emitEvent, emitAction } from "@/lib/analyticsBridge";
import { useAppAuth } from "@/_core/hooks/useAppAuth";
import type { DimeProductPane } from "../dime-shell/productRoute";
import type { ThemeMode } from "../../contexts/ThemeContext";
import prezAvatarUrl from "./assets/prez-avatar.jpg";
import SettingsModal from "./SettingsModal";
import "./frozen-tokens.css";
import "./conversation.css";

type Theme = "dark" | "light";

/* ----------------------------------------------------------------- */
/* Frozen copy — labels verbatim from D/L:57-71, 106-109              */
/* ----------------------------------------------------------------- */

const NAV_ROWS: Array<{
  label: string;
  pane?: DimeProductPane;
  href: () => string;
  icon: LucideIcon;
}> = [
  {
    label: "New Chat",
    pane: "chat",
    href: () => "/chat",
    icon: MessageSquarePlus,
  }, // D/L:57
  {
    label: "AI Model Projections",
    pane: "feed",
    href: () => feedModelPath(),
    icon: BrainCircuit,
  }, // D/L:58
  {
    label: "Betting Splits + Odds History",
    pane: "splits",
    href: () => bettingSplitsPath(),
    icon: ChartCandlestick,
  }, // D/L:59
  { label: "Trends", pane: "trends", href: () => "/trends", icon: ChartSpline }, // D/L:60 — route live 2026-07-21 (owner directive): hosts Last 5 Games + Trends at ≥768px
  { label: "Prop Projections", href: () => "#", icon: Target }, // D/L:61 — no route exists
  {
    label: "Bet Tracker",
    pane: "tracker",
    href: () => "/bet-tracker",
    icon: NotebookPen,
  }, // D/L:62
];

/** Stored-thread summary rendered in the sidebar Recent Chats list. Recents
 *  are the user's persisted dimeChats threads (server history) — the six
 *  sample labels at D/L:66-71 are design law and are never rendered. */
interface ThreadSummary {
  id: number;
  title: string;
  starred: boolean;
}

/* Suggested-prompt pills retired (owner directive 2026-07-31): the empty
   state opens straight into the composer on phone, tablet and desktop. */

const ERROR_COPY =
  "Dime couldn't reach the model. Your message is saved above."; // spec §4
const DISCLAIMER =
  "Model estimates, not guarantees. 21+ · Gambling problem? 1-800-GAMBLER."; // spec §4

type DimeChatTraceTools = typeof import("./chatTrace");

const loadDimeChatTrace = () => import("./chatTrace");

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;

// Client-side diagnostics behind localStorage.DIME_DEBUG === "1" (preserved)
const DEBUG =
  typeof window !== "undefined" && localStorage.getItem("DIME_DEBUG") === "1";
function dimeDebug(event: string, data?: Record<string, unknown>) {
  if (!DEBUG) return;
  console.log(`[DimeChat:DEBUG] ${event}`, data ?? "");
}

/* ----------------------------------------------------------------- */
/* Glyphs — geometry verbatim from D/L:103 (send), D/L:107-109 (pill), */
/* D/L:94 (gear); colors come from frozen-tokens.css theme scopes      */
/* ----------------------------------------------------------------- */

function SendGlyph() {
  return (
    <svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true">
      <path
        className="dc-send-chevron"
        d="M96 140 L248 256 L96 372"
        fill="none"
        strokeWidth="64"
        strokeLinecap="square"
      />
      <rect className="dc-send-rect" x="330" y="228" width="150" height="56" />
      <rect className="dc-send-rect" x="377" y="181" width="56" height="150" />
    </svg>
  );
}

/** Stop mark: the authorized mint-rect vocabulary of D/L:103, squared (spec §2.9). */
function StopGlyph() {
  return (
    <svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true">
      <rect className="dc-send-rect" x="166" y="166" width="180" height="180" />
    </svg>
  );
}

const GEAR_PATH =
  "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"; // D/L:94

/** Account popover Theme row: the segmented Light | Dark options, in display
 *  order. Two modes only (owner directive 2026-07-31 — "System" retired;
 *  stored selections migrate to Dark in ThemeContext). */
const THEME_MODE_OPTIONS: Array<{
  mode: ThemeMode;
  label: string;
  Icon: LucideIcon;
}> = [
  { mode: "light", label: "Light", Icon: Sun },
  { mode: "dark", label: "Dark", Icon: Moon },
];

/* ----------------------------------------------------------------- */
/* Sidebar — D/L:54-96                                                */
/* ----------------------------------------------------------------- */

/** Blank silhouette (generic gray profile) for accounts with no Discord avatar. */
const BLANK_AVATAR_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#000000"/><circle cx="32" cy="24" r="11" fill="#FFFFFF"/><path d="M10 58c3-13 12-19 22-19s19 6 22 19v6H10z" fill="#FFFFFF"/></svg>'
  );

/** Avatar priority (product requirement 2026-07-12): the prez photo stays
 *  exclusive to the prez account; everyone else gets their Discord avatar
 *  when connected, otherwise the blank silhouette. */
function resolveAvatarSrc(user: SidebarUser): string {
  if (isPrezAccount(user.username)) return prezAvatarUrl;
  if (user.discordId && user.discordAvatar) {
    return `https://cdn.discordapp.com/avatars/${user.discordId}/${user.discordAvatar}.png?size=96`;
  }
  return BLANK_AVATAR_URI;
}

function IdentityAvatar({
  user,
  menu = false,
}: {
  user: SidebarUser;
  menu?: boolean;
}) {
  const sizeClass = menu ? "dc-avatar--menu" : "dc-avatar";
  return (
    <img
      className={sizeClass}
      src={resolveAvatarSrc(user)}
      alt={displaySidebarName(user.username)}
    />
  );
}

/** Desktop rail preference survives reloads; the <1024px drawer ignores it. */
const RAIL_STORAGE_KEY = "dime.sidebar.rail";

function DimeSidebar({
  onNewChat,
  recentChats,
  onOpenChat,
  onDeleteChat,
  onClearAllChats,
  activeChatId,
  compact,
  phone,
  drawerOpen,
  sidebarRef,
  onClose,
  onNavigate,
  activePane = "chat",
  onShellNavigate,
  appUser,
  isOwner,
  onOpenSettings,
}: {
  onNewChat: () => void;
  recentChats: ThreadSummary[];
  onOpenChat: (threadId: number) => void;
  onDeleteChat: (threadId: number) => void;
  /** Owner-only platform sweep; absent for every non-owner session. */
  onClearAllChats?: () => void;
  activeChatId: number | null;
  compact: boolean;
  /** <768px (owner directive 2026-07-29): the drawer is a pure CHAT-HISTORY
   *  panel — New Chat + Recent Chats only. The app-nav rows, profile row, and
   *  owner eraser are tablet/desktop elements (the floating pill nav owns
   *  primary navigation on phones). */
  phone: boolean;
  drawerOpen: boolean;
  sidebarRef: MutableRefObject<HTMLElement | null>;
  onClose: () => void;
  onNavigate: () => void;
  activePane?: DimeProductPane;
  onShellNavigate?: (href: string) => void;
  appUser: SidebarUser | null;
  isOwner: boolean;
  /** Settings row opens the real Settings modal (Username · Discord ·
   *  Reset Password · Billing) via this handler — wired in Round 3 Step 2
   *  (DimeChatPage passes setSettingsOpen(true) at the <DimeSidebar> call
   *  site below). No-op only when a caller omits the prop entirely. */
  onOpenSettings?: () => void;
}) {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  // Account popover v2 (owner directive 2026-07-22): which pane of the
  // popover's sliding viewport is showing — the row list, or the Theme
  // drill-in. Always resets to "root" on close (effect below) so reopening
  // never surprises the user mid-panel.
  const [menuView, setMenuView] = useState<"root" | "theme">("root");
  const profileRef = useRef<HTMLDivElement>(null);
  const menuViewportRef = useRef<HTMLDivElement | null>(null);
  const menuRootPaneRef = useRef<HTMLDivElement | null>(null);
  const menuThemePaneRef = useRef<HTMLDivElement | null>(null);
  const themeRowBtnRef = useRef<HTMLButtonElement | null>(null);
  const themeBackBtnRef = useRef<HTMLButtonElement | null>(null);
  // ── Desktop collapse-to-rail + chat search (owner directive 2026-07-21) ──
  const [railCollapsed, setRailCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const rail = railCollapsed && !compact;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [rowMenuId, setRowMenuId] = useState<number | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const setRail = (next: boolean) => {
    setRailCollapsed(next);
    if (next) {
      // Rail hides the search field, recents, and any open floating menus.
      setSearchOpen(false);
      setSearchQuery("");
      setRowMenuId(null);
      setMenuOpen(false);
    }
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* no-op */
    }
  };
  const [location, navigate] = useLocation();
  const search = useSearch();
  const logoutMutation = trpc.appUsers.logout.useMutation();

  const goTo = (href: string) => {
    setMenuOpen(false);
    onNavigate();
    navigate(href);
  };

  const onLogout = async () => {
    if (logoutMutation.isPending) return;
    try {
      await logoutMutation.mutateAsync();
    } finally {
      // Hard redirect: clears every in-memory cache (React Query auth state,
      // session recents) so the next login renders the next user's identity.
      window.location.assign("/");
    }
  };

  const expiryLine = appUser ? formatExpiryLine(appUser.expiryDate) : null;
  // Upgrade/Cancel are plan-management CTAs: hidden for owners AND for
  // lifetime members (product requirement 2026-07-12) — there is no plan to
  // upgrade or cancel on either account.
  const showPlanCtas = !!appUser && !isOwner && !isLifetimeMember(appUser);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Account popover v2 (owner directive 2026-07-22): reset to the row list
  // whenever the popover closes — reopening should never resume mid-Theme.
  useEffect(() => {
    if (!menuOpen) setMenuView("root");
  }, [menuOpen]);

  // Keep the sliding viewport's height in lockstep with whichever pane is
  // visible, so the Theme drill-in/back never leaves a gap below the shorter
  // pane or clips the taller one (apple-design §craft: no layout jump). This
  // is a plain style write — the CSS `transition: height` on
  // .dc-menu-viewport (conversation.css, prefers-reduced-motion-gated) does
  // the animating, redirecting cleanly if the user reverses mid-flight. On
  // first mount there is nothing painted yet to transition from, so it never
  // animates in from nothing.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const viewport = menuViewportRef.current;
    const pane =
      menuView === "theme" ? menuThemePaneRef.current : menuRootPaneRef.current;
    if (!viewport || !pane) return;
    viewport.style.height = `${pane.scrollHeight}px`;
  }, [menuOpen, menuView, isOwner]);

  // Focus follows the Theme drill-in/back navigation only — never stranded
  // on a now-offscreen row (apple-design: focus preserved). Deliberately
  // scoped to menuView *transitions* (not menu open/close) so opening the
  // popover keeps its existing focus behavior untouched.
  const prevMenuViewRef = useRef<"root" | "theme">("root");
  useEffect(() => {
    if (menuOpen && prevMenuViewRef.current !== menuView) {
      if (menuView === "theme") themeBackBtnRef.current?.focus();
      else themeRowBtnRef.current?.focus();
    }
    prevMenuViewRef.current = menuView;
  }, [menuOpen, menuView]);

  // Row "…" menu shares the settings menu's dismissal contract: outside
  // pointer-down or Escape closes it.
  useEffect(() => {
    if (rowMenuId == null) return;
    const onDown = (e: MouseEvent) => {
      if (!rowMenuRef.current?.contains(e.target as Node)) setRowMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRowMenuId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [rowMenuId]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Title filter over the stored threads; empty query passes everything through.
  const chatQuery = searchQuery.trim().toLowerCase();
  const visibleChats = chatQuery
    ? recentChats.filter(rc => rc.title.toLowerCase().includes(chatQuery))
    : recentChats;

  return (
    <aside
      ref={sidebarRef}
      className={`dc-sidebar${compact ? " dc-drawer" : ""}${rail ? " dc-sidebar--rail" : ""}`}
      role={compact && drawerOpen ? "dialog" : undefined}
      aria-modal={compact && drawerOpen ? true : undefined}
      aria-label={
        compact ? (phone ? "Chat history" : "Dime navigation") : undefined
      }
      aria-hidden={compact && !drawerOpen ? true : undefined}
    >
      <div className="dc-sidebar-head">
        <div className="dc-sidebar-title">
          <span className="dime-wordmark" aria-label="dime">
            d
            <span className="dime-wordmark-i">
              ı<span className="dime-coindot" />
            </span>
            me
          </span>
        </div>
        {compact ? (
          <button
            type="button"
            className="dc-drawer-close dc-pressable dc-focusable"
            aria-label={phone ? "Collapse chat history" : "Close navigation"}
            onClick={onClose}
          >
            {/* Phones pair with the PanelLeftOpen trigger in the mobile bar
                (owner directive 2026-07-29) — the matched collapse glyph reads
                as the same control; tablet keeps the frozen ×. */}
            {phone ? (
              <PanelLeftClose
                size={22.5}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            ) : (
              "×"
            )}
          </button>
        ) : (
          // Desktop header controls (owner directive 2026-07-21): chat search
          // + collapse-to-rail. In the rail these stack under the head; the
          // search button first re-expands so the field has room to render.
          <div className="dc-sidebar-actions">
            <button
              type="button"
              className="dc-icon-btn dc-hv2 dc-pressable dc-focusable"
              aria-label={searchOpen ? "Close chat search" : "Search chats"}
              aria-expanded={searchOpen}
              onClick={() => {
                if (rail) {
                  setRail(false);
                  setSearchOpen(true);
                } else {
                  setSearchOpen(open => {
                    if (open) setSearchQuery("");
                    return !open;
                  });
                }
              }}
            >
              <TextSearch size={22.5} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="dc-icon-btn dc-hv2 dc-pressable dc-focusable"
              aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!rail}
              onClick={() => setRail(!railCollapsed)}
            >
              {rail ? (
                <PanelLeftOpen
                  size={22.5}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              ) : (
                <PanelLeftClose
                  size={22.5}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        )}
      </div>
      {!compact && !rail && searchOpen && (
        <div className="dc-sidebar-search">
          <TextSearch
            className="dc-sidebar-search-ico"
            size={17.5}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            ref={searchInputRef}
            className="dc-sidebar-search-input"
            type="search"
            placeholder="Search chats"
            aria-label="Search recent chats"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
          />
        </div>
      )}
      <nav className="dc-nav-group" aria-label={phone ? "Chat" : "Primary"}>
        {/* Phones (owner directive 2026-07-29): New Chat only — the floating
            pill nav owns every other destination, so repeating them here would
            put two primary navs on one screen. Tablet/desktop keep the full
            row set. */}
        {(phone ? NAV_ROWS.filter(row => row.pane === "chat") : NAV_ROWS).map(
          row => {
            const href = preserveFootballContext(row.href(), location, search);
            const active = row.pane === activePane;
            const RowIcon = row.icon;
            return href === "#" ? (
              <button
                key={row.label}
                type="button"
                className="dc-sidebar-row dc-nav-disabled"
                aria-disabled="true"
                title={rail ? row.label : undefined}
              >
                <RowIcon
                  className="dc-nav-ico"
                  size={22.5}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="dc-sidebar-text">{row.label}</span>
              </button>
            ) : (
              <Link
                key={row.label}
                href={href}
                className={`dc-sidebar-row${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                title={rail ? row.label : undefined}
                onClick={(event: ReactMouseEvent) => {
                  if (row.pane === "chat") {
                    event.preventDefault();
                    onNewChat();
                    onShellNavigate?.(href);
                  } else if (onShellNavigate) {
                    event.preventDefault();
                    onShellNavigate(href);
                  }
                  onNavigate();
                }}
              >
                <RowIcon
                  className="dc-nav-ico"
                  size={22.5}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="dc-sidebar-text">{row.label}</span>
              </Link>
            );
          }
        )}
      </nav>
      {recentChats.length > 0 ? (
        <>
          <div className="dc-recents-head">
            <div className="dc-recents-label">Recent Chats</div>
            {onClearAllChats && isOwner && !phone && (
              // OWNER-ONLY platform sweep (owner directive 2026-07-21): clears
              // recent chats for every user, behind its own confirm upstream.
              // Tablet/desktop only — 2026-07-29 removed it from the phone
              // drawer (chat-history panel carries no destructive sweeps).
              <button
                type="button"
                className="dc-icon-btn dc-icon-btn--sm dc-hv2 dc-pressable dc-focusable"
                aria-label="Clear recent chats for all users"
                title="Clear recent chats for all users"
                onClick={onClearAllChats}
              >
                <Eraser size={17.5} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="dc-recent-list">
            {visibleChats.map(rc => (
              <div
                key={rc.id}
                className={`dc-recent-row${rowMenuId === rc.id ? " is-menu-open" : ""}`}
                ref={rowMenuId === rc.id ? rowMenuRef : undefined}
              >
                <a
                  href="#"
                  className={`dc-sidebar-row${rc.id === activeChatId ? " is-active" : ""}`}
                  aria-current={rc.id === activeChatId ? "true" : undefined}
                  onClick={event => {
                    event.preventDefault();
                    onOpenChat(rc.id);
                    onNavigate();
                  }}
                >
                  {rc.starred && (
                    <span className="dc-recent-star" aria-label="Starred">
                      ★
                    </span>
                  )}
                  <span className="dc-sidebar-text">{rc.title}</span>
                </a>
                <button
                  type="button"
                  className="dc-recent-more dc-hv2 dc-pressable dc-focusable"
                  aria-label={`Chat options: ${rc.title}`}
                  aria-haspopup="menu"
                  aria-expanded={rowMenuId === rc.id}
                  onClick={() =>
                    setRowMenuId(open => (open === rc.id ? null : rc.id))
                  }
                >
                  <Ellipsis size={20} strokeWidth={1.8} aria-hidden="true" />
                </button>
                {rowMenuId === rc.id && (
                  <div className="dc-recent-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="dc-menu-item dc-menu-item--strong dc-hv2 dc-focusable dc-pressable"
                      onClick={() => {
                        setRowMenuId(null);
                        onDeleteChat(rc.id);
                      }}
                    >
                      <Trash2
                        size={17.5}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      Delete chat
                    </button>
                  </div>
                )}
              </div>
            ))}
            {visibleChats.length === 0 && (
              <div className="dc-recent-empty">
                No chats match “{searchQuery.trim()}”
              </div>
            )}
          </div>
        </>
      ) : (
        // No stored conversations: hide the whole section (honesty — an empty
        // frozen shell must not render). The spacer takes over the recent
        // list's flex: 1 slot (D/L:65) so the profile row stays pinned.
        <div className="dc-sidebar-spacer" />
      )}
      {/* Phones (owner directive 2026-07-29): no profile section — account
          management lives behind the floating nav's Profile destination; the
          drawer stays a pure chat-history panel. */}
      {phone ? null : appUser ? (
        <div ref={profileRef} className="dc-sidebar-row dc-profile-row">
          {/* The avatar is itself a menu trigger — in the rail it is the whole
              profile section (owner directive 2026-07-21: collapsed shows only
              the profile picture), expanded it complements the gear. */}
          <button
            type="button"
            className="dc-avatar-btn dc-pressable dc-focusable"
            aria-label="Account settings"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}
          >
            <IdentityAvatar user={appUser} />
          </button>
          <div className="dc-profile-id">
            <div className="dc-profile-name">
              {displaySidebarName(appUser.username)}
            </div>
            <div className="dc-profile-tier">{deriveTierLabel(appUser)}</div>
          </div>
          {menuOpen && (
            <div
              className="dc-settings-menu open dc-settings-menu--enter"
              role="menu"
              onClick={e => e.stopPropagation()}
            >
              <div className="dc-menu-header">
                <IdentityAvatar user={appUser} menu />
                <div className="dc-menu-id">
                  <div className="dc-menu-handle-row">
                    <div className="dc-menu-handle">
                      {formatHandle(appUser.username)}
                    </div>
                    <div className="dc-badge-pro">
                      {deriveTierLabel(appUser).toUpperCase()}
                    </div>
                  </div>
                  {expiryLine && (
                    <div className="dc-menu-expiry">{expiryLine}</div>
                  )}
                </div>
              </div>
              {showPlanCtas && (
                <div className="dc-menu-cta-row">
                  <button
                    type="button"
                    role="menuitem"
                    className="dc-btn-upgrade dc-hv1 dc-focusable dc-pressable"
                    onClick={() => goTo("/checkout")}
                  >
                    Upgrade Membership
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="dc-btn-cancel dc-hv2 dc-focusable dc-pressable"
                    onClick={() => goTo("/account")}
                  >
                    Cancel Membership
                  </button>
                </div>
              )}
              <div className="dc-menu-divider" />
              {/* Account popover v2 (owner directive 2026-07-22: amends the
                  frozen D/L:89-90 rows — "Edit Profile" and "Discord
                  Connected" are cut from this popover; their content moves
                  to Settings in Step 2, and the /profile route + identity
                  helpers they used are untouched). Two panes sit side by
                  side in a 200%-wide flex row; toggling menuView swaps which
                  one is in view via one 160ms transform transition. DOM
                  order is [theme pane, root pane] on purpose: the resting
                  transform is translateX(-50%), so entering the Theme pane
                  always moves the slider RIGHTWARD (owner spec: "slides ...
                  left to right") and Back retraces the identical path in
                  reverse (apple-design §7 spatial consistency: enter/exit
                  share one path). */}
              <div className="dc-menu-viewport" ref={menuViewportRef}>
                <div
                  className={`dc-menu-slider${
                    menuView === "theme" ? " dc-menu-slider--theme" : ""
                  }`}
                >
                  <div
                    className="dc-menu-pane"
                    ref={menuThemePaneRef}
                    aria-hidden={menuView !== "theme"}
                    inert={menuView !== "theme"}
                  >
                    <button
                      type="button"
                      ref={themeBackBtnRef}
                      className="dc-menu-back dc-hv2 dc-focusable dc-pressable"
                      aria-label="Back to account menu"
                      onClick={() => setMenuView("root")}
                    >
                      <ChevronLeft
                        size={16}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      Theme
                    </button>
                    <div
                      className="dc-theme-segment"
                      role="radiogroup"
                      aria-label="Theme"
                    >
                      {THEME_MODE_OPTIONS.map(
                        ({ mode: optMode, label, Icon }) => (
                          <button
                            key={optMode}
                            type="button"
                            role="radio"
                            aria-checked={themeMode === optMode}
                            className={`dc-theme-option dc-hv2 dc-focusable dc-pressable${
                              themeMode === optMode ? " is-active" : ""
                            }`}
                            onClick={() => setThemeMode?.(optMode)}
                          >
                            <Icon
                              size={15}
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                            {label}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                  <div
                    className="dc-menu-pane"
                    ref={menuRootPaneRef}
                    aria-hidden={menuView === "theme"}
                    inert={menuView === "theme"}
                  >
                    <button
                      type="button"
                      ref={themeRowBtnRef}
                      role="menuitem"
                      className="dc-menu-item dc-menu-item--icon dc-hv2 dc-focusable dc-pressable"
                      aria-haspopup="menu"
                      onClick={() => setMenuView("theme")}
                    >
                      <SunMoon size={16} strokeWidth={1.8} aria-hidden="true" />
                      <span className="dc-menu-item-label">Theme</span>
                      <ChevronRight
                        size={15}
                        strokeWidth={1.8}
                        aria-hidden="true"
                        className="dc-menu-item-chevron"
                      />
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="dc-menu-item dc-menu-item--icon dc-hv2 dc-focusable dc-pressable"
                      onClick={() => {
                        setMenuOpen(false);
                        // Opens the real Settings modal (Username · Discord ·
                        // Reset Password · Billing) — wired in Round 3 Step 2.
                        onOpenSettings?.();
                      }}
                    >
                      <SettingsIcon
                        size={16}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      <span className="dc-menu-item-label">Settings</span>
                    </button>
                    {isOwner && (
                      <button
                        type="button"
                        role="menuitem"
                        className="dc-menu-item dc-menu-item--icon dc-hv2 dc-focusable dc-pressable"
                        onClick={() => goTo("/admin/users")}
                      >
                        <ShieldCheck
                          size={16}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                        <span className="dc-menu-item-label">
                          Admin Dashboard
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="dc-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="dc-menu-item dc-menu-item--strong dc-hv2 dc-focusable dc-pressable"
                disabled={logoutMutation.isPending}
                onClick={onLogout}
              >
                {logoutMutation.isPending ? "Logging out…" : "Log Out"}
              </button>
            </div>
          )}
          <button
            type="button"
            className="dc-settings-trigger dc-pressable dc-focusable"
            aria-label="Account settings"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}
          >
            <svg
              className="dc-settings-btn"
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d={GEAR_PATH} />
            </svg>
          </button>
        </div>
      ) : (
        // Auth still resolving (or preview): neutral row — the frozen sample
        // identity must never render for a real session.
        <div className="dc-sidebar-row dc-profile-row" aria-hidden="true" />
      )}
    </aside>
  );
}

/* ----------------------------------------------------------------- */
/* Hero + pills — D/L:98, 106-109                                     */
/* ----------------------------------------------------------------- */

function BrandHero({
  innerRef,
}: {
  innerRef?: MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="dc-hero" ref={innerRef}>
      <span className="dc-hero-word">
        <span>d</span>
        <span className="dc-hero-i">
          ı<span className="dc-hero-dot" />
        </span>
        <span>me</span>
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Conversation pieces — chat-derivation-spec.md §2                   */
/* ----------------------------------------------------------------- */

function DataPill({
  state,
  ageMinutes,
}: {
  state: DataFreshness;
  ageMinutes?: number;
}) {
  if (state === "live") {
    return (
      <span className="dc-datapill dc-datapill--live">
        <span className="dc-datapill-dot" />
        LIVE
      </span>
    );
  }
  if (state === "delayed") {
    return (
      <span className="dc-datapill dc-datapill--delayed">
        <span className="dc-datapill-dot" />
        {ageMinutes != null ? `DELAYED · ${ageMinutes}m` : "DELAYED"}
      </span>
    );
  }
  return <span className="dc-datapill dc-datapill--none">NO LIVE DATA</span>;
}

function Stat({
  label,
  value,
  mint = false,
}: {
  label: string;
  value: string;
  mint?: boolean;
}) {
  return (
    <div className="dc-stat">
      <div className="dc-microlabel dc-stat-label">{label}</div>
      <div className={`dc-stat-value${mint ? " dc-stat-value--mint" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function EdgeStatBlock({
  block,
  freshness,
}: {
  block: EdgeBlock;
  freshness: DataFreshness;
}) {
  const pass = block.verdict === "pass";
  const mintEdge = block.verdict === "edge_detected"; // mint ONLY on positive signal (spec §2.4)
  const pct = block.edgePct.endsWith("%") ? block.edgePct : `${block.edgePct}%`;
  return (
    <section
      className={`dc-edge${pass ? " dc-edge--pass" : ""}`}
      data-verdict={block.verdict}
    >
      <div className="dc-edge-header">
        <span className="dc-microlabel dc-edge-label">[EDGE]</span>
        <DataPill state={freshness} />
      </div>
      <div className="dc-edge-pick">{block.market}</div>
      <div className="dc-edge-stats">
        <Stat label="Model line" value={block.modelLine} />
        <Stat label="Market line" value={block.marketLine} />
        <Stat label="Edge" value={pct} mint={mintEdge} />
        <Stat label="Confidence" value={block.confidence} />
      </div>
    </section>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <div className="dc-prose">
      {segmentNumerals(text).map((part, i) =>
        part.kind === "num" ? (
          <span key={i} className="dc-num">
            {part.text}
          </span>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        )
      )}
    </div>
  );
}

/**
 * One conversation turn. Exported so the public landing page renders the
 * PRODUCT's bubbles, prose and [EDGE] blocks (owner directive 2026-07-31 —
 * "use the actual Dime Chat AI interface"), instead of a lookalike that
 * would drift from this one the first time chat rendering changes.
 */
export function Turn({
  msg,
  freshness,
  fx,
}: {
  msg: ChatMessage;
  freshness: DataFreshness;
  fx: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className={`dc-turn--user${fx ? " dc-fade-in" : ""}`}>
        <div className="dc-user-capsule">{msg.content}</div>
      </div>
    );
  }
  if (msg.status === "open" && msg.content === "") {
    // Pre-first-delta: dimeTyping dots, the ONLY thinking affordance (spec §2.8)
    return (
      <div className={`dc-turn--assistant${fx ? " dc-fade-in" : ""}`}>
        <div
          className="dc-typing-row"
          role="status"
          aria-label="Dime is thinking"
        >
          <span className="dc-typing-dot" />
          <span className="dc-typing-dot" />
          <span className="dc-typing-dot" />
        </div>
      </div>
    );
  }
  const segments = parseAssistantContent(msg.content, msg.status !== "open");
  return (
    <div className="dc-turn--assistant">
      {segments.map(
        (seg, i) =>
          seg.kind === "text" ? (
            <Prose key={i} text={seg.text} />
          ) : seg.kind === "edge" ? (
            <EdgeStatBlock key={i} block={seg.block} freshness={freshness} />
          ) : null // "pending": buffered partial [EDGE block — renders nothing until closed
      )}
      {msg.status === "interrupted" && (
        <div className="dc-footnote">
          Response interrupted. What's above is complete as far as it goes.
        </div>
      )}
      {msg.status === "stopped" && <div className="dc-footnote">Stopped.</div>}
    </div>
  );
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="dc-error-card">
      <div className="dc-microlabel dc-error-label">Connection</div>
      <div className="dc-error-message">{message}</div>
      <div>
        <button
          type="button"
          className="dc-btn-cancel dc-hv2 dc-focusable dc-pressable"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * Landing-demo answers. Product copy, not model output — the public embed
 * never calls the model (see `demoMode`). Matching is intentionally loose so
 * a visitor typing their own question still gets a coherent, honest reply
 * rather than silence.
 */
const DEMO_ANSWERS: Array<{ match: RegExp; answer: string }> = [
  {
    match: /pass|why/i,
    answer:
      "Pass. The book price and Dime's projection agree inside the noise band, so there is no edge to take. Most markets resolve here — that is the point of the scan, not a failure of it.",
  },
  {
    match: /disagree|edge|value/i,
    answer:
      "Edge detected. Dime projects 58.9% against a 53.5% implied price — a +5.4pp gap at −115, with confidence 74/100. Price moved −108 to −115 since open, so the number is still ahead of the market.",
  },
  {
    match: /total|over|under/i,
    answer:
      "Monitor. The total sits within a point of fair value and volatility is medium, so the number is live but not yet actionable. If it moves past fair value before close, it becomes a Pass.",
  },
];

const DEMO_FALLBACK =
  "This is a preview of the Dime Chat surface: the interface, the streaming, and the answer format are the product's own. Live answers run against tonight's real slate once you have access.";

function demoAnswerFor(question: string): string {
  return (
    DEMO_ANSWERS.find(entry => entry.match.test(question))?.answer ??
    DEMO_FALLBACK
  );
}

/* ----------------------------------------------------------------- */
/* Page                                                               */
/* ----------------------------------------------------------------- */

type GhostRects = {
  hero: { left: number; top: number; width: number; height: number };
  fading: boolean;
};

type DrawerGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  grabOffset: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  lastDirection: -1 | 0 | 1;
  claimed: boolean;
  rejected: boolean;
};

const DRAWER_FALLBACK_WIDTH = 293;

/** A `.stop()`-only handle shape, shared by the FLIP and drawer-settle refs. */
interface StoppableAnimation {
  stop: () => void;
}

const rectStyle = (r: {
  left: number;
  top: number;
  width: number;
  height: number;
}) => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

/** Linear interpolation matching the old `useTransform(drawerX, [-W, 0], [0, 0.46])`. */
const scrimOpacityFor = (x: number) => {
  const fraction = Math.min(
    1,
    Math.max(0, (x + DRAWER_FALLBACK_WIDTH) / DRAWER_FALLBACK_WIDTH)
  );
  return fraction * 0.46;
};

export interface DimeChatShellState {
  /** Pane currently painted; may lag the URL while a lazy chunk resolves. */
  renderedPane: DimeProductPane;
  /** URL-owned active item, updated immediately for sidebar semantics. */
  navigationPane: DimeProductPane;
  paneContent: ReactNode;
  paneHeading: string;
  onNavigate: (href: string) => void;
  externalScrollRef: MutableRefObject<HTMLDivElement | null>;
  chatHeadingRef: MutableRefObject<HTMLHeadingElement | null>;
  externalHeadingRef: MutableRefObject<HTMLHeadingElement | null>;
  onExternalScroll: () => void;
}

export interface DimeChatPageProps {
  theme?: Theme;
  shell?: DimeChatShellState;
  /** DEV-only visual-review escape hatch (previewGate.ts). Production builds
   *  always pass false/undefined, so the owner gate cannot be bypassed. */
  previewMode?: boolean;
  /**
   * Public landing-page demo (owner directive 2026-07-31). Renders the REAL
   * chat surface — sidebar, top bar, hero, composer, thread — for anonymous
   * visitors, with two hard guarantees:
   *   • no history reads/writes, even if an owner happens to be signed in
   *     (their private threads must never appear inside a marketing embed);
   *   • no SSE call. /api/dime/chat is auth-gated and costs model credits, so
   *     submits replay scripted product copy through the real reducer instead.
   */
  demoMode?: boolean;
  /** Forces the embedded demo's appearance independent of the visitor's theme
   *  (the landing hosts it on a light panel). demoMode only. */
  demoTheme?: "light" | "dark";
}

export default function DimeChatPage({
  theme: themeProp,
  shell,
  previewMode = false,
  demoMode = false,
  demoTheme,
}: DimeChatPageProps = {}) {
  const { theme: contextTheme, mode: contextThemeMode } = useTheme();
  const theme: Theme =
    themeProp ?? (contextTheme === "light" ? "light" : "dark");
  const themeMode = themeProp ?? contextThemeMode;
  const reduceMotion = useReducedMotionPreference();
  const { appUser, isOwner, loading: authLoading } = useAppAuth();

  // Owner gate (plan Phase 2, fail closed): the chat surface — hero, composer,
  // pills, thread — renders for owners only. While auth resolves nothing
  // renders (never flash the composer); resolved non-owners get the Dime
  // wordmark + AI MODEL CHAT COMING SOON. previewMode is compile-time gated
  // to DEV builds (previewGate.ts) for frozen-design review.
  const chatAccess: "granted" | "pending" | "denied" = demoMode
    ? "granted"
    : previewMode
      ? "granted"
      : authLoading
        ? "pending"
        : isOwner
          ? "granted"
          : "denied";

  // History reads/writes need a real authenticated owner session — previewMode
  // grants the visual surface only, never the tRPC history calls.
  // demoMode force-closes history: a signed-in owner scrolling the public
  // landing page must not see their own threads inside the embed.
  const historyReady = !demoMode && !!appUser && isOwner;

  // Settings modal (Round 3 Step 2, owner directive 2026-07-22): the
  // popover's Settings row (Step 1's onOpenSettings hook, TODO(step-2))
  // opens this; it closes itself and returns focus to the sidebar trigger.
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState("");
  const [ghost, setGhost] = useState<GhostRects | null>(null);
  const [stuck, setStuck] = useState(true);
  const [firstSendFx, setFirstSendFx] = useState(false);

  // ── Persistent chat history (dimeChats router) ──────────────────────────
  const utils = trpc.useUtils();
  const threadsQuery = trpc.dimeChats.list.useQuery(undefined, {
    enabled: historyReady,
    staleTime: 15_000,
  });
  const recentChats: ThreadSummary[] = (threadsQuery.data ?? []).map(
    (t: { id: number; title: string; starred: boolean }) => ({
      id: t.id,
      title: t.title,
      starred: t.starred,
    })
  );
  const [threadId, setThreadId] = useState<number | null>(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const threadMenuRef = useRef<HTMLDivElement | null>(null);
  // Rename drill-in inside the phone kebab menu (owner directive 2026-07-29
  // r3): non-null while the inline input is showing, prefilled with the
  // current title. Always cleared when the menu closes.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const pendingUserTextRef = useRef<string | null>(null);
  const prevStreamingRef = useRef(false);
  const clientSessionIdRef = useRef<string | null>(null);
  const traceStartingRef = useRef<Promise<DimeChatTraceTools> | null>(null);
  const activeClientTraceRef = useRef<DimeChatClientTraceState | null>(null);
  const lastServerTraceRef = useRef<DimeChatClientTraceState | null>(null);
  const createThreadMut = trpc.dimeChats.create.useMutation();
  const appendMut = trpc.dimeChats.appendMessages.useMutation();
  const renameMut = trpc.dimeChats.rename.useMutation();
  const setStarredMut = trpc.dimeChats.setStarred.useMutation();
  const setArchivedMut = trpc.dimeChats.setArchived.useMutation();
  const softDeleteMut = trpc.dimeChats.softDelete.useMutation();
  const activeThreadMeta = recentChats.find(t => t.id === threadId);
  const [compact, setCompact] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(max-width: 1023px)").matches
  );
  // <768px (owner directive 2026-07-29): phones swap the "Menu" trigger for
  // the PanelLeft* chat-history toggle, slim the drawer to New Chat + Recent
  // Chats, and drop the thread kebab. Tablet (768-1023) keeps the shipped
  // compact chrome.
  const [phone, setPhone] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(max-width: 767px)").matches
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMoving, setDrawerMoving] = useState(false);
  // Avenue toggle (owner directive 2026-08-01): every outgoing message is
  // scoped to the active data avenue — projections / splits / line movement.
  // The ref feeds runStream/submit without widening their dependency lists.
  const [avenue, setAvenueState] = useState<DimeChatAvenue>(() =>
    loadDimeChatAvenue()
  );
  const avenueRef = useRef(avenue);
  const setAvenue = useCallback((next: DimeChatAvenue) => {
    avenueRef.current = next;
    setAvenueState(next);
    saveDimeChatAvenue(next);
  }, []);

  const pageRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const chatPaneRef = useRef<HTMLElement | null>(null);
  const externalPaneRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeBatcherRef = useRef<RafDeltaBatcher | null>(null);
  const chatStartRef = useRef<number | null>(null);
  const flipFromRef = useRef<number | null>(null);
  const flipControlsRef = useRef<StoppableAnimation | null>(null);
  const flipGenerationRef = useRef(0);
  const stuckRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const mobileBarRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerGrabRef = useRef<HTMLDivElement | null>(null);
  const drawerScrimRef = useRef<HTMLButtonElement | null>(null);
  const drawerAnimationRef = useRef<StoppableAnimation | null>(null);
  const drawerAnimationGenerationRef = useRef(0);
  const drawerTargetRef = useRef(-DRAWER_FALLBACK_WIDTH);
  const drawerRestoreFocusRef = useRef(false);
  const drawerWidthRef = useRef(DRAWER_FALLBACK_WIDTH);
  const gestureRef = useRef<DrawerGesture | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  // ── Keyboard choreography (owner directive 2026-07-31) ────────────────────
  // The OS keyboard's inset is measured from visualViewport each frame; the
  // bar morph (compress + centered wordmark) rides a critically-damped
  // spring on --dc-kb-progress so open/close/reverse mid-flight never jumps,
  // while the CONTENT geometry tracks the keyboard 1:1 (no spring lag).
  const kbInsetRef = useRef(0);
  const kbOpenRef = useRef(false);
  const kbProgressRef = useRef(0);
  const kbSpringRef = useRef<SpringSettleHandle | null>(null);
  const kbFrameRef = useRef<number | null>(null);
  const kbLastTsRef = useRef<number | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  // Authoritative current drawer x (px); replaces framer-motion's MotionValue.
  const dragXRef = useRef(-DRAWER_FALLBACK_WIDTH);
  // rAF id for gesture drag-follow writes (batches pointermove into one paint).
  const dragFrameRef = useRef<number | null>(null);
  // Post-release settle physics (drawerMotion.ts owns the pure gesture math;
  // springSettle.ts owns this critically-damped integrator).
  const drawerSpringRef = useRef<SpringSettleHandle | null>(null);
  const drawerSpringFrameRef = useRef<number | null>(null);
  const drawerSpringLastTimeRef = useRef<number | null>(null);
  // Reassigned on every settleDrawer() call so a spring created for an
  // earlier generation still resolves to the CURRENT finish() when retargeted
  // mid-flight instead of being created (see settleDrawer's retarget branch).
  const drawerFinishRef = useRef<(() => void) | null>(null);

  const conversation = state.messages.length > 0;

  /** Writes the drawer transform + grab-strip transform + scrim opacity in
   * one synchronous DOM pass — the "same rAF write" the brief calls for,
   * whether driven by a gesture's drag-follow frame or the settle spring. */
  const writeDrawerVisual = useCallback((x: number) => {
    dragXRef.current = x;
    const transform = `translateX(${x}px)`;
    if (sidebarRef.current) sidebarRef.current.style.transform = transform;
    if (drawerGrabRef.current)
      drawerGrabRef.current.style.transform = transform;
    if (drawerScrimRef.current)
      drawerScrimRef.current.style.opacity = String(scrimOpacityFor(x));
  }, []);

  const scheduleDrawerFrame = useCallback(() => {
    if (dragFrameRef.current != null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      writeDrawerVisual(dragXRef.current);
    });
  }, [writeDrawerVisual]);

  const stopDrawerSettle = useCallback(() => {
    if (drawerSpringFrameRef.current != null) {
      cancelAnimationFrame(drawerSpringFrameRef.current);
      drawerSpringFrameRef.current = null;
    }
    drawerSpringRef.current?.stop();
    drawerSpringRef.current = null;
    drawerSpringLastTimeRef.current = null;
  }, []);

  const runDrawerSpringFrame = useCallback(
    (timestamp: number) => {
      const spring = drawerSpringRef.current;
      if (!spring) return;
      const last = drawerSpringLastTimeRef.current ?? timestamp;
      const dt = Math.min(0.1, Math.max(0, (timestamp - last) / 1000));
      drawerSpringLastTimeRef.current = timestamp;
      spring.step(dt);
      writeDrawerVisual(spring.value);
      if (spring.settled) {
        drawerSpringFrameRef.current = null;
        drawerSpringLastTimeRef.current = null;
        return;
      }
      drawerSpringFrameRef.current =
        requestAnimationFrame(runDrawerSpringFrame);
    },
    [writeDrawerVisual]
  );

  useEffect(
    () => () => {
      abortRef.current?.abort();
      activeBatcherRef.current?.dispose();
      flipControlsRef.current?.stop();
      drawerAnimationRef.current?.stop();
      if (dragFrameRef.current != null)
        cancelAnimationFrame(dragFrameRef.current);
      if (viewportFrameRef.current != null)
        cancelAnimationFrame(viewportFrameRef.current);
    },
    []
  );

  /* --- Responsive shell listener (matchMedia — no resize-loop thrash) --- */
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 1023px)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setCompact(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 767px)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setPhone(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* --- Mobile visual viewport: one read + one rAF write, no layout reads. --- */
  useEffect(() => {
    if (!compact || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const schedule = () => {
      if (viewportFrameRef.current != null) return;
      const height = viewport.height;
      const top = viewport.offsetTop;
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null;
        pageRef.current?.style.setProperty("--dc-visual-height", `${height}px`);
        pageRef.current?.style.setProperty("--dc-visual-top", `${top}px`);

        // Keyboard inset: the strip of layout viewport the OS keyboard eats.
        const inset = Math.max(0, window.innerHeight - height - top);
        const prevInset = kbInsetRef.current;
        kbInsetRef.current = inset;
        pageRef.current?.style.setProperty("--dc-kb-inset", `${inset}px`);
        // Also on <html>: the floating nav and body-level chrome live outside
        // .dc-page and must read the same keyboard state.
        document.documentElement.style.setProperty(
          "--dc-kb-inset",
          `${inset}px`
        );

        // Bubbles ride the keyboard 1:1 (owner directive 2026-07-31): the
        // page container already shrinks to the visual viewport, so keep the
        // reader's place — pinned threads re-pin to the newest bubble the
        // same frame; released threads shift by exactly the inset delta.
        const delta = inset - prevInset;
        const scroller = scrollerRef.current;
        if (scroller && delta !== 0) {
          programmaticScrollRef.current = true;
          if (stuckRef.current) scroller.scrollTop = scroller.scrollHeight;
          else scroller.scrollTop += delta;
        }

        // Bar choreography: spring --dc-kb-progress toward 1 (open) / 0
        // (closed). Retarget mid-flight — a dismiss during the open settle
        // reverses from the current value with velocity carried over.
        const open = inset > 80;
        if (open !== kbOpenRef.current) {
          kbOpenRef.current = open;
          setKbOpen(open);
          const target = open ? 1 : 0;
          const writeProgress = (v: number) => {
            kbProgressRef.current = v;
            pageRef.current?.style.setProperty("--dc-kb-progress", String(v));
            document.documentElement.style.setProperty(
              "--dc-kb-progress",
              String(v)
            );
          };
          document.documentElement.classList.toggle("dc-kb-open", open);
          if (reduceMotion) {
            kbSpringRef.current?.stop();
            kbSpringRef.current = null;
            writeProgress(target);
          } else if (kbSpringRef.current && !kbSpringRef.current.settled) {
            kbSpringRef.current.retarget(target);
          } else {
            kbSpringRef.current = createSpringSettle({
              from: kbProgressRef.current,
              to: target,
              onUpdate: writeProgress,
            });
            kbLastTsRef.current = null;
            const run = (ts: number) => {
              const spring = kbSpringRef.current;
              if (!spring || spring.settled) {
                kbFrameRef.current = null;
                kbLastTsRef.current = null;
                return;
              }
              const last = kbLastTsRef.current;
              kbLastTsRef.current = ts;
              spring.step(
                last == null ? 1 / 60 : Math.min((ts - last) / 1000, 1 / 20)
              );
              kbFrameRef.current = requestAnimationFrame(run);
            };
            if (kbFrameRef.current == null)
              kbFrameRef.current = requestAnimationFrame(run);
          }
        }
      });
    };
    // iOS Safari pushes the DOCUMENT up on focus instead of resizing the
    // layout viewport, desyncing every position:fixed offset (the shell floats
    // mid-screen with dead space above it — the real-device failure this
    // hardening fixes). The chat shell is fully fixed and needs no document
    // scroll at all, so pin it back to 0 and resample.
    const pinDocument = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    // Safari emits ONE visualViewport resize part-way through the keyboard's
    // ~250ms slide, so a single read lands on stale geometry. Resample across
    // the animation until two consecutive frames agree, then stop — no polling
    // once the keyboard is at rest.
    let settleFrame: number | null = null;
    let settleUntil = 0;
    let lastHeight = -1;
    const settleSample = () => {
      settleFrame = null;
      const h = viewport.height;
      const stable = h === lastHeight;
      lastHeight = h;
      pinDocument();
      schedule();
      if (!stable || performance.now() < settleUntil)
        settleFrame = requestAnimationFrame(settleSample);
    };
    const startSettle = () => {
      settleUntil = performance.now() + 420; // covers the slowest iOS slide
      lastHeight = -1;
      if (settleFrame == null)
        settleFrame = requestAnimationFrame(settleSample);
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        startSettle();
    };

    schedule();
    viewport.addEventListener("resize", startSettle);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("scroll", pinDocument, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", startSettle);
    return () => {
      viewport.removeEventListener("resize", startSettle);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", pinDocument);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", startSettle);
      if (settleFrame != null) cancelAnimationFrame(settleFrame);
      document.documentElement.classList.remove("dc-kb-open");
      document.documentElement.style.removeProperty("--dc-kb-progress");
      document.documentElement.style.removeProperty("--dc-kb-inset");
      if (viewportFrameRef.current != null)
        cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
      kbSpringRef.current?.stop();
      kbSpringRef.current = null;
      if (kbFrameRef.current != null) cancelAnimationFrame(kbFrameRef.current);
      kbFrameRef.current = null;
    };
  }, [compact, reduceMotion]);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    drawerWidthRef.current =
      sidebar.getBoundingClientRect().width || DRAWER_FALLBACK_WIDTH;
    pageRef.current?.style.setProperty(
      "--dc-drawer-width",
      `${drawerWidthRef.current}px`
    );
    if (compact) writeDrawerVisual(drawerOpen ? 0 : -drawerWidthRef.current);
    else {
      drawerAnimationRef.current?.stop();
      writeDrawerVisual(0);
      setDrawerOpen(false);
      setDrawerMoving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- writeDrawerVisual is a stable ref-only callback
  }, [compact]);

  const settleDrawer = useCallback(
    (target: number, velocityX = 0, restoreFocus = false) => {
      const generation = ++drawerAnimationGenerationRef.current;
      drawerTargetRef.current = target;
      drawerRestoreFocusRef.current = restoreFocus;
      setDrawerMoving(true);

      const finish = () => {
        if (generation !== drawerAnimationGenerationRef.current) return;
        drawerAnimationRef.current = null;
        setDrawerMoving(false);
        if (target < 0) {
          setDrawerOpen(false);
          // Defer to a frame: under reduceMotion this `finish()` runs
          // synchronously inside the same tick as the triggering event
          // (e.g. the Escape keydown handler), *before* React commits
          // `drawerOpen: false` and the modal-semantics effect below lifts
          // `inert` off the mobile bar. Calling `.focus()` on an element
          // that is still inert at that instant is a silent no-op, so
          // focus never actually reaches the trigger.
          if (restoreFocus)
            requestAnimationFrame(() => menuButtonRef.current?.focus());
        } else {
          setDrawerOpen(true);
        }
      };
      drawerFinishRef.current = finish;

      if (reduceMotion) {
        stopDrawerSettle();
        writeDrawerVisual(target);
        finish();
        return;
      }

      const existing = drawerSpringRef.current;
      // A settle already in flight: retarget it so position AND (unless a
      // fresh gesture measured its own release velocity) velocity carry over
      // with no jump, instead of restarting from rest. `velocityX` is only
      // ever nonzero here when endDrawerGesture just measured a real release.
      if (existing && !existing.settled) {
        existing.retarget(target, velocityX !== 0 ? velocityX : undefined);
      } else {
        drawerSpringRef.current = createSpringSettle({
          from: dragXRef.current,
          to: target,
          velocity: velocityX,
          onUpdate: writeDrawerVisual,
          onSettle: () => drawerFinishRef.current?.(),
        });
      }
      drawerAnimationRef.current = { stop: stopDrawerSettle };
      if (drawerSpringFrameRef.current == null) {
        drawerSpringFrameRef.current =
          requestAnimationFrame(runDrawerSpringFrame);
      }
    },
    [reduceMotion, stopDrawerSettle, writeDrawerVisual, runDrawerSpringFrame]
  );

  useEffect(() => {
    if (!reduceMotion || !drawerAnimationRef.current) return;
    drawerAnimationGenerationRef.current++;
    drawerAnimationRef.current.stop();
    drawerAnimationRef.current = null;
    writeDrawerVisual(drawerTargetRef.current);
    setDrawerMoving(false);
    const closed = drawerTargetRef.current < 0;
    setDrawerOpen(!closed);
    // Same inert/focus race as settleDrawer's `finish()` above — defer so
    // this runs after the modal-semantics effect lifts `inert`.
    if (closed && drawerRestoreFocusRef.current)
      requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, [reduceMotion, writeDrawerVisual]);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    settleDrawer(0);
  }, [settleDrawer]);

  const closeDrawer = useCallback(
    (restoreFocus = true) => {
      settleDrawer(-drawerWidthRef.current, 0, restoreFocus);
    },
    [settleDrawer]
  );

  /* --- Modal drawer semantics: inert background, focus trap, Escape, restore. --- */
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const main = mainRef.current;
    const mobileBar = mobileBarRef.current;
    if (!compact) {
      if (sidebar) sidebar.inert = false;
      if (main) main.inert = false;
      if (mobileBar) mobileBar.inert = false;
      return;
    }

    // [PR #70 REMEDIATION 2026-07-12] `main.inert`/`mobileBar.inert` used to
    // mirror `drawerOpen` directly. Under reduced motion, the (now-gated)
    // gesture path could previously flip `drawerOpen` true while the drawer
    // was still fully off-screen, freezing the background behind an
    // invisible drawer. `resolveDrawerAccessibility` (drawerMotion.ts)
    // encodes the corrected rule and is unit-tested against the full truth
    // table, including that exact regression.
    const width = drawerWidthRef.current;
    const drawerVisibleFraction =
      width > 0 ? (dragXRef.current + width) / width : 0;
    const { mainInert, trapFocus } = resolveDrawerAccessibility({
      drawerOpen,
      drawerMoving,
      drawerVisibleFraction,
      // useReducedMotion() is `boolean | null` (null before the media query
      // resolves) — treat "unresolved" the same as "no preference" (false).
      reduceMotion: !!reduceMotion,
    });

    if (sidebar) sidebar.inert = !drawerOpen;
    if (main) main.inert = mainInert;
    if (mobileBar) mobileBar.inert = mainInert;
    if (!trapFocus || !sidebar) return;

    const focusables = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([aria-disabled="true"]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter(el => !el.hasAttribute("aria-hidden"));
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
    };
  }, [compact, drawerOpen, drawerMoving, reduceMotion, closeDrawer]);

  useEffect(() => {
    if (!shell) return;
    const chatActive = shell.renderedPane === "chat";
    if (chatPaneRef.current) chatPaneRef.current.inert = !chatActive;
    if (externalPaneRef.current) externalPaneRef.current.inert = chatActive;
  }, [shell?.renderedPane]);

  const beginDrawerGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>, requireIntent: boolean) => {
      if (event.button !== 0) return;
      // [PR #70 REMEDIATION 2026-07-12] Under reduced motion the drawer
      // opens/closes ONLY via its button and keyboard — gestures must never
      // claim the pointer for drawer purposes. Refusing to start a gesture
      // here (rather than only gating the later drag-follow visual write, as
      // before) keeps `drawerOpen`/`drawerMoving` from ever flipping true
      // mid-swipe while the drawer stays off-screen, and lets the 24px edge
      // strip fall through as an ordinary scroll/no-op.
      if (reduceMotion) return;
      drawerAnimationGenerationRef.current++;
      drawerAnimationRef.current?.stop();
      drawerAnimationRef.current = null;
      const currentX = dragXRef.current;
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        grabOffset: event.clientX - currentX,
        lastX: event.clientX,
        lastTime: event.timeStamp,
        velocityX: 0,
        lastDirection: 0,
        claimed: !requireIntent,
        rejected: false,
      };
      if (!requireIntent) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrawerMoving(true);
      }
    },
    [reduceMotion]
  );

  const moveDrawerGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.rejected)
        return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;

      if (!gesture.claimed) {
        const intent = classifyPointerIntent(dx, dy);
        if (intent === "pending") return;
        if (intent === "vertical") {
          gesture.rejected = true;
          gestureRef.current = null;
          return;
        }
        gesture.claimed = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrawerOpen(true);
        setDrawerMoving(true);
      }

      event.preventDefault();
      const elapsed = Math.max(1, event.timeStamp - gesture.lastTime);
      const step = event.clientX - gesture.lastX;
      gesture.velocityX = (step / elapsed) * 1000;
      if (Math.abs(step) >= 0.25) gesture.lastDirection = step > 0 ? 1 : -1;
      gesture.lastX = event.clientX;
      gesture.lastTime = event.timeStamp;

      if (!reduceMotion) {
        const raw = event.clientX - gesture.grabOffset;
        dragXRef.current = rubberBand(raw, -drawerWidthRef.current, 0);
        scheduleDrawerFrame();
      }
    },
    [reduceMotion, scheduleDrawerFrame]
  );

  const endDrawerGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (!gesture.claimed || gesture.rejected) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const target = resolveDrawerTarget({
        velocityX: gesture.velocityX,
        lastDirection: gesture.lastDirection,
        closedX: -drawerWidthRef.current,
      });
      settleDrawer(target, gesture.velocityX, target < 0);
    },
    [settleDrawer]
  );

  const startDimeChatTrace = useCallback(
    (
      start: (
        traceTools: DimeChatTraceTools,
        traceLoad: Promise<DimeChatTraceTools>
      ) => void
    ) => {
      const traceLoad = loadDimeChatTrace();
      traceStartingRef.current = traceLoad;
      void traceLoad
        .then(traceTools => {
          if (traceStartingRef.current === traceLoad) {
            start(traceTools, traceLoad);
          }
        })
        .catch(() => {
          if (traceStartingRef.current === traceLoad) {
            traceStartingRef.current = null;
          }
        });
    },
    []
  );

  /* --- SSE streaming core (preserved from the previous DimeChat.tsx) --- */
  const runStream = useCallback(
    async (
      history: Array<{ role: "user" | "assistant"; content: string }>,
      assistantId: string,
      traceRequest: DimeChatTraceRequest,
      traceTools: DimeChatTraceTools,
      traceLoad: Promise<DimeChatTraceTools>
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;

      let settled = false;
      const batcher = createRafDeltaBatcher(text => {
        dispatch({ type: "stream_delta", id: assistantId, text });
      });
      activeBatcherRef.current?.dispose();
      activeBatcherRef.current = batcher;
      dimeDebug("stream.open", { historyLength: history.length });

      const bindServerTrace = (value: unknown) => {
        const active = activeClientTraceRef.current;
        const serverTrace = traceTools.bindDimeChatServerTrace(
          value,
          active,
          assistantId,
          traceRequest.idempotencyKey
        );
        if (!serverTrace || !active) return null;
        lastServerTraceRef.current = active;
        setThreadId(serverTrace.threadId);
        return serverTrace;
      };

      try {
        const res = await fetch("/api/dime/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: history,
            trace: traceRequest,
            // Forward-compatible native scoping channel (owner directive
            // 2026-08-01): ignored by the server today, honored by the
            // upcoming per-avenue retrievers.
            avenue: avenueRef.current,
          }),
        });

        const active = activeClientTraceRef.current;
        traceTools.claimDimeChatTraceResponse(
          res.headers.get("X-Dime-Trace-Version"),
          active,
          assistantId,
          traceRequest.idempotencyKey
        );

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            trace?: unknown;
          } | null;
          bindServerTrace(payload?.trace);
          throw new Error();
        }
        if (!res.body) {
          throw new Error();
        }

        chatStartRef.current = Date.now();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find(l => l.startsWith("data: "));
            if (!line) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "delta" && typeof event.text === "string") {
                batcher.push(event.text);
              } else if (event.type === "meta") {
                if (
                  event.dataFreshness === "live" ||
                  event.dataFreshness === "delayed" ||
                  event.dataFreshness === "none"
                ) {
                  dispatch({
                    type: "meta",
                    dataFreshness: event.dataFreshness,
                  });
                }
                bindServerTrace(event.trace);
              } else if (
                event.type === "error" &&
                typeof event.message === "string"
              ) {
                bindServerTrace(event.trace);
                settled = true;
                batcher.flushBeforeTerminal(() =>
                  dispatch({
                    type: "stream_error",
                    id: assistantId,
                    message: event.message,
                  })
                );
              } else if (event.type === "done") {
                bindServerTrace(event.trace);
                settled = true;
                batcher.flushBeforeTerminal(() =>
                  dispatch({ type: "stream_done", id: assistantId })
                );
                emitEvent("chat_response_completed", {
                  featureId: "dime_chat",
                  outcome: "success",
                  ...(chatStartRef.current
                    ? {
                        props: {
                          latency_ms: Math.max(
                            0,
                            Date.now() - chatStartRef.current
                          ),
                        },
                      }
                    : {}),
                });
                chatStartRef.current = null;
              }
            } catch {
              dimeDebug("frame.parse_failure", { raw: line.slice(0, 100) });
            }
          }
        }

        if (!settled) {
          batcher.flushBeforeTerminal(() =>
            dispatch({ type: "stream_done", id: assistantId })
          );
        }

        dimeDebug("stream.done");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          batcher.flushBeforeTerminal(() =>
            dispatch({ type: "stream_abort", id: assistantId })
          );
        } else {
          batcher.flushBeforeTerminal(() =>
            dispatch({
              type: "stream_error",
              id: assistantId,
              message: ERROR_COPY,
            })
          );
          dimeDebug("stream.error", { error: (err as Error).message });
        }
      } finally {
        batcher.dispose();
        if (activeBatcherRef.current === batcher)
          activeBatcherRef.current = null;
        abortRef.current = null;
        if (traceStartingRef.current === traceLoad) {
          traceStartingRef.current = null;
        }
      }
    },
    []
  );

  const captureComposerPresentation = useCallback(() => {
    const composer = composerRef.current;
    if (!composer) return;
    flipGenerationRef.current++;
    flipControlsRef.current?.stop();
    flipControlsRef.current = null;
    flipFromRef.current = composer.getBoundingClientRect().top;
  }, []);

  /* --- Landing-demo replay (no network, real reducer) --- */
  const demoTimersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      demoTimersRef.current.forEach(id => window.clearTimeout(id));
      demoTimersRef.current = [];
    },
    []
  );
  const demoReplay = useCallback(
    (question: string) => {
      demoTimersRef.current.forEach(id => window.clearTimeout(id));
      demoTimersRef.current = [];
      const answer = demoAnswerFor(question);
      const userId = `demo-u-${Date.now()}`;
      const botId = `demo-a-${Date.now()}`;
      dispatch({ type: "append_user", id: userId, text: question });
      setInput("");
      dispatch({ type: "open_assistant", id: botId });
      if (reduceMotion) {
        dispatch({ type: "stream_delta", id: botId, text: answer });
        dispatch({ type: "stream_done", id: botId });
        return;
      }
      // Cadence chosen to read as live typing without outpacing the eye.
      let cursor = 0;
      const step = () => {
        const next = Math.min(answer.length, cursor + 3);
        dispatch({
          type: "stream_delta",
          id: botId,
          text: answer.slice(cursor, next),
        });
        cursor = next;
        if (cursor < answer.length) {
          demoTimersRef.current.push(window.setTimeout(step, 26));
        } else {
          dispatch({ type: "stream_done", id: botId });
        }
      };
      demoTimersRef.current.push(window.setTimeout(step, 620));
    },
    [reduceMotion]
  );

  /* --- Single submit choke point: composer, Enter, chips, all of it --- */
  const submit = useCallback(
    (text: string) => {
      // Defense in depth: non-owners have no composer, but no programmatic
      // path may start a stream either (server 403s regardless).
      if (chatAccess !== "granted") return;
      const trimmed = text.trim();
      if (!trimmed || state.streaming || traceStartingRef.current) return;
      // Landing demo: replay scripted product copy through the SAME reducer
      // the live stream drives (append_user → open_assistant → deltas →
      // done), so the surface behaves exactly like the product without ever
      // touching the auth-gated, credit-metered SSE endpoint.
      if (demoMode) {
        demoReplay(trimmed);
        return;
      }
      // Avenue scoping (owner directive 2026-08-01): the visible scope suffix
      // rides the text channel (transparency — the bubble shows exactly what
      // was sent); the body-level `avenue` field rides alongside in runStream.
      const scoped = applyDimeAvenueScope(trimmed, avenueRef.current);
      startDimeChatTrace((traceTools, traceLoad) => {
        // D3 analytics (inert until an island registers the emitter).
        emitAction("chat_message_sent", {
          props: {
            len_bucket:
              trimmed.length < 120
                ? "short"
                : trimmed.length < 600
                  ? "medium"
                  : "long",
          },
        });

        pendingUserTextRef.current = scoped;
        const wasHome = state.messages.length === 0;
        if (wasHome) captureComposerPresentation();
        if (wasHome && !reduceMotion) {
          const hero = heroRef.current?.getBoundingClientRect();
          if (hero) {
            setGhost({
              hero: {
                left: hero.left,
                top: hero.top,
                width: hero.width,
                height: hero.height,
              },
              fading: false,
            });
          }
          setFirstSendFx(true);
        }

        setInput("");
        stuckRef.current = true;
        setStuck(true);

        const trace = traceTools.createInitialDimeChatTrace({
          threadId,
          clientSessionId: clientSessionIdRef.current,
        });
        const { userId, state: activeTrace } = trace;
        const { assistantId, request: traceRequest } = activeTrace;
        clientSessionIdRef.current = trace.clientSessionId;
        activeClientTraceRef.current = activeTrace;
        const history = [
          ...state.messages.map(({ role, content }) => ({ role, content })),
          { role: "user" as const, content: scoped },
        ];
        dispatch({ type: "append_user", id: userId, text: scoped });
        dispatch({ type: "open_assistant", id: assistantId });
        void runStream(
          history,
          assistantId,
          traceRequest,
          traceTools,
          traceLoad
        );
      });
    },
    [
      chatAccess,
      demoMode,
      demoReplay,
      state.streaming,
      state.messages,
      threadId,
      runStream,
      reduceMotion,
      captureComposerPresentation,
      startDimeChatTrace,
    ]
  );

  /** Retry re-runs the same history (failed empty row was already removed — spec §2.6). */
  const retry = useCallback(() => {
    if (chatAccess !== "granted") return;
    if (
      state.streaming ||
      state.messages.length === 0 ||
      traceStartingRef.current
    )
      return;
    const last = state.messages[state.messages.length - 1];
    if (last.role !== "user") return;
    startDimeChatTrace((traceTools, traceLoad) => {
      const trace = traceTools.createRetryDimeChatTrace({
        threadId,
        clientSessionId: clientSessionIdRef.current,
        clientUserMessageId: last.id,
        activeTrace: activeClientTraceRef.current,
        settledTrace: lastServerTraceRef.current,
      });
      const { assistantId, request: traceRequest } = trace.state;
      clientSessionIdRef.current = trace.clientSessionId;
      activeClientTraceRef.current = trace.state;
      dispatch({ type: "open_assistant", id: assistantId });
      void runStream(
        state.messages.map(({ role, content }) => ({ role, content })),
        assistantId,
        traceRequest,
        traceTools,
        traceLoad
      );
    });
  }, [
    chatAccess,
    state.streaming,
    state.messages,
    threadId,
    runStream,
    startDimeChatTrace,
  ]);

  const stop = () => abortRef.current?.abort();

  const newChat = useCallback(() => {
    emitAction("chat_started");
    if (state.messages.length > 0) captureComposerPresentation();
    abortRef.current?.abort();
    activeBatcherRef.current?.dispose();
    activeBatcherRef.current = null;
    dispatch({ type: "reset" });
    setThreadId(null);
    setThreadMenuOpen(false);
    pendingUserTextRef.current = null;
    traceStartingRef.current = null;
    activeClientTraceRef.current = null;
    lastServerTraceRef.current = null;
    setInput("");
    setGhost(null);
    setFirstSendFx(false);
    stuckRef.current = true;
    setStuck(true);
  }, [state.messages.length, captureComposerPresentation]);

  /* --- Persist each settled turn to the dimeChats history (fire-and-forget:
         storage failures never block the visible conversation). --- */
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = state.streaming;
    if (!wasStreaming || state.streaming) return; // only on stream settle
    if (!historyReady) return;

    const activeTrace = activeClientTraceRef.current;
    if (activeTrace?.serverOwned) {
      pendingUserTextRef.current = null;
      if (activeTrace.serverTrace) {
        lastServerTraceRef.current = activeTrace;
        setThreadId(activeTrace.serverTrace.threadId);
      }
      activeClientTraceRef.current = null;
      void utils.dimeChats.list.invalidate();
      return;
    }

    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== "assistant" || last.content === "") return;

    const userText = pendingUserTextRef.current;
    pendingUserTextRef.current = null;
    const assistantText = last.content;
    const refreshList = () => void utils.dimeChats.list.invalidate();

    if (threadId == null) {
      if (!userText) return;
      createThreadMut.mutate(
        {
          firstMessage: userText,
          firstAssistantMessage: assistantText,
        },
        {
          onSuccess: ({ threadId: newId }) => {
            setThreadId(newId);
            refreshList();
          },
        }
      );
    } else {
      const turn = userText
        ? [
            { role: "user" as const, content: userText },
            { role: "assistant" as const, content: assistantText },
          ]
        : [{ role: "assistant" as const, content: assistantText }];
      appendMut.mutate(
        { threadId, messages: turn },
        { onSettled: refreshList }
      );
    }
    activeClientTraceRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.streaming, state.messages, threadId, historyReady]);

  /* --- Resume a stored conversation from the sidebar. --- */
  const openChat = useCallback(
    async (id: number) => {
      abortRef.current?.abort();
      activeBatcherRef.current?.dispose();
      activeBatcherRef.current = null;
      try {
        const data = await utils.dimeChats.get.fetch({ threadId: id });
        dispatch({
          type: "hydrate",
          messages: data.messages.map(
            (msg: { role: "user" | "assistant"; content: string }) => ({
              role: msg.role,
              content: msg.content,
            })
          ),
        });
        setThreadId(id);
        setThreadMenuOpen(false);
        pendingUserTextRef.current = null;
        activeClientTraceRef.current = null;
        lastServerTraceRef.current = null;
        setInput("");
        stuckRef.current = true;
        setStuck(true);
      } catch (err) {
        dimeDebug("history.open_failed", { error: (err as Error).message });
      }
    },
    [utils]
  );

  /* --- "⋯" chat settings: Star / Archive / Delete for the open thread. --- */
  useEffect(() => {
    if (!threadMenuOpen) setRenameDraft(null);
    if (!threadMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!threadMenuRef.current?.contains(e.target as Node))
        setThreadMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThreadMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [threadMenuOpen]);

  const refreshThreads = useCallback(
    () => void utils.dimeChats.list.invalidate(),
    [utils]
  );

  /** Commit the phone-menu rename: sanitized server-side; empty input is a
   *  no-op cancel. The stored title is the user's — the topic engine never
   *  overrides an explicit rename. */
  const commitRename = useCallback(() => {
    const title = (renameDraft ?? "").replace(/\s+/g, " ").trim();
    setThreadMenuOpen(false);
    setRenameDraft(null);
    if (threadId == null || title === "") return;
    renameMut.mutate({ threadId, title }, { onSettled: refreshThreads });
  }, [renameDraft, threadId, renameMut, refreshThreads]);

  const toggleStar = useCallback(() => {
    if (threadId == null) return;
    if (!activeThreadMeta?.starred) emitAction("chat_starred");
    setThreadMenuOpen(false);
    setStarredMut.mutate(
      { threadId, starred: !activeThreadMeta?.starred },
      { onSettled: refreshThreads }
    );
  }, [threadId, activeThreadMeta?.starred, setStarredMut, refreshThreads]);

  const archiveThread = useCallback(() => {
    if (threadId == null) return;
    setThreadMenuOpen(false);
    setArchivedMut.mutate(
      { threadId, archived: true },
      {
        onSettled: () => {
          refreshThreads();
          newChat();
        },
      }
    );
  }, [threadId, setArchivedMut, refreshThreads, newChat]);

  const deleteThread = useCallback(() => {
    if (threadId == null) return;
    if (
      !window.confirm("Delete this chat? It will be removed from your history.")
    )
      return;
    emitAction("chat_deleted");
    setThreadMenuOpen(false);
    softDeleteMut.mutate(
      { threadId },
      {
        onSettled: () => {
          refreshThreads();
          newChat();
        },
      }
    );
  }, [threadId, softDeleteMut, refreshThreads, newChat]);

  /* --- Sidebar "…" delete (owner directive 2026-07-21): any recent chat,
         not just the open one; deleting the open thread resets to new chat. --- */
  const deleteRecentChat = useCallback(
    (id: number) => {
      if (
        !window.confirm(
          "Delete this chat? It will be removed from your history."
        )
      )
        return;
      emitAction("chat_deleted");
      softDeleteMut.mutate(
        { threadId: id },
        {
          onSettled: () => {
            refreshThreads();
            if (id === threadId) newChat();
          },
        }
      );
    },
    [softDeleteMut, refreshThreads, threadId, newChat]
  );

  /* --- OWNER-ONLY platform sweep (owner directive 2026-07-21): soft-deletes
         every user's live threads so Recent Chats clears platform-wide. --- */
  const clearAllMut = trpc.dimeChats.clearAllForEveryone.useMutation();
  const clearAllRecentChats = useCallback(() => {
    if (
      !window.confirm(
        "Clear recent chats for ALL users? Every user's chat history disappears from their sidebar."
      )
    )
      return;
    clearAllMut.mutate(undefined, {
      onSettled: () => {
        refreshThreads();
        newChat();
      },
    });
  }, [clearAllMut, refreshThreads, newChat]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(input);
  };

  /* --- Interruptible FLIP: measured presentation → final layout, no timer ownership. --- */
  useLayoutEffect(() => {
    if (flipFromRef.current == null) return;
    const el = composerRef.current;
    const from = flipFromRef.current;
    flipFromRef.current = null;
    if (!el) return;
    const delta = from - el.getBoundingClientRect().top;
    el.style.transform = `translateY(${delta}px)`;
    if (reduceMotion) {
      el.style.removeProperty("transform");
      setGhost(null);
      setFirstSendFx(false);
      return;
    }

    // PR #70: CSS transition (`.dc-composer--flip`, conversation.css)
    // replaces framer-motion's `animate(el, {transform}, {duration, ease})`.
    // The "from" transform above is already committed; adding the class here
    // and flipping to the end value one rAF later is what makes the browser
    // observe two separate style states and actually play the transition.
    const generation = ++flipGenerationRef.current;
    el.classList.add("dc-composer--flip");

    const cleanup = () => {
      el.removeEventListener("transitionend", onTransitionEnd);
      el.classList.remove("dc-composer--flip");
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== "transform") return;
      if (generation !== flipGenerationRef.current) return;
      cleanup();
      flipControlsRef.current = null;
      el.style.removeProperty("transform");
      setGhost(null);
      setFirstSendFx(false);
    };
    el.addEventListener("transitionend", onTransitionEnd);

    const frame = requestAnimationFrame(() => {
      setGhost(current => (current ? { ...current, fading: true } : current));
      el.style.transform = "translateY(0px)";
    });

    flipControlsRef.current = {
      stop: () => {
        // Interruption (a new send/newChat fires before this settles):
        // freeze at the CURRENT on-screen position — read the live computed
        // transform before tearing down — rather than snapping to either
        // end. captureComposerPresentation() measures
        // getBoundingClientRect() immediately after calling this, and that
        // read must reflect where the composer visually still is.
        const computed = getComputedStyle(el).transform;
        cleanup();
        if (computed && computed !== "none") el.style.transform = computed;
        else el.style.removeProperty("transform");
      },
    };

    return () => cancelAnimationFrame(frame);
  }, [conversation, reduceMotion]);

  useEffect(() => {
    if (!reduceMotion || !flipControlsRef.current) return;
    flipGenerationRef.current++;
    flipControlsRef.current.stop();
    flipControlsRef.current = null;
    composerRef.current?.style.removeProperty("transform");
    setGhost(null);
    setFirstSendFx(false);
  }, [reduceMotion]);

  /* --- Scroll policy: stick / release / re-stick on user action (spec §1.b) --- */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stuckRef.current) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight; // same frame, no smooth behavior
  }, [state.messages]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const wasProgrammatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;
    const top = el.scrollTop;
    if (!wasProgrammatic && top < lastScrollTopRef.current) {
      stuckRef.current = false; // released the instant the user scrolls upward
    }
    if (el.scrollHeight - top - el.clientHeight <= 48) {
      stuckRef.current = true; // at bottom (≤48px slack)
    }
    lastScrollTopRef.current = top;
    setStuck(stuckRef.current);
  };

  const jumpToLatest = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stuckRef.current = true;
    setStuck(true);
    programmaticScrollRef.current = true;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <div
      ref={pageRef}
      className={`dc-page dc-page--app theme-${demoTheme ?? theme} theme-mode-${demoTheme ?? themeMode}${drawerMoving ? " dc-drawer-is-moving" : ""}`}
      data-theme={theme}
      data-theme-mode={themeMode}
    >
      <div className="dc-app">
        {compact && (
          <div className="dc-mobile-bar" ref={mobileBarRef}>
            <button
              ref={menuButtonRef}
              type="button"
              className="dc-mobile-menu dc-focusable dc-pressable"
              aria-haspopup="dialog"
              aria-expanded={drawerOpen}
              aria-label={phone ? "Expand chat history" : undefined}
              onClick={openDrawer}
            >
              {/* Phones (owner directive 2026-07-29): the "Menu" word goes —
                  the PanelLeftOpen glyph is the chat-history toggle, matching
                  the PanelLeftClose inside the drawer. Tablet keeps "Menu". */}
              {phone ? (
                <PanelLeftOpen
                  size={22.5}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              ) : (
                "Menu"
              )}
            </button>
            {/* Avenue toggle (owner directive 2026-08-01, supersedes the
                2026-07-29 r2 empty-center rule and the tablet wordmark):
                the bar center carries the 3-segment data-avenue control on
                tablet and phone. Phones hand the center back to the kb
                wordmark while the keyboard is up (the r3/07-31 morph). */}
            {chatAccess === "granted" && (!phone || !kbOpen) && (
              <DimeAvenueToggle
                value={avenue}
                onChange={setAvenue}
                className="dime-avenue-toggle--bar"
              />
            )}
            {/* Phones, keyboard up (owner directive 2026-07-31, supersedes the
                r2 empty-center rule for THIS state only): the wordmark fades
                in centered between the corner controls, riding the same
                --dc-kb-progress spring as the bar morph. Theme ink comes from
                the bar's own tokens; the coin-dot stays mint. Always mounted
                so the reveal/hide never re-layouts — visibility is pure
                compositor work (opacity/transform). */}
            {phone && (
              <span
                className="dc-mobile-title dc-kb-logo"
                aria-hidden={!kbOpen}
              >
                <span className="dime-wordmark" aria-label="dime">
                  d
                  <span className="dime-wordmark-i">
                    ı<span className="dime-coindot" />
                  </span>
                  me
                </span>
              </span>
            )}
            {/* Phone kebab (owner directive 2026-07-29 r3): chat options at
                the bar's right edge, opposite the history toggle — New chat,
                Star, Archive, and an inline Rename drill-in. Reuses the
                threadMenu state/outside-click wiring (the desktop kebab and
                this one never render together). */}
            {phone && chatAccess === "granted" && conversation ? (
              <div className="dc-mobile-kebab-wrap" ref={threadMenuRef}>
                <button
                  type="button"
                  className="dc-mobile-kebab dc-focusable dc-pressable"
                  aria-label="Chat options"
                  aria-haspopup="menu"
                  aria-expanded={threadMenuOpen}
                  onClick={() => setThreadMenuOpen(open => !open)}
                >
                  <Ellipsis size={20} strokeWidth={1.8} aria-hidden="true" />
                </button>
                {threadMenuOpen && (
                  <div className="dc-thread-menu" role="menu">
                    {renameDraft != null ? (
                      <form
                        className="dc-rename-form"
                        onSubmit={e => {
                          e.preventDefault();
                          commitRename();
                        }}
                      >
                        <input
                          className="dc-rename-input"
                          value={renameDraft}
                          onChange={e => setRenameDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Escape") setRenameDraft(null);
                          }}
                          aria-label="New chat name"
                          maxLength={80}
                          autoFocus
                        />
                        <button
                          type="submit"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                        >
                          Save
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                          onClick={() => {
                            setThreadMenuOpen(false);
                            newChat();
                          }}
                        >
                          New chat
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                          disabled={threadId == null}
                          onClick={toggleStar}
                        >
                          {activeThreadMeta?.starred ? "Unstar" : "Star"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                          disabled={threadId == null}
                          onClick={archiveThread}
                        >
                          Archive
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                          disabled={threadId == null}
                          onClick={() =>
                            setRenameDraft(activeThreadMeta?.title ?? "")
                          }
                        >
                          Rename
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <span className="dc-mobile-balance" aria-hidden="true" />
            )}
          </div>
        )}

        <DimeSidebar
          onNewChat={newChat}
          recentChats={recentChats}
          onOpenChat={openChat}
          onDeleteChat={deleteRecentChat}
          onClearAllChats={isOwner ? clearAllRecentChats : undefined}
          activeChatId={threadId}
          compact={compact}
          phone={phone}
          drawerOpen={drawerOpen}
          sidebarRef={sidebarRef}
          onClose={() => closeDrawer(true)}
          onNavigate={() => {
            if (compact) closeDrawer(true);
          }}
          activePane={shell?.navigationPane}
          onShellNavigate={shell?.onNavigate}
          appUser={appUser}
          isOwner={isOwner}
          onOpenSettings={() => {
            // [Round-3 hotfix 2026-07-22, live-test A5/A8] Below the 1024px
            // `compact` breakpoint the drawer <aside> is itself a second
            // aria-modal dialog (role/aria-modal wiring above) — opening
            // Settings on top of it used to leave BOTH mounted at once,
            // each with its own focus trap and Escape listener. Close the
            // drawer first; restoreFocus=false because the Settings dialog
            // is about to grab focus itself the instant it mounts, and
            // running the drawer's own delayed restore-on-settle focus()
            // after that would race it and steal focus back out of the
            // just-opened dialog.
            if (compact && drawerOpen) closeDrawer(false);
            setSettingsOpen(true);
          }}
        />

        {compact && drawerOpen && (
          <button
            ref={drawerScrimRef}
            type="button"
            className="dc-drawer-scrim"
            style={{ opacity: scrimOpacityFor(dragXRef.current) }}
            aria-label="Close navigation"
            tabIndex={-1}
            onPointerDown={() => closeDrawer(true)}
          />
        )}

        {compact && !drawerOpen && (
          <div
            className="dc-edge-capture"
            aria-hidden="true"
            onPointerDown={event => beginDrawerGesture(event, true)}
            onPointerMove={moveDrawerGesture}
            onPointerUp={endDrawerGesture}
            onPointerCancel={endDrawerGesture}
          />
        )}

        {compact && drawerOpen && (
          <div
            ref={drawerGrabRef}
            className="dc-drawer-grab"
            style={{ transform: `translateX(${dragXRef.current}px)` }}
            aria-hidden="true"
            onPointerDown={event => beginDrawerGesture(event, false)}
            onPointerMove={moveDrawerGesture}
            onPointerUp={endDrawerGesture}
            onPointerCancel={endDrawerGesture}
          />
        )}

        {(() => {
          const chatActive = !shell || shell.renderedPane === "chat";
          // [PR #70 REMEDIATION 2026-07-12] `chatPane`'s wrapping element
          // below used to fork by TYPE on `!shell` (bare <m.main> vs a
          // <div className="dc-shell-stack"> wrapping <m.main> + the
          // external pane). That fork is invisible to DimeAppShell's
          // caller, but NOT to React's reconciler: when the SAME mounted
          // DimeChatPage instance re-renders with `shell` flipping from a
          // value to undefined (DimeAppShell's `mode` crossing 768px),
          // the root element type this component returns changes —
          // forcing React to tear down and rebuild everything inside,
          // including the composer's DOM node, even though the
          // DimeChatPage component instance itself never unmounts. Fix:
          // always return the SAME wrapper type/position; only the
          // external pane's presence is conditional (a trailing sibling
          // gain/loss does not perturb an earlier sibling's identity).
          // `.dc-shell-stack`'s single-cell grid is already the
          // production-verified >=768px chat layout — applying it
          // unconditionally here is layout-neutral for a lone child, and
          // touches neither conversation.css nor the framer-motion API
          // surface, only which elements exist in the DOM.
          //
          // PR #70 bundle-budget remediation: the chat/external pane
          // cross-fade is now a CSS transition (shell.css's
          // `dc-shell-pane--inactive` modifier, 160ms brand curve) instead
          // of framer-motion's `animate` prop — `<m.main>`/`<m.section>`
          // become plain `<main>`/`<section>`.
          const chatPane = (
            <main
              ref={chatPaneRef}
              className={`dc-main${conversation ? " dc-main--conv" : ""} dc-shell-chat-layer${shell && !chatActive ? " dc-shell-pane--inactive" : ""}`}
              aria-hidden={shell && !chatActive ? true : undefined}
            >
              {shell && (
                <h1
                  ref={shell.chatHeadingRef}
                  className="dc-shell-sr-only"
                  tabIndex={-1}
                >
                  Dime Chat
                </h1>
              )}
              {/* Desktop avenue toggle (owner directive 2026-08-01): top
                  middle of the chat pane. Compact widths render it in the
                  mobile bar instead. */}
              {!compact && chatAccess === "granted" && (
                <div className="dc-avenue-bar">
                  <DimeAvenueToggle value={avenue} onChange={setAvenue} />
                </div>
              )}
              {chatAccess === "denied" && (
                // Non-owner state (plan Phase 2.1): wordmark + coming-soon
                // copy only. No hero, no composer, no pills. Sidebar/nav
                // stays fully usable around it.
                <div className="dc-coming-soon" role="status">
                  <img
                    className="dc-coming-soon-mark"
                    src={`/brand/dime-wordmark-on-${theme}.svg`}
                    alt="Dime"
                  />
                  <div className="dc-coming-soon-copy">
                    AI MODEL CHAT COMING SOON
                  </div>
                </div>
              )}
              {/* Thread kebab is tablet/desktop chrome (owner directive
                  2026-07-29): phones drop it — per-chat Delete stays reachable
                  through the drawer's recent-row Ellipsis menu. */}
              {chatAccess === "granted" &&
                conversation &&
                threadId != null &&
                !phone && (
                  <div className="dc-thread-actions" ref={threadMenuRef}>
                    <button
                      type="button"
                      className="dc-thread-menu-trigger dc-focusable dc-pressable"
                      aria-label="Chat settings"
                      aria-haspopup="menu"
                      aria-expanded={threadMenuOpen}
                      onClick={() => setThreadMenuOpen(open => !open)}
                    >
                      ⋯
                    </button>
                    {threadMenuOpen && (
                      <div className="dc-thread-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                          onClick={toggleStar}
                        >
                          {activeThreadMeta?.starred ? "Unstar" : "Star"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-focusable dc-pressable"
                          onClick={archiveThread}
                        >
                          Archive
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="dc-thread-menu-item dc-thread-menu-item--danger dc-focusable dc-pressable"
                          onClick={deleteThread}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                )}
              {chatAccess === "granted" && conversation && (
                <div
                  className="dc-scroller"
                  ref={scrollerRef}
                  onScroll={onScroll}
                >
                  <div
                    className="dc-thread"
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                    aria-atomic="false"
                    aria-label="Dime chat conversation"
                  >
                    {state.messages.map(m => (
                      <Turn
                        key={m.id}
                        msg={m}
                        freshness={state.dataFreshness}
                        fx={firstSendFx}
                      />
                    ))}
                    {state.error && (
                      <ErrorCard message={state.error} onRetry={retry} />
                    )}
                  </div>
                </div>
              )}
              {chatAccess === "granted" && !conversation && (
                <BrandHero innerRef={heroRef} />
              )}
              {chatAccess === "granted" && (
                <div className="dc-composer-zone">
                  {conversation && !stuck && state.streaming && (
                    <button
                      type="button"
                      className="dc-btn-cancel dc-hv2 dc-focusable dc-pressable dc-jump"
                      onClick={jumpToLatest}
                    >
                      Jump to latest
                    </button>
                  )}
                  <form
                    className="dc-composer"
                    ref={composerRef}
                    onSubmit={onSubmit}
                  >
                    <div className="dc-composer-plus">＋</div>
                    <input
                      className="dc-composer-input"
                      type="text"
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      placeholder={
                        conversation ? "Reply to dime…" : "Ask dime anything…"
                      }
                      enterKeyHint="send"
                    />
                    {state.streaming ? (
                      <button
                        type="button"
                        className="dc-send dc-hv3 dc-focusable dc-pressable"
                        aria-label="Stop response"
                        onClick={stop}
                      >
                        <StopGlyph />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        className="dc-send dc-hv3 dc-focusable dc-pressable"
                        aria-label="Submit prompt"
                      >
                        <SendGlyph />
                      </button>
                    )}
                  </form>
                </div>
              )}
              {chatAccess === "granted" && (
                <footer
                  className="dc-chat-footer"
                  aria-label="Responsible gaming notice"
                >
                  {DISCLAIMER}
                </footer>
              )}
              {chatAccess === "granted" && ghost && (
                <div aria-hidden="true">
                  <div
                    className={`dc-ghost${ghost.fading ? " dc-ghost--fading" : ""}`}
                    style={rectStyle(ghost.hero)}
                  >
                    <BrandHero />
                  </div>
                </div>
              )}
            </main>
          );

          const externalActive = !!shell && shell.renderedPane !== "chat";
          return (
            <div
              ref={mainRef as MutableRefObject<HTMLDivElement | null>}
              className="dc-shell-stack"
            >
              {chatPane}
              {shell && (
                <section
                  ref={externalPaneRef}
                  className={`dc-shell-external-layer${!externalActive ? " dc-shell-pane--inactive" : ""}`}
                  aria-hidden={!externalActive}
                >
                  <div
                    ref={shell.externalScrollRef}
                    className="dc-shell-external-scroll"
                    onScroll={shell.onExternalScroll}
                  >
                    <h1
                      ref={shell.externalHeadingRef}
                      className="dc-shell-sr-only"
                      tabIndex={-1}
                    >
                      {shell.paneHeading}
                    </h1>
                    {shell.paneContent}
                  </div>
                </section>
              )}
            </div>
          );
        })()}

        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          appUser={appUser}
          isOwner={isOwner}
          sidebarRef={sidebarRef}
          mobileMenuRef={menuButtonRef}
        />
      </div>
    </div>
  );
}
