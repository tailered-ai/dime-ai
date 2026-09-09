# P00.T03 — is `scripts/**` inside patch-coverage measurement scope?

Raw output: `raw/T03-coverage-scope.raw.txt`.

## Sources inspected
- `scripts/check-patch-coverage.mjs` lines 42-53 (the changed-line diff)
- `.github/workflows/07-coverage-patch.yml` lines 37-46 (coverage collection)

## Observed
Changed-line diff pathspec (`check-patch-coverage.mjs:42-53`):
```
git diff --unified=0 ${BASE}...HEAD -- server/**/*.ts shared/**/*.ts
```
Coverage collection (`07-coverage-patch.yml:37-39`):
```
--coverage.include='server/**' --coverage.include='shared/**'
```
Occurrences of a `scripts/` path in `check-patch-coverage.mjs`: **0**.

## ANSWER
**NO. `scripts/**` is OUTSIDE patch-coverage scope on BOTH surfaces** — it is
excluded from the changed-line diff pathspec and from the v8 coverage include
globs. Floors are 90% overall / 100% on money-auth paths, and neither can ever
apply to a file under `scripts/`.

## Consequence for the blueprint
1. `scripts/ci/**` — the verifier's own implementation — carries **no
   enforced coverage floor**. `scripts/ci/ledger.test.ts` is voluntary
   discipline, not a gate.
2. The tests written in P-BOOT deliberately import and EXECUTE the modules
   rather than asserting over source text, so they would register real
   coverage if scope were ever widened.
3. Widening the floor to `scripts/ci/**` is a HARDENING-class candidate
   (P09). It is NOT adopted here: changing check 07's scope alters a required
   status check and is outside P00's authority.
