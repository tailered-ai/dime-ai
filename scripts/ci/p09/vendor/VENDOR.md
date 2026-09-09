# Vendored: axe-core 4.10.3 (`axe.min.js`)

| Field | Value |
| --- | --- |
| Package | axe-core@4.10.3 (Deque Systems, MPL-2.0) |
| Source | https://cdn.jsdelivr.net/npm/axe-core@4.10.3/axe.min.js |
| sha256 | `880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb` |
| Fetched | 2026-08-12 |
| Why vendored | the P09 accessibility gate injects it into the BUILT client via Playwright; vendoring keeps the gate offline and version-pinned (the governed-tool law), and axe-core is not otherwise a project dependency |

Upgrade deliberately: replace the file, update the hash here, and re-run the
P09 a11y control/poison cycle.
