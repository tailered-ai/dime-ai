import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { parseInviteCode } from "@shared/inviteCode";
import { lazy, Suspense, useEffect } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { RequireAuth } from "./components/RequireAuth";
import { RequireOwner } from "./components/RequireOwner";
import { ThemeProvider } from "./contexts/ThemeContext";
import { useAppAuth } from "./_core/hooks/useAppAuth";
// [PERF/FIX] The landing page is EAGER (not lazy) — it's the first thing unauthenticated
// users see. Making it lazy would add a Suspense gap (fallback=null → #root empty) while
// the chunk downloads, which keeps the HTML loading shell visible. Eager import =
// synchronous render on first paint.
// [SWAP 2026-07-09] "/" now renders Dime landing v2 (spec:
// docs/superpowers/specs/2026-07-08-dime-landing-v2-design.md — this is the approved
// route-swap step). The legacy LandingPage import is gone; v1 remains at /landingpage.
import DimeLandingV2 from "./pages/dime/landing/DimeLandingV2";
// [PERF] NotFound is lazy: it imports ui/button + ui/card which share clsx with recharts.
// Making it lazy removes recharts (409KB) from the critical path.
const NotFound = lazy(() => import("@/pages/NotFound"));
// ── ALL routes are lazy-loaded — zero page code in the initial bundle ────────
// [NAV RECONSTRUCTION 2026-07-11] The legacy query-tab feed page and the old
// public splits page are unrouted — their slugs permanently redirect to the
// canonical surfaces (docs/plans/2026-07-11-navigation-reconstruction.md):
//   /feed/model/{mlb|wc}-MM-DD-YYYY (DimeModelFeed) · /betting-splits/:sport
const DimeModelFeed = lazy(() => import("./pages/DimeModelFeed"));
const BettingSplits = lazy(() => import("./pages/BettingSplits"));
const Home = lazy(() => import("./pages/Home"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const UserManagement = lazy(() => import("./pages/UserManagement"));
const PublishProjections = lazy(() => import("./pages/PublishProjections"));
const UserActivity = lazy(() => import("./pages/UserActivity"));
const SubscriptionPlans = lazy(() => import("./pages/admin/SubscriptionPlans"));
const IngestAnOdds = lazy(() => import("./pages/IngestAnOdds"));
const TheModelResults = lazy(() => import("./pages/TheModelResults"));
const SecurityEvents = lazy(() => import("./pages/SecurityEvents"));
const MlbTeamSchedule = lazy(() => import("./pages/MlbTeamSchedule"));
const NbaTeamSchedule = lazy(() => import("./pages/NbaTeamSchedule"));
const NhlTeamSchedule = lazy(() => import("./pages/NhlTeamSchedule"));
const BetTracker = lazy(() => import("@/pages/BetTracker"));
const AdminModelStatus = lazy(() => import("@/pages/AdminModelStatus"));
const PostponedGames = lazy(() => import("@/pages/PostponedGames"));
const MlbBacktest = lazy(() => import("@/pages/MlbBacktest"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));

const SubscribeSuccess = lazy(() => import("./pages/SubscribeSuccess"));
const SubscribeCancel = lazy(() => import("./pages/SubscribeCancel"));
const ManageAccount = lazy(() => import("./pages/ManageAccount"));
const WorldCup2026 = lazy(() => import("./pages/WorldCup2026"));
const ClaudeAssistant = lazy(() => import("./pages/ClaudeAssistant"));
const DimeAppShell = lazy(() => import("./pages/dime-shell/DimeAppShell"));
const CheckoutPage = lazy(() => import("./pages/dime/CheckoutPage"));
const Profile = lazy(() => import("./pages/Profile"));
const WaitlistAdmin = lazy(() => import("./pages/WaitlistAdmin"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));

// ── Mobile /m/* screens (all authenticated users) ───────────────────────────
const MobileNavLayout = lazy(
  () => import("./features/mobileNav/MobileNavLayout")
);
import { GlobalMobileNav } from "./features/mobileNav/GlobalMobileNav";
import {
  feedModelPath,
  bettingSplitsPath,
  canonicalBettingSplitsPath,
  legacyFeedRedirectTarget,
  parseBettingSplitsPath,
} from "@/lib/feedRoutes";
import {
  isChatLocation,
  isDimeProductLocation,
} from "./pages/dime-shell/productRoute";
import { useDimeShellViewport } from "./pages/dime-shell/useDimeShellViewport";
import { allowsLocalDimePreview } from "./pages/dime-shell/previewGate";
import type { SplitsDateSource } from "./pages/dime-shell/splitsDateState";

/**
 * RootRoute — auth-aware landing/redirect component for the "/" path.
 *
 * Execution flow (OPTIMISTIC RENDER — zero loading shell on landing page):
 *   1. IMMEDIATE: Render <LandingPage /> without waiting for auth.
 *      The landing page is public — there is no reason to gate it behind an auth check.
 *      This eliminates the loading shell entirely for unauthenticated users.
 *   2. Auth resolves as authenticated → redirect to the canonical feed
 *      (/feed/model/mlb-MM-DD-YYYY — imperceptible for logged-in users).
 *   3. Auth resolves as unauthenticated → LandingPage stays visible (already rendered).
 *
 * [FIX] Optimistic render pattern:
 *   OLD: loading=true → return null → shell visible for 200-800ms → auth resolves → LandingPage
 *   NEW: return LandingPage immediately → auth resolves → redirect if authenticated
 *   Result: Loading shell dismissed the moment React mounts (0ms after JS executes).
 *
 * [FIX] Uses useAppAuth (Discord JWT) instead of useAuth (legacy OAuth) so that
 * Discord-logged-in users are correctly detected and redirected to the feed.
 *
 *
 * [LOG] All branches log their state to the console for traceability.
 */
function RootRoute() {
  const { appUser, loading } = useAppAuth();
  const [, navigate] = useLocation();

  // [CRITICAL FIX] Redirect authenticated users AFTER LandingPage is already rendered.
  // useEffect runs after paint — by then the shell is already dismissed.
  // This replaces the old "return null while loading" pattern that kept the shell visible.
  useEffect(() => {
    if (loading) {
      console.log(
        "[RootRoute] [STATE] Auth loading — LandingPage already visible, waiting for auth"
      );
      return;
    }
    if (appUser) {
      // (2026-07-24) The old sessionStorage.pendingCheckout auto-checkout
      // branch is gone: nothing ever wrote the key (audit S3-016) and its
      // only accepted values were the retired legacy plan ids.
      const target = feedModelPath("MLB");
      console.log(
        `[RootRoute] [OUTPUT] Authenticated userId=${appUser.id} — redirecting to ${target}`
      );
      // replace — otherwise Back lands on "/" which instantly re-pushes forward
      navigate(target, { replace: true });
    } else {
      console.log(
        "[RootRoute] [OUTPUT] Unauthenticated — LandingPage stays visible"
      );
    }
  }, [loading, appUser]);

  // [OPTIMISTIC] Always render the landing page immediately — no null return, no loading gap.
  // DimeLandingV2 is an eager import — no Suspense needed, renders synchronously.
  // The HTML loading shell dismisses the moment this component renders into #root.
  console.log(
    `[RootRoute] [RENDER] Rendering DimeLandingV2 immediately (loading=${loading}, authed=${!!appUser})`
  );
  return <DimeLandingV2 />;
}

function StandaloneSplitsRoute({
  sportSegment,
  dateSegment,
}: {
  sportSegment?: string;
  dateSegment?: string;
}) {
  const parsed = parseBettingSplitsPath(sportSegment, dateSegment);
  const canonical = canonicalBettingSplitsPath(sportSegment, dateSegment);

  if (!parsed?.isoDate || window.location.pathname !== canonical) {
    // The canonical redirect stamps a date onto every URL, which would make an
    // application-guessed date indistinguishable from a deliberate deep link.
    // Carry the provenance across the redirect on the history entry.
    return (
      <Redirect
        to={canonical}
        replace
        state={{
          splitsDateSource: parsed?.isoDate ? "url-explicit" : "app-default",
        }}
      />
    );
  }

  const redirectDateSource = (
    window.history.state as { splitsDateSource?: SplitsDateSource } | null
  )?.splitsDateSource;

  return (
    <RequireAuth>
      <BettingSplits
        initialSport={parsed.sport}
        initialDate={parsed.isoDate}
        initialDateSource={redirectDateSource ?? "url-explicit"}
      />
    </RequireAuth>
  );
}

function Router() {
  const [location] = useLocation();
  const shellViewport = useDimeShellViewport();
  // [FIX 2026-07-12] Chat needs ONE stable mounted owner at every viewport
  // width — an active SSE stream and the composer draft must survive a
  // resize, not just a navigation. Before this fix, /chat below 768px fell
  // through to the legacy <Switch> below and mounted a DIFFERENT lazy
  // component (the legacy pages/DimeChat.tsx shim, since deleted) than the
  // >=768px branch (DimeAppShell),
  // so crossing 768px swapped which component sat at this tree position and
  // React tore down and rebuilt DimeChatPage — destroying all conversation
  // state. Now /chat always takes this branch, and DimeAppShell's `mode`
  // prop (recomputed from shellViewport below) is the only thing that
  // changes across the boundary. Every other product surface (feed/splits/
  // tracker) keeps the original shellViewport-gated behavior.
  const chatShellOwnsRoute =
    isChatLocation(location) ||
    (shellViewport && isDimeProductLocation(location));
  const localPreview = allowsLocalDimePreview(
    window.location.search,
    import.meta.env.DEV
  );

  if (chatShellOwnsRoute) {
    const shellMode = shellViewport ? "shell" : "chat-only";
    return (
      <Suspense fallback={null}>
        {localPreview ? (
          <DimeAppShell mode={shellMode} previewMode />
        ) : (
          <RequireAuth>
            <DimeAppShell mode={shellMode} />
          </RequireAuth>
        )}
      </Suspense>
    );
  }

  return (
    // [PERF] fallback=null: the HTML loading shell in index.html covers all loading states.
    // It hides via MutationObserver the moment React renders ANY child into #root.
    // Using a React component as fallback causes a visual flash between the HTML shell
    // and the React component — two separate loading states visible to the user.
    // With null: HTML shell → direct render of real content. Zero flash.
    <Suspense fallback={null}>
      <Switch>
        {/* ── Public routes (no auth required) ───────────────────────────────── */}
        {/* / → auth-aware root:
           - Authenticated users → canonical feed (/feed/model/mlb-MM-DD-YYYY)
           - Unauthenticated users → LandingPage (public marketing page)
           - While auth is loading → render nothing (HTML shell covers this state)
      */}
        <Route path="/">{() => <RootRoute />}</Route>
        {/* /home → redirect to landing */}
        <Route path="/home">{() => <Redirect to="/" />}</Route>
        {/* ── Legacy slug eradication — permanent client-side redirects ─────────
          (server issues 308s for full-page loads; these cover SPA navigations).
          None of these slugs may be emitted by app code — see lib/feedRoutes. */}
        <Route path="/dashboard">
          {() => <Redirect to={feedModelPath("MLB")} replace />}
        </Route>
        <Route path="/projections">
          {() => <Redirect to={feedModelPath("MLB")} replace />}
        </Route>
        <Route path="/splits">
          {() => <Redirect to={bettingSplitsPath()} replace />}
        </Route>
        {/* Legal pages — public, no auth required */}
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        {/* Stripe checkout result pages — public, no auth required */}
        <Route path="/subscribe/success" component={SubscribeSuccess} />
        <Route path="/subscribe/cancel" component={SubscribeCancel} />
        {/* Login page — public, no auth required */}
        <Route path="/login" component={Home} />
        {/* Legacy standalone pricing page retired: it advertised the old $99/$499
          copy while its CTAs charged the legacy $99.99/$499.99 prices (live
          audit 2026-07-10). The v2 grid on the landing page is canonical. */}
        <Route path="/pricing">{() => <Redirect to="/#pricing" />}</Route>
        {/* Password reset — public, accessed via reset link */}
        <Route path="/reset-password">{() => <ResetPassword />}</Route>
        {/* Compact invite link — /invite/<uid base36>.<token> (shared/inviteCode.ts).
          Same single-use token + resetPassword consumer as /reset-password; the
          route itself implies the first-time "welcome" treatment. An unparseable
          code falls through with empty overrides, landing on the page's own
          invalid-link state. */}
        <Route path="/invite/:code">
          {params => {
            const parsed = parseInviteCode(params.code ?? "");
            return (
              <ResetPassword
                tokenOverride={parsed?.token ?? ""}
                uidOverride={parsed?.uid ?? 0}
                welcomeOverride
              />
            );
          }}
        </Route>
        {/* Dime AI landing v1 test hook retired — v2 shipped at the root, and the
          old page still marketed the de-marketed annual plan. */}
        <Route path="/landingpage">{() => <Redirect to="/" />}</Route>
        {/* Landing v2 is now the root landing page — redirect the old test route
          so existing links and the checkout back-links keep working. */}
        <Route path="/landingpage-v2">{() => <Redirect to="/" />}</Route>
        {/* In-domain Stripe checkout (Embedded Checkout w/ hosted fallback) */}
        <Route path="/checkout" component={CheckoutPage} />
        {/* ── Protected routes (RequireAuth redirects to /login if not authed) ── */}
        {/* Legacy /feed (+ ?tab=… query hooks) → canonical surfaces. tab=splits
          maps to /betting-splits/NCAAF; everything else to the dated feed URL. */}
        <Route path="/feed">
          {() => (
            <Redirect
              to={legacyFeedRedirectTarget(window.location.search)}
              replace
            />
          )}
        </Route>
        {/* Dime AI Model Projections — the canonical feed surface.
          /feed/model/mlb-07-11-2026 or /feed/model/wc-07-11-2026 (also the
          split form /feed/model/mlb/07-11-2026; bare /feed/model/mlb
          canonicalizes to today's dated URL inside DimeModelFeed). */}
        <Route path="/feed/model/:sport/:date">
          {p => (
            <RequireAuth>
              <DimeModelFeed sport={p.sport} date={p.date} />
            </RequireAuth>
          )}
        </Route>
        <Route path="/feed/model/:sport">
          {p => (
            <RequireAuth>
              <DimeModelFeed sport={p.sport} />
            </RequireAuth>
          )}
        </Route>
        {/* Betting splits — lowercase dated canonical URL; legacy forms replace. */}
        <Route path="/betting-splits/:sport/:date">
          {p => (
            <StandaloneSplitsRoute
              sportSegment={p.sport}
              dateSegment={p.date}
            />
          )}
        </Route>
        <Route path="/betting-splits/:sport">
          {p => <StandaloneSplitsRoute sportSegment={p.sport} />}
        </Route>
        <Route path="/betting-splits">
          {() => <Redirect to={bettingSplitsPath()} replace />}
        </Route>
        {/* /trends is a shell-owned (≥768px) surface. Below the shell
            boundary there is no Trends pane — the accordions still live on
            the splits cards — so land mobile visitors there. */}
        <Route path="/trends">
          {() => <Redirect to={bettingSplitsPath()} replace />}
        </Route>
        {/* Admin Dashboard — owner-only (@prez), owner directive 2026-07-22:
          "No other users or site members should be able to view these
          pages." RequireOwner is the client-side (cosmetic) half of the
          lockdown — it never flashes admin content and redirects any
          non-owner to /chat. The real boundary is server-verified
          ownerProcedure middleware on every procedure these pages call
          (see server/routers/appUsers.ts, routers.ts, wc2026Router.ts). */}
        <Route path="/admin">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <AdminDashboard />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>

        <Route path="/admin/users">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <UserManagement />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/publish">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <PublishProjections />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/activity">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <UserActivity />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/plans">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <SubscriptionPlans />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/ingest-an">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <IngestAnOdds />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/model-results">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <TheModelResults />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/f5-edge">
          {() => <Redirect to="/admin/model-results" />}
        </Route>
        <Route path="/admin/security">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <SecurityEvents />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/model-status">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <AdminModelStatus />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/postponed-games">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <PostponedGames />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        <Route path="/admin/backtest">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <MlbBacktest />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        {/* Waitlist management — owner-only, enforced inside WaitlistAdmin */}
        <Route path="/admin/waitlist">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <WaitlistAdmin />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        {/* Team schedules — params are read via useParams() inside each component */}
        <Route path="/mlb/team/:slug">
          {() => (
            <RequireAuth>
              <MlbTeamSchedule />
            </RequireAuth>
          )}
        </Route>
        <Route path="/nba/team/:slug">
          {() => (
            <RequireAuth>
              <NbaTeamSchedule />
            </RequireAuth>
          )}
        </Route>
        <Route path="/nhl/team/:slug">
          {() => (
            <RequireAuth>
              <NhlTeamSchedule />
            </RequireAuth>
          )}
        </Route>
        {/* User pages */}
        <Route path="/bet-tracker">
          {() => (
            <RequireAuth>
              <BetTracker />
            </RequireAuth>
          )}
        </Route>
        {/* Manage Account page */}
        <Route path="/account">
          {() => (
            <RequireAuth>
              <ManageAccount />
            </RequireAuth>
          )}
        </Route>
        {/* Claude UI/UX Assistant */}
        <Route path="/admin/claude">
          {() => (
            <RequireAuth>
              <RequireOwner>
                <ClaudeAssistant />
              </RequireOwner>
            </RequireAuth>
          )}
        </Route>
        {/* Profile page — identity and standing */}
        <Route path="/profile">
          {() => (
            <RequireAuth>
              <Profile />
            </RequireAuth>
          )}
        </Route>
        {/* Dime AI Chat — streaming Claude Fable 5 chat. NOT routed here: /chat
          is owned by the unified chatShellOwnsRoute branch above at every
          viewport width (see isChatLocation in dime-shell/productRoute.ts),
          so DimeChatPage keeps one stable mount across the 768px boundary.
          e2e/chat-resize.spec.ts covers the mount-stability contract. */}
        {/* FIFA World Cup 2026 — Group Stage Feed */}
        <Route path="/wc2026">
          {() => (
            <RequireAuth>
              <WorldCup2026 />
            </RequireAuth>
          )}
        </Route>
        {/* ── Mobile /m/* screens ─────────────────────────────────────────────── */}
        {/* Bare /m needs its own route — wouter's /m/:rest* requires ≥1 segment */}
        <Route path="/m">{() => <Redirect to="/m/feed" replace />}</Route>
        <Route path="/m/:rest*">
          {() => (
            <RequireAuth>
              <MobileNavLayout />
            </RequireAuth>
          )}
        </Route>
        {/* 404 */}
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark" switchable>
        <TooltipProvider>
          <Toaster />
          <Router />
          {/* Global mobile nav — appears on ALL pages for authenticated users on mobile */}
          <GlobalMobileNav />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
