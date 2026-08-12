# T23 — P08 CLEANROOM acceptance evidence

Base `249bf314` · candidate `e35cd5841c9e` (HEAD `acaa234cd`, carrying the
DEF-063 graceful-shutdown fix) · contract `b594ebd9` unchanged.

## Chain

| Stage | Result |
| --- | --- |
| Provisioning | physical in-candidate, 23.0s |
| T01/T02 image identity | `images.pinned.json` — DEC-001=RECORD_ONLY; FROM digests resolved, Dockerfile untouched |
| T03 build | PASS 166.4s warm (`T23-all-run.log`); first-ever cold build measured ~29min (led to the 45min budget + INFRA classification fix) |
| T04 trivy | PASS — CRITICAL, fixable-only, zero findings (`trivy.table`) |
| T05 SBOM | PASS — spdx-json, **1,191 packages**, sha256 `37c603be55151386dc3fb955ad9cf5aca71ed46c86e15ddf4f0485ae4898dee7` (29.8MB artifact at `.ci-verify/p08/sbom.spdx.json`; bound here by hash rather than committed) |
| T06 profile A (dead DB) | PASS — health in 3 polls, repo smoke suite 11/11, structured 401, no crash loop, listen line, no secret leak, **SIGTERM → exit 0** |
| T07 profile B (healthy DB) | PASS — digest-bound MySQL 8.4.11, reconciled migrations, health at the exact candidate commit, smoke 11/11, **graceful exit 0, DB connections drained to zero** |
| NEG01 | broken Dockerfile fails the BUILD before any runtime gate |
| NEG02 | wrong EXPECTED_COMMIT fails profile B on build identity (smoke build-identity check) |
| NEG03 | MySQL killed mid-run classifies **INFRA-FAIL(SYNTHETIC)**, never FAIL |
| GATE01 | **3/3 consecutive clean A+B rounds** (`T23-gate-run.log`) |
| CLN01 | zero residue after every run (docker inventory diff) |

## DEF-063 — the discovery this phase paid for

Run 1's profile B failed its shutdown legs with exit 137: node runs as PID 1
(`CMD ["node", "dist/index.js"]`) and **no SIGTERM handler existed anywhere
in server/** — PID 1 ignores default dispositions, so every Railway deploy
has been hard-killing the app since inception. Fixed at the entrypoint
(`server.close` + `closeIdleConnections` + `closeDbPool` → exit 0; 15s
unref'd drain deadline → exit 1). Retested: profile A exit 0, profile B full
sweep, across **four** total clean rounds (all-run + 3 gate rounds).

## T08/AUD01 — build variance (ADVISORY, recorded not judged)

Same candidate `e35cd5841c9e`, two warm builds minutes apart:
image id `226ff58f353f` then `5590d5d36531`. BuildKit attestations and
timestamps make the image id **run-scoped, not content-addressed**. The
binding identity in this program is therefore the candidate commit — baked
in as `RAILWAY_GIT_COMMIT_SHA` and enforced end-to-end by the smoke suite's
EXPECTED_COMMIT check (NEG02 proves it rejects a mismatch) — never the
docker image id.

## Verifier fidelity fix recorded on the way

Run 0's cold build (29min of real work) was killed by the runner's own
30-minute spawnSync budget and initially mislabeled a candidate defect.
Corrected: 45min budget, `--progress=plain` build log, and signal/timeout
kills now classify INFRA per the boundary law.
