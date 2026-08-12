# Freeze record — second window at FROZEN_BASE_SHA `249bf314c131e0f34aa0f1aae393411e4e8c8d55`

The first window (`FREEZE-43a33c84.md`) broke between the post-chain barrier
PASS and the acceptance-recording barrier: PRs #509/#510 merged, the barrier
refused acceptance, and DEF-056 was reopened. This record covers the second
window.

## Mechanism — unchanged

Coordinated human merge hold; ruleset 18701573 has zero bypass actors and
`allow_auto_merge=false`; nothing weakened, nothing modified, §30
restoration remains a no-op by construction.

## Window

| Event | Value |
| --- | --- |
| FROZEN_BASE_SHA pinned | `249bf314` (integration merge `61369e77`) |
| Remediations inside the window | `114052b3` (DEF-061), `77594d5a` (DEF-062) — verifier/test-quality only; no workflow, dependency, or app-code change |
| Full final cycle | roster blocking 0 (`#proof` PASS) · ASSURANCE 8/8 PROVEN · P07 3/3 PASS — all serial, all at this base (T22) |
| Cross-phase regression | recorded in the acceptance checkpoint |
| Freshness barrier | executed immediately before the acceptance records; result in the checkpoint decision |

## DEF-056 closure basis (second closure)

The structural condition (main outpaces a full cycle) fired once tonight and
was handled exactly as designed: the barrier refused, nothing was accepted
against a stale base, and the cycle re-ran at the new pin. Closure of
DEF-056 binds to THIS window: main held at `249bf314` from pinning through
the acceptance record itself.
