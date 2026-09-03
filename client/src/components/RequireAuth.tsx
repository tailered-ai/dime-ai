/**
 * RequireAuth — Authentication gate component
 *
 * Wraps any route that requires a valid app_session cookie.
 * Unauthenticated users are redirected to /login BEFORE any child content renders.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  RequireAuth returns null while appUsers.me is in flight.               │
 * │  The HTML loading shell in index.html covers this gap — it stays        │
 * │  visible until React renders real content into #root.                   │
 * │                                                                         │
 * │  Once resolved:                                                         │
 * │    • appUser present  → render children (protected page)                │
 * │    • appUser null     → hard redirect to /login?returnPath=<current>    │
 * │                                                                         │
 * │  Hard redirect (window.location.href) is used instead of wouter        │
 * │  setLocation to ensure React Query cache is fully cleared on the        │
 * │  login page load. This prevents stale auth state from persisting.       │
 * │                                                                         │
 * │  A 10-second timeout prevents infinite loading if the auth check stalls.│
 * │                                                                         │
 * │  A 300ms minimum wait prevents a redirect race condition after OAuth    │
 * │  callback — the browser navigates to /feed before appUsers.me resolves. │
 * │  300ms is sufficient: auth API resolves in ~100-200ms on good networks. │
 * │                                                                         │
 * │  [PERF] No inline loading state — the HTML shell covers auth wait.      │
 * │  This eliminates the double loading screen (HTML shell → React spinner).│
 * │                                                                         │
 * │  [PERF] URL-aware feed data prefetch — fires the moment auth resolves.  │
 * │  Parses the canonical /feed/model/{sport}-{date} slug so the prefetched │
 * │  cache key EXACTLY matches what DimeModelFeed requests on mount.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   <Route path="/feed/model/:sport">
 *     {(p) => <RequireAuth><DimeModelFeed sport={p.sport} /></RequireAuth>}
 *   </Route>
 */

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAppAuth } from "@/_core/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { todayUTC } from "@/components/CalendarPicker";

interface RequireAuthProps {
  children: React.ReactNode;
}

// Feed data prefetch — fires once when auth resolves on the canonical feed
// surface (/feed/model/{mlb|wc}-MM-DD-YYYY). Populates the React Query cache
// so DimeModelFeed renders with data immediately.
//
// [NAV RECONSTRUCTION 2026-07-11] Rewritten for the canonical path-based URLs.
// The legacy /feed?sport=&date= query hooks are eradicated — the sport and
// date are parsed from the path slug so the prefetched cache key EXACTLY
// matches what useFeedCards requests on mount ({sport,"gameDate"} for MLB,
// {date} for WC — see DimeModelFeed useFeedCards).
function useFeedPrefetch(authenticated: boolean) {
  const utils = trpc.useUtils();
  const prefetchedRef = useRef(false);

  useEffect(() => {
    if (!authenticated || prefetchedRef.current) return;
    const pathname = window.location.pathname;
    // Only prefetch on the canonical feed surface — other routes don't need feed data
    if (!pathname.startsWith("/feed/model")) return;

    prefetchedRef.current = true;

    // Parse the canonical date-only slug plus legacy sport-prefixed forms.
    const seg = pathname.split("/").filter(Boolean); // ["feed","model","mlb-07-11-2026"(,"07-11-2026")]
    let sport = (seg[2] ?? "").toLowerCase();
    let slugDate = seg[3] ?? "";
    if (!slugDate && /^\d{2}-\d{2}-\d{4}$/.test(sport)) {
      slugDate = sport;
      sport = "mlb";
    }
    const combined = /^(mlb|wc|ncaaf)-(\d{2}-\d{2}-\d{4})$/.exec(sport);
    if (combined) {
      sport = combined[1];
      slugDate = combined[2];
    }
    const dm = /^(\d{2})-(\d{2})-(\d{4})$/.exec(slugDate);
    const gameDate = dm ? `${dm[3]}-${dm[1]}-${dm[2]}` : todayUTC();

    if (sport === "wc") {
      void utils.wc2026.matchesByDate.prefetch(
        { date: gameDate },
        { staleTime: 60 * 1000 }
      );
    } else {
      void utils.games.list.prefetch(
        { sport: "MLB", gameDate },
        { staleTime: 60 * 1000 }
      );
    }
  }, [authenticated, utils]);
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { appUser, loading } = useAppAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  // Safety timeout: if auth check takes > 10s, treat as unauthenticated
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => {
      console.warn(
        "[RequireAuth] Auth check timed out after 10s — redirecting to login"
      );
      setTimedOut(true);
    }, 10000);
    return () => clearTimeout(t);
  }, [loading]);

  // Minimum wait (300ms) before redirecting — prevents race condition on OAuth callback.
  // After Discord OAuth callback, browser does full page nav to /feed.
  // React Query fires appUsers.me immediately but response takes ~100-200ms.
  // Without this guard, RequireAuth could redirect to /login before auth check completes.
  // [PERF] Reduced from 800ms → 300ms: auth resolves in ~100-200ms on good networks.
  // The HTML loading shell covers this 300ms gap seamlessly.
  const [minWaitDone, setMinWaitDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinWaitDone(true), 300);
    return () => clearTimeout(t);
  }, []);

  // [PERF] Prefetch feed data the moment auth resolves — eliminates in-page spinner
  useFeedPrefetch(Boolean(appUser));

  // Redirect unauthenticated users to /login with returnPath preserved
  useEffect(() => {
    if (loading && !timedOut) return; // still loading — wait
    if (!minWaitDone && !timedOut) return; // minimum wait not done — hold
    if (appUser) return; // authenticated — render children

    // [ACTION] Not authenticated — redirect to login
    const returnPath = window.location.pathname + window.location.search;
    const loginUrl =
      returnPath === "/login" || returnPath === "/"
        ? "/login"
        : `/login?returnPath=${encodeURIComponent(returnPath)}`;

    console.log(
      `[RequireAuth] Unauthenticated — redirecting to ${loginUrl} (timedOut=${timedOut} minWaitDone=${minWaitDone})`
    );
    // Client-side navigation instead of a full document reload (audit
    // D-REQAUTH: the reload produced shell → reload → second shell, with one
    // observed 15s hang). The reload's documented purpose was clearing stale
    // React Query auth state — queryClient.clear() achieves that without
    // tearing down the document.
    queryClient.clear();
    navigate(loginUrl, { replace: true });
  }, [appUser, loading, timedOut, minWaitDone, navigate, queryClient]);

  // [PERF] No inline loading state — return null so the HTML shell covers the auth wait.
  // The HTML shell (index.html) is visible until React renders real content into #root.
  // Returning null here means the HTML shell stays up during the auth check, then
  // disappears the moment the authenticated page renders. Zero double loading screen.
  if ((loading || !minWaitDone) && !timedOut) {
    return null;
  }

  // Authenticated — render the protected page
  if (appUser) {
    return <>{children}</>;
  }

  // Redirect is in progress — render nothing
  return null;
}
