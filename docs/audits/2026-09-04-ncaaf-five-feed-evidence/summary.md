# September 4 selected NCAAF publication

Exactly five games: SJSU–EMU, Toledo–Michigan State, Fresno State–USC, UTEP–Oklahoma, Miami FL–Stanford. The owner supplied the point projections and moneylines and authorized newly calculated provisional spread/total prices. Book snapshot: [VSiN Circa](https://data.vsin.com/vegas-odds-linetracker/?sportid=cfb), September 4, 2026, 5:50 PM ET. All selected spread/total book prices are -110 on both sides.

## Pricing basis

The JSON records every mean, line, raw win/loss/push probability, conditional fair price, source hash, and limitation. Total uncertainty is the held-out residual RMSE of 623 FBS-v-FBS games (613 in the 2025 season, 10 in 2026), 16.12141814337222 points. The CSV retains every residual, training cutoff, prediction, and actual score. Weekly forecasts fit only preceding dates, with a 28-day initial warmup and final-2025 priors for 2026. Last included result: September 3, 2026. Forecast centers remain the owner's selected values. Margin uncertainty reuses the baseline 13.5 points.

For a normal distribution F and integer line L, P(lower)=F(L-0.5), P(higher)=1-F(L+0.5); remaining mass is a push. Half-point lines use F(L) with no push. Fair American odds use win/(win+loss), excluding pushes. These are provisional normal approximations, not recovered Monte Carlo draws or validated football key-number pricing. Historical forecasts omit game-specific injury/weather adjustments and use frozen 2026 FBS membership.

Fresno's owner-supplied -111/+111 applies to MODEL +19.5/-19.5 only. The market note preserves those values. Circa +21.5/-21.5 uses separately calculated -127/+127; edge calculations compare the same line. UTEP–Oklahoma has no Book moneyline comparison.

## Storage and presentation

The existing DECIMAL(6,1) schema stores rounded points. A server-only view restores exact authorized points only when the entire stored snapshot, date, event, teams, revision, and publication flags match. It runs before anonymous model stripping; no proprietary snapshot is imported into the browser bundle. Existing generated helmets and existing cards/pagination are reused. No schema migration or dependency.

## Verification

The publisher checks all selected identities before any write, locks global event collisions as well as the date slate, verifies every value before commit, and compares unrelated rows. A subsequent fresh connection verifies committed data. Tests cover complete presentation, protected model stripping, stale/mismatched snapshots, and the missing UTEP moneyline.


## Owner revision and additional source publication

The owner subsequently revised the model to favor Michigan State: Toledo +7.36 / +241 ML, MSU -7.36 / -241 ML. At Circa Toledo +10 / MSU -10, recalculated fair prices are -138 / +138; total 51.06 and all other game projections remain unchanged. The original baseline remains in the earlier commit and source artifacts.

The five existing game records receive all six VSiN Circa split percentages, observed September 4 at 7:36 PM ET. Separate odds_history rows hold AN Opening (book 30) and DraftKings NJ (book 68) pregame odds, observed 23:36:19.387Z. They do not overwrite Circa's selected book lines or model prices. Each observation time means retrieval time, not a reconstructed opening timestamp. AN Circa (book 78) was explicitly requested and absent for all five; default Consensus/Open fallbacks were not mislabeled Circa. UTEP–Oklahoma moneylines remain unavailable in both history sources.

Opening history rows leave all split percentages null because opening-time splits were not provided; the current AN market snapshot carries the explicitly labeled VSiN Circa percentages.

Live verification also found college MIA resolving to the MLB Marlins on the splits surface, plus a conditional viewport hook that could fail when UTEP changed from no splits to populated. NCAAF now bypasses professional identity/color lookups, reuses the same public helmet map in cards and history, and calls the viewport hook before the empty-state return.
