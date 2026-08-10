#!/usr/bin/env bash
# Rehydrate gstack (garrytan/gstack) into the user's ~/.claude/skills.
#
# gstack installs at USER scope, not project scope -- ./setup symlinks each
# sub-skill into ~/.claude/skills/. Nothing in this repo can carry it, so a
# teammate cloning dime-ai gets the CLAUDE.md "gstack" section describing skills
# they do not have. This hook closes that gap on the next session start.
#
# Idempotent and cheap: a healthy machine early-exits in milliseconds. A cold
# machine clones + builds once (~1-2 min), then never again.
#
# NAMING INVARIANT (why --prefix). gstack installs at user scope and this repo
# owns two of the same names: `ship` (.claude/commands/ship.md, the Railway
# release pipeline) and `retro` (.claude/skills/retro/, the phuryn PM retro).
# Claude Code resolves same-named skills to ONE winner and does not honour a
# project-beats-user rule -- a fresh session was observed resolving `retro` to
# gstack's. gstack's only supported de-collision knob is all-or-nothing prefixing
# (setup:552 applies SKILL_PREFIX uniformly; there is no per-skill allowlist), so
# this hook pins --prefix: every gstack skill installs as /gstack-<name> on this
# machine, and /ship + /retro stay unambiguously Dime's. setup persists the
# choice via `gstack-config set skill_prefix true` (setup:180), so later bare
# `./setup` runs and /gstack-upgrade (stash -> reset --hard -> re-setup) stay in
# prefixed mode.
#
# The invariant has TWO halves and health checks both: (A) the discovery path is
# prefixed (~/.claude/skills/gstack-browse resolving into the checkout), and
# (B) the skill frontmatter identity is prefixed (`name: gstack-browse`). Half A
# can hold while half B has been normalized away -- see is_healthy below.
#
# DEGRADED STATE + BOUNDED REPAIR. setup persists skill_prefix at setup:180 but
# does not create the skill links until setup:994, and it deletes the old flat
# links at setup:987 -- i.e. ~800 lines earlier it has already recorded "we are
# prefixed". An interrupted setup therefore lands a machine with
# skill_prefix=true and NO gstack skills at all. Trusting the config alone would
# call that healthy; refusing to act on it (the previous storm guard) left it
# broken forever. So health is judged on the observable surface, and a broken
# prefixed install gets ONE setup attempt per cooldown window, guarded by a lock
# so concurrent Claude sessions cannot both run setup. A failed attempt is
# recorded and reported as "gstack DEGRADED:", never allowed to block startup,
# and retried once the cooldown expires or gstack itself changes.
#
# It deliberately does NOT `git pull` an existing checkout -- silently advancing
# a third-party dependency on every session start is a supply-chain surprise.
# Use /gstack-upgrade (or `cd ~/.claude/skills/gstack && git pull && ./setup`).
#
# Opt out with DIME_SKIP_GSTACK=1.

set -uo pipefail

# Resolve the repo root from THIS script's location, never from $PWD -- hooks do
# not necessarily run from the repo root. Never exit 2: SessionStart treats that
# as a blocking error, and a missing skill pack must not block a session.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1

GSTACK_URL="https://github.com/garrytan/gstack.git"
GSTACK_DIR="${HOME}/.claude/skills/gstack"
BROWSE_BIN="${GSTACK_DIR}/browse/dist/browse"
GSTACK_CONFIG="${GSTACK_DIR}/bin/gstack-config"
# The canonical discovery probe: the PREFIXED skill directory Claude Code
# actually reads. Probing the real surface (not a proxy for it) is what makes a
# flat-mode or half-installed machine fail the check and get reconciled.
LINKED_PROBE="${HOME}/.claude/skills/gstack-browse/SKILL.md"
LOG="${TMPDIR:-/tmp}/dime-bootstrap-gstack.log"

# Bounded-repair state, following gstack's own ~/.gstack convention of
# dot-prefixed plain-text state files (cf. .last-setup-version, setup:1227).
# Never inside the repo: this is per-machine state, not project state.
REPAIR_STATE="${HOME}/.gstack/.dime-gstack-repair"
REPAIR_LOCK="${HOME}/.gstack/.dime-gstack-repair.lock"
# Overridable so the sandbox suite can exercise expiry deterministically.
COOLDOWN_SECS="${DIME_GSTACK_REPAIR_COOLDOWN:-21600}" # 6h
LOCK_STALE_SECS="${DIME_GSTACK_LOCK_STALE:-1800}"     # 30m

if [ "${DIME_SKIP_GSTACK:-0}" = "1" ]; then
  echo "gstack: skipped (DIME_SKIP_GSTACK=1)"
  exit 0
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
gstack_version() { cat "${GSTACK_DIR}/VERSION" 2>/dev/null || echo unknown; }

_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

# The probe must BE the checkout's own browse/SKILL.md, not merely something
# named like it. -ef compares device+inode through the symlink, so this is immune
# to path spelling (trailing/double slashes, /private/var vs /var, a symlinked
# HOME) -- string-prefix matching on readlink output is not, and a false negative
# here would report DEGRADED on a perfectly healthy machine. A dangling symlink
# fails -ef, which is the answer we want. Windows copy-mode installs have a real
# file with its own inode; accept that.
probe_resolves_into_checkout() {
  if [ -L "$LINKED_PROBE" ]; then
    [ "$LINKED_PROBE" -ef "${GSTACK_DIR}/browse/SKILL.md" ]
    return
  fi
  [ -f "$LINKED_PROBE" ]
}

# Healthy == every invariant that makes /gstack-* actually work AND keep working.
# Ordered cheapest-first; the two subprocess checks (grep, config read) go last.
is_healthy() {
  [ -e "$LINKED_PROBE" ] || return 1
  [ -x "$BROWSE_BIN" ] || return 1
  [ -s "${GSTACK_DIR}/VERSION" ] || return 1
  [ -d "${GSTACK_DIR}/.git" ] || return 1
  probe_resolves_into_checkout || return 1
  # The DISCOVERY PATH being prefixed is only half the naming invariant; the
  # SKILL FRONTMATTER has to agree. Claude Code reads the `name:` field, and
  # setup names the links FROM that field (it patches names at setup:993,
  # deliberately "BEFORE creating symlinks so link_claude_skill_dirs reads the
  # correct (patched) name: values"). A normalized checkout -- `git checkout .`,
  # `git stash`, or the `git reset --hard` inside /gstack-upgrade -- reverts
  # those 52 fields to flat names while skill_prefix stays true and every
  # symlink stays in place, so every other check above still passes and
  # `ship`/`retro` silently collide again. gstack itself warns about exactly
  # this ("Note: skill_prefix is true. Run gstack-relink to re-apply name:
  # patches.") but nothing re-checks it, so we do.
  #
  # Tolerance deliberately mirrors gstack's own canonical read: gstack-patch-
  # names:17 strips the whitespace after the colon before comparing, and :21
  # then SKIPS any value already matching `gstack-*`. So a spelling gstack
  # considers correctly-prefixed must pass here too -- otherwise repair could
  # never converge (setup would decline to re-patch and we would loop to
  # DEGRADED forever). The value itself is pinned exactly: `browse`,
  # `gstack-browse-extra` and `GSTACK-BROWSE` all fail.
  #
  # browse/SKILL.md is the canary rather than all 52: it is the same file the
  # inode probe above already binds, patch-names patches every skill in one
  # loop, and one grep keeps the healthy path at a single extra process.
  grep -qE '^name:[[:space:]]*gstack-browse[[:space:]]*$' \
    "${GSTACK_DIR}/browse/SKILL.md" 2>/dev/null || return 1
  # skill_prefix=true is part of health, not decoration: without it the next
  # bare `./setup` (e.g. via /gstack-upgrade) would revert this machine to flat
  # names and hand /ship and /retro back to gstack.
  [ -x "$GSTACK_CONFIG" ] || return 1
  [ "$("$GSTACK_CONFIG" get skill_prefix 2>/dev/null || true)" = "true" ]
}

# Fingerprint of the thing we are trying to repair. If gstack itself moves, the
# previous failure tells us nothing, so a changed fingerprint re-opens retry
# immediately rather than waiting out the cooldown.
repair_fingerprint() {
  printf '%s@%s' "$(gstack_version)" \
    "$(git -C "$GSTACK_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)"
}

# State file format, one line: "<epoch> <fingerprint>"
retry_eligible() {
  [ -f "$REPAIR_STATE" ] || return 0 # never failed here before
  local ts fp now
  ts="$(cut -d' ' -f1 <"$REPAIR_STATE" 2>/dev/null)"
  fp="$(cut -d' ' -f2 <"$REPAIR_STATE" 2>/dev/null)"
  case "$ts" in '' | *[!0-9]*) return 0 ;; esac # unreadable -> do not wedge
  [ "$fp" = "$(repair_fingerprint)" ] || return 0
  now="$(date +%s)"
  [ "$((now - ts))" -ge "$COOLDOWN_SECS" ]
}

record_failure() {
  local tmp
  mkdir -p "$(dirname "$REPAIR_STATE")" 2>/dev/null
  tmp="${REPAIR_STATE}.$$"
  # Write-then-rename: a concurrent reader sees either the old line or the new
  # one, never a torn write.
  printf '%s %s\n' "$(date +%s)" "$(repair_fingerprint)" >"$tmp" 2>/dev/null &&
    mv -f "$tmp" "$REPAIR_STATE" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
}

clear_failure() { rm -f "$REPAIR_STATE" 2>/dev/null; }

# mkdir is atomic on POSIX, so it is the whole lock. A session that loses the
# race never waits -- it reports and exits, because a hook must not stall
# startup. A lock left behind by a killed session goes stale and is reclaimed.
LOCK_HELD=0
acquire_lock() {
  mkdir -p "$(dirname "$REPAIR_LOCK")" 2>/dev/null
  if mkdir "$REPAIR_LOCK" 2>/dev/null; then LOCK_HELD=1; return 0; fi
  local lts now
  lts="$(_mtime "$REPAIR_LOCK")"
  now="$(date +%s)"
  case "$lts" in '' | *[!0-9]*) return 1 ;; esac
  if [ "$((now - lts))" -ge "$LOCK_STALE_SECS" ]; then
    rmdir "$REPAIR_LOCK" 2>/dev/null
    if mkdir "$REPAIR_LOCK" 2>/dev/null; then LOCK_HELD=1; return 0; fi
  fi
  return 1
}
# shellcheck disable=SC2329  # invoked indirectly by the EXIT trap below
release_lock() { [ "$LOCK_HELD" = 1 ] && rmdir "$REPAIR_LOCK" 2>/dev/null; }
trap release_lock EXIT

# ── Fast path ────────────────────────────────────────────────────────────────
if is_healthy; then
  echo "gstack OK ($(gstack_version))"
  exit 0
fi

# ── Prerequisites ────────────────────────────────────────────────────────────
# Missing prerequisites are a normal state on a fresh machine, not an error.
# Report on stdout (SessionStart feeds stdout into session context, so the
# message is actually seen) and exit 0 so the session is never wedged.
if ! command -v git >/dev/null 2>&1; then
  echo "gstack: not installed -- git is unavailable. See the gstack section of CLAUDE.md."
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "gstack: not installed -- ./setup requires bun. Install it, then re-run:"
  echo "  brew install bun && ${REPO_ROOT}/.claude/scripts/bootstrap-gstack.sh"
  exit 0
fi

# ── Clone ────────────────────────────────────────────────────────────────────
if [ ! -e "$GSTACK_DIR" ]; then
  mkdir -p "$(dirname "$GSTACK_DIR")"
  if ! git clone --single-branch --depth 1 "$GSTACK_URL" "$GSTACK_DIR" >"$LOG" 2>&1; then
    echo "gstack: clone failed -- see $LOG"
    exit 1
  fi
elif [ ! -d "${GSTACK_DIR}/.git" ]; then
  # Something is already at that path and it is not our checkout. Never delete
  # it; a half-installed or hand-managed gstack is the user's to resolve.
  echo "gstack: ${GSTACK_DIR} exists but is not a git checkout -- leaving it alone."
  exit 0
fi

# ── Classify what we are about to do ─────────────────────────────────────────
# converge = flat (or freshly cloned) -> prefixed, the expected one-time move.
# repair   = config already claims prefixed but the surface is missing/broken.
MODE=converge
if [ -x "$GSTACK_CONFIG" ] &&
  [ "$("$GSTACK_CONFIG" get skill_prefix 2>/dev/null || true)" = "true" ]; then
  MODE=repair
fi

# ── Retry bounding ───────────────────────────────────────────────────────────
# Applies to BOTH modes: a setup that keeps failing must not be re-run on every
# session, whichever state it is failing from.
if ! retry_eligible; then
  echo "gstack DEGRADED: the /gstack-* naming invariant is broken (discovery path or SKILL.md"
  echo "  name: field) and a previous ./setup --prefix failed."
  echo "  Retry is suppressed until the cooldown expires (${COOLDOWN_SECS}s) or gstack changes."
  echo "  Recover with: '${GSTACK_DIR}/setup' --prefix --no-plan-tune-hooks"
  echo "  State: ${REPAIR_STATE} (delete it to retry on the next session)"
  exit 0
fi

if ! acquire_lock; then
  echo "gstack: a repair is already in progress in another session -- skipping this one."
  exit 0
fi

# ── Build + link (also the flat -> prefixed reconciliation and the repair) ───
# Flags pin the install to what the CLAUDE.md gstack section documents:
#   --prefix              namespaced skill names (/gstack-browse, /gstack-qa), so
#                         /ship and /retro stay Dime's -- see NAMING INVARIANT
#   --no-plan-tune-hooks  do not write plan-tune hooks into the user's settings
# GSTACK_SKIP_COREUTILS=1 keeps an unattended hook from brew-installing packages
# on someone's machine; re-run ./setup by hand for /gstack-codex hang protection.
# On a machine already in flat mode this is the convergence step: setup's
# cleanup_old_claude_symlinks (setup:987) removes the flat entries it owns before
# linking the prefixed ones (setup:994). The browse binary is only rebuilt when
# package.json or bun.lock is newer than it (setup:383), so reconciling or
# repairing a warm checkout is a relink, not a 61MB rebuild.
GSTACK_SKIP_COREUTILS=1 \
  "${GSTACK_DIR}/setup" --prefix --no-plan-tune-hooks >"$LOG" 2>&1
SETUP_RC=$?

if [ "$SETUP_RC" -eq 0 ] && is_healthy; then
  clear_failure
  if [ "$MODE" = repair ]; then
    echo "gstack repaired ($(gstack_version)) -- /gstack-browse restored, see CLAUDE.md"
  else
    echo "gstack installed ($(gstack_version)) -- /gstack-browse is the browsing path, see CLAUDE.md"
  fi
  exit 0
fi

# Failed. Record it so the next session does not immediately pay for setup
# again, say exactly what broke, and still let the session start.
record_failure
if [ "$SETUP_RC" -ne 0 ]; then
  echo "gstack DEGRADED: ./setup --prefix failed (exit ${SETUP_RC}) -- see $LOG"
else
  echo "gstack DEGRADED: ./setup --prefix succeeded but the /gstack-* naming invariant is still"
  echo "  broken (discovery path or SKILL.md name: field) -- see $LOG"
fi
echo "  gstack skills are unavailable or unprefixed; /ship and /retro remain Dime's."
echo "  Recover with: '${GSTACK_DIR}/setup' --prefix --no-plan-tune-hooks"
echo "  Retry is suppressed for ${COOLDOWN_SECS}s (state: ${REPAIR_STATE})"
exit 0
