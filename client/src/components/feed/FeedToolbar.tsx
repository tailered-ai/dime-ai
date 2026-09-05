import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { DayPicker } from "react-day-picker";
import {
  isValidFeedDate,
  shiftFeedDate,
  type FeedFilterOption,
  type FeedFilters,
} from "@/lib/feedNavigation";
import "./FeedToolbar.css";

export interface FeedToolbarProps {
  date: string;
  today: string;
  filters: FeedFilters;
  onFiltersChange: (filters: FeedFilters) => void;
  onDateChange: (date: string) => void;
  leagueOptions: FeedFilterOption[];
  conferenceOptions: FeedFilterOption[];
  gameOptions: FeedFilterOption[];
  loading?: boolean;
  visibleCount: number;
  totalCount: number;
}

const STATUS_OPTIONS = [
  { value: "scheduled", label: "Scheduled" },
  { value: "live", label: "Live" },
  { value: "final", label: "Final" },
  { value: "postponed", label: "Postponed" },
  { value: "suspended", label: "Suspended" },
];
const dateLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: FeedFilterOption[];
  allLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const choices = options.filter(option => option.value !== "all");
  return (
    <div className="feed-toolbar__field">
      <label htmlFor={id}>{label}</label>
      <div className="feed-toolbar__select-wrap">
        <select
          id={id}
          value={value}
          disabled={disabled || (!choices.length && value === "all")}
          onChange={event => onChange(event.target.value)}
        >
          <option value="all">{allLabel}</option>
          {value !== "all" &&
            !choices.some(option => option.value === value) && (
              <option value={value} disabled>
                Unavailable selection
              </option>
            )}
          {choices.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" size={16} />
      </div>
    </div>
  );
}

export function FeedToolbar({
  date,
  today,
  filters,
  onFiltersChange,
  onDateChange,
  leagueOptions,
  conferenceOptions,
  gameOptions,
  loading = false,
  visibleCount,
  totalCount,
}: FeedToolbarProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gameLabelId = useId();
  const gameValueId = useId();
  const gameSearchRef = useRef<HTMLInputElement>(null);
  const validDate = isValidFeedDate(date);
  const validToday = isValidFeedDate(today);
  const selectedDate = validDate ? new Date(`${date}T12:00:00Z`) : undefined;
  const todayDate = validToday ? new Date(`${today}T12:00:00Z`) : undefined;
  const games = gameOptions.filter(option => option.value !== "all");
  const selectedGame =
    filters.game === "all"
      ? "All games"
      : (games.find(option => option.value === filters.game)?.label ??
        "Unavailable selection");
  const previousDate =
    validDate && date > "0001-01-01" ? shiftFeedDate(date, -1) : undefined;
  const nextDate =
    validDate && date < "9999-12-31" ? shiftFeedDate(date, 1) : undefined;
  const changeFilter = (key: keyof FeedFilters, value: string) =>
    onFiltersChange({ ...filters, [key]: value });
  const chooseDate = (value: string) => {
    if (!isValidFeedDate(value)) return;
    onDateChange(value);
    setCalendarOpen(false);
  };

  return (
    <div
      className="feed-toolbar"
      ref={rootRef}
      role="region"
      aria-label="Feed controls"
    >
      <div className="feed-toolbar__primary">
        <div className="feed-toolbar__league">
          <FilterSelect
            label="Sport / league"
            allLabel="All sports"
            value={filters.league}
            options={leagueOptions}
            disabled={loading}
            onChange={value => changeFilter("league", value)}
          />
        </div>
        <div className="feed-toolbar__date" role="group" aria-label="Feed date">
          <button
            className="feed-toolbar__icon-button"
            type="button"
            aria-label="Previous day"
            disabled={loading || !previousDate}
            onClick={() => previousDate && chooseDate(previousDate)}
          >
            <ChevronLeft aria-hidden="true" size={18} />
          </button>
          <Popover.Root open={calendarOpen} onOpenChange={setCalendarOpen}>
            <Popover.Trigger asChild>
              <button
                className="feed-toolbar__date-trigger"
                type="button"
                disabled={loading || (!validDate && !validToday)}
                aria-label={`Choose date${selectedDate ? `, ${dateLabel.format(selectedDate)}` : ""}`}
              >
                <CalendarDays aria-hidden="true" size={18} />
                <span>
                  {selectedDate
                    ? dateLabel.format(selectedDate)
                    : "Choose date"}
                </span>
              </button>
            </Popover.Trigger>
            <Popover.Portal container={rootRef.current}>
              <Popover.Content
                className="feed-toolbar__popover feed-toolbar__calendar"
                sideOffset={8}
                collisionPadding={8}
                aria-label="Choose feed date"
                onOpenAutoFocus={event => event.preventDefault()}
              >
                <DayPicker
                  key={date}
                  mode="single"
                  required
                  timeZone="UTC"
                  autoFocus
                  disabled={loading}
                  disableNavigation={loading}
                  selected={selectedDate}
                  defaultMonth={selectedDate ?? todayDate}
                  today={todayDate}
                  startMonth={new Date("0001-01-01T12:00:00Z")}
                  endMonth={new Date("9999-12-31T12:00:00Z")}
                  onSelect={day => chooseDate(day.toISOString().slice(0, 10))}
                />
                <div className="feed-toolbar__calendar-footer">
                  <span>Dates shown in Eastern Time</span>
                  <button
                    type="button"
                    disabled={loading || !validToday}
                    onClick={() => chooseDate(today)}
                  >
                    Today
                  </button>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button
            className="feed-toolbar__icon-button"
            type="button"
            aria-label="Next day"
            disabled={loading || !nextDate}
            onClick={() => nextDate && chooseDate(nextDate)}
          >
            <ChevronRight aria-hidden="true" size={18} />
          </button>
        </div>
        <div className="feed-toolbar__summary">
          <button
            type="button"
            className="feed-toolbar__today"
            disabled={loading || !validToday || date === today}
            onClick={() => chooseDate(today)}
          >
            Today
          </button>
          <span
            className="feed-toolbar__count"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {loading
              ? "Loading games…"
              : `${visibleCount} of ${totalCount} ${totalCount === 1 ? "game" : "games"}`}
          </span>
        </div>
      </div>
      <div className="feed-toolbar__filters">
        <FilterSelect
          label="Status"
          allLabel="All statuses"
          value={filters.status}
          options={STATUS_OPTIONS}
          disabled={loading}
          onChange={value => changeFilter("status", value)}
        />
        <FilterSelect
          label="Conference"
          allLabel={
            conferenceOptions.some(option => option.value !== "all")
              ? "All conferences"
              : "No conferences"
          }
          value={filters.conference}
          options={conferenceOptions}
          disabled={loading}
          onChange={value => changeFilter("conference", value)}
        />
        <div className="feed-toolbar__field feed-toolbar__game">
          <span id={gameLabelId} className="feed-toolbar__label">
            Game
          </span>
          <Popover.Root open={gameOpen} onOpenChange={setGameOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="feed-toolbar__game-trigger"
                aria-labelledby={`${gameLabelId} ${gameValueId}`}
                disabled={loading || (!games.length && filters.game === "all")}
              >
                <span id={gameValueId}>
                  {!games.length && filters.game === "all"
                    ? "No games available"
                    : selectedGame}
                </span>
                <Search aria-hidden="true" size={16} />
              </button>
            </Popover.Trigger>
            <Popover.Portal container={rootRef.current}>
              <Popover.Content
                className="feed-toolbar__popover feed-toolbar__game-popover"
                sideOffset={8}
                collisionPadding={8}
                align="end"
                aria-label="Choose game"
                onOpenAutoFocus={event => {
                  event.preventDefault();
                  gameSearchRef.current?.focus();
                }}
              >
                <Command label="Search games" loop>
                  <div className="feed-toolbar__search">
                    <Search aria-hidden="true" size={16} />
                    <Command.Input
                      ref={gameSearchRef}
                      disabled={loading}
                      placeholder="Search teams or games…"
                    />
                  </div>
                  <Command.List label="Games">
                    <Command.Empty>No games match your search.</Command.Empty>
                    {[{ value: "all", label: "All games" }, ...games].map(
                      option => (
                        <Command.Item
                          key={option.value}
                          value={option.value}
                          keywords={[option.label]}
                          disabled={loading}
                          onSelect={() => {
                            changeFilter("game", option.value);
                            setGameOpen(false);
                          }}
                        >
                          <span>{option.label}</span>
                          {filters.game === option.value && (
                            <Check aria-hidden="true" size={16} />
                          )}
                        </Command.Item>
                      )
                    )}
                  </Command.List>
                </Command>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
    </div>
  );
}
