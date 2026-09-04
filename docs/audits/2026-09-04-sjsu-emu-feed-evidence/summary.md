# September 4 SJSU–EMU feed publication

Owner brief: publish only SJSU at Eastern Michigan, using the existing September 3 feed card and the generated helmets. Publish through the existing live `tailered-ai/dime-ai` repository. No new layout, components, motion, or schema.

## Selected content

VSiN's Circa board explicitly reported its update as September 4, 2026, 5:50 PM ET: https://data.vsin.com/vegas-odds-linetracker/?sportid=cfb.

| Market | Circa book | Selected provisional model |
| --- | --- | --- |
| Spread | SJSU +1 / EMU -1, both -110 | SJSU +2.3 / EMU -2.3 |
| Total | 55, over and under -110 | 54.7 |
| Moneyline | SJSU +100 / EMU -120 | SJSU +130 / EMU -130 |

The model is the owner's selected uncalibrated analyst-paper baseline. Fair spread prices at ±1 and total prices at 55 were unavailable and remain null. The visible source label states the Circa timestamp and provisional model status. Both generated helmet assets were visually inspected and match the selected teams.

## Verification before publication

- Publisher positive and negative assertions: `SJSU_EMU_PAYLOAD_CHECK_PASS`.
- Focused feed tests: 59 passed, zero failed or skipped.
- TypeScript: exit 0.
- Client and server production builds: exit 0.
- Production preview guard: PASS, 117 files scanned.
- Bundle check: 216,076 bytes against a 222,538-byte ceiling.
- Workflow security check: PASS, 44 workflows, 127 action references, 28 production-secret references.
- Changed-file Prettier check and `git diff --check`: pass.
- Remote required checks, actual database publication, and deployed feed verification are pending at this evidence revision. Their immutable links and outcomes belong in the PR's engineering evidence record.

Full new-design screenshots, a design brief generator, and a motion review were not run: this content update reuses the owner's reference component, existing styling, and previously generated assets. Live verification will inspect the existing card, expanded spread/total/moneyline table, and both loaded helmets. The publisher verifies every selected field and that unrelated NCAAF rows remain identical within its transaction.
