# Pre-delivery checklist

- [x] Mint remains reserved for signal, active state and focus. NCAAF table edge threshold follows the owner's strict >0 rule; nonpositive or incomparable quotes remain neutral.
- [x] Positive text uses existing `--brand-mint-foreground` in both themes.
- [x] Existing Familjen Grotesk / IBM Plex Mono typography retained.
- [x] Existing SVG icons retained; no emoji icons added.
- [x] Click controls retain pointer cursors and semantic buttons/links.
- [x] Existing hover timing retained; no new animation.
- [x] Line/price/basis text inherits existing contrast tokens. Light comparison arrow corrected to the themed foreground.
- [x] Keyboard open, paging, close and restored focus covered by browser checks.
- [x] Reduced-motion carousel/focus case covered.
- [x] Final production-build matrix and all-game source audit pass: 12 cases, all 68 games.
- [ ] Production deployment and configured smoke verified after merge.

No new motion code; motion-review artifact is not required. Browser coverage is Chromium; Firefox/WebKit are not claimed. The existing popover scrolls internally when all three market pages cannot fit vertically.
