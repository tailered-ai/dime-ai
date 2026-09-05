import { useId, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MarketTable } from "./MarketTable";
import type { ProjectionGame, ProjectionMarket } from "./types";

export type MarketPaginationItem = number | "ellipsis-start" | "ellipsis-end";

/**
 * Keep small slates fully visible (MLB is always Run Line / Total / Moneyline)
 * while giving larger soccer slates a compact, reachable pagination window.
 */
export function marketPaginationItems(
  activePage: number,
  totalPages: number
): MarketPaginationItem[] {
  const total = Math.max(0, Math.floor(totalPages));
  if (total === 0) return [];
  if (total <= 4) return Array.from({ length: total }, (_, index) => index);

  const active = Math.min(Math.max(Math.floor(activePage), 0), total - 1);
  if (active <= 1) return [0, 1, 2, "ellipsis-end", total - 1];
  if (active >= total - 2) {
    return [0, "ellipsis-start", total - 3, total - 2, total - 1];
  }
  return [0, "ellipsis-start", active, "ellipsis-end", total - 1];
}

/**
 * Resolve the requested page against the complete source-ordered market list.
 * Keeping this rule separate makes the dynamic (non-MLB) slate contract
 * directly testable without duplicating the popover's selection behavior.
 */
export function projectionMarketPage(
  markets: ProjectionMarket[],
  requestedPage: number
): { activePage: number; activeMarket: ProjectionMarket | null } {
  const normalizedPage = Number.isFinite(requestedPage)
    ? Math.floor(requestedPage)
    : 0;
  const activePage = Math.min(
    Math.max(normalizedPage, 0),
    Math.max(markets.length - 1, 0)
  );

  return {
    activePage,
    activeMarket: markets[activePage] ?? null,
  };
}

export function ProjectionMarketsPopover({
  game,
  isPass,
  isUnplayable,
  defaultOpen = false,
  onOpen,
}: {
  game: ProjectionGame;
  /** No market cleared the threshold in a game that WILL be played. */
  isPass: boolean;
  /** Postponed or suspended — not available to act on, whatever the model
   *  found (owner directive 2026-08-06). Opposite meaning to isPass, same
   *  zero-mint treatment. The floating surface portals outside
   *  `.projection-card`, so this cannot be inherited by a descendant selector. */
  isUnplayable: boolean;
  defaultOpen?: boolean;
  onOpen?: () => void;
}) {
  const marketPanelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [requestedPage, setRequestedPage] = useState(0);
  const [open, setOpen] = useState(defaultOpen);
  const marketCount = game.markets.length;
  const { activePage, activeMarket } = projectionMarketPage(
    game.markets,
    requestedPage
  );

  if (!activeMarket) return null;

  const goToPage = (event: MouseEvent<HTMLAnchorElement>, nextPage: number) => {
    event.preventDefault();
    if (nextPage < 0 || nextPage >= marketCount) return;
    event.currentTarget.focus();
    setRequestedPage(nextPage);
  };

  const previousDisabled = activePage === 0;
  const nextDisabled = activePage === marketCount - 1;

  return (
    <div className="projection-card__markets">
      <Popover
        open={open}
        onOpenChange={open => {
          setOpen(open);
          if (!open) return;
          setRequestedPage(0);
          onOpen?.();
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="projection-card__markets-toggle ds-label"
          >
            <span>View full AI model projections</span>
            <ChevronDown
              className="projection-card__markets-icon"
              aria-hidden="true"
            />
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          className={`projection-card__markets-popover${isPass ? " projection-card__markets-popover--pass" : ""}${isUnplayable ? " projection-card__markets-popover--unplayable" : ""}`}
          aria-label={`${game.away.name} at ${game.home.name} model projections`}
          onCloseAutoFocus={event => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <header className="projection-card__markets-popover-head">
            <div>
              <p className="projection-card__markets-matchup">
                {game.away.name} @ {game.home.name}
              </p>
            </div>
            <button
              type="button"
              className="projection-card__markets-close"
              aria-label="Close full model projections"
              onClick={() => setOpen(false)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          <div
            id={marketPanelId}
            className="projection-card__market-page"
            role="region"
            aria-label={`${activeMarket.label} model projections`}
            aria-live="polite"
            aria-atomic="true"
          >
            <MarketTable market={activeMarket} />
          </div>

          {marketCount > 1 && (
            <Pagination
              className="projection-card__market-pagination"
              aria-label={`Model projection market pages for ${game.away.name} at ${game.home.name}`}
            >
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href={`#${marketPanelId}`}
                    className="projection-card__market-page-step"
                    aria-controls={marketPanelId}
                    aria-disabled={previousDisabled}
                    tabIndex={previousDisabled ? -1 : undefined}
                    onClick={event => goToPage(event, activePage - 1)}
                  />
                </PaginationItem>

                {marketPaginationItems(activePage, marketCount).map(item =>
                  typeof item === "number" ? (
                    <PaginationItem key={game.markets[item].key}>
                      <PaginationLink
                        href={`#${marketPanelId}`}
                        aria-controls={marketPanelId}
                        aria-label={`Show ${game.markets[item].label} projections, page ${item + 1} of ${marketCount}`}
                        isActive={item === activePage}
                        onClick={event => goToPage(event, item)}
                      >
                        {item + 1}
                      </PaginationLink>
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationEllipsis className="projection-card__market-page-ellipsis" />
                    </PaginationItem>
                  )
                )}

                <PaginationItem>
                  <PaginationNext
                    href={`#${marketPanelId}`}
                    className="projection-card__market-page-step"
                    aria-controls={marketPanelId}
                    aria-disabled={nextDisabled}
                    tabIndex={nextDisabled ? -1 : undefined}
                    onClick={event => goToPage(event, activePage + 1)}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
