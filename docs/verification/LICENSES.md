# Dependency license policy

Enforced by `06-dependency-review.yml` (`allow-licenses`) on every PR.

## Allowlist

MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense,
CC0-1.0, CC-BY-4.0, Python-2.0, BlueOak-1.0.0, Zlib.

## Explicitly forbidden (blocking)

GPL-2.0/3.0 (and AGPL, LGPL — static-linked server bundle makes weak-copyleft
risky), SSPL, BUSL, CC-BY-NC-*, proprietary/no-license.

## Known pre-existing exceptions

If dependency-review flags an existing transitive dep, record it here with
justification + replacement plan rather than widening the allowlist silently.
Exceptions are granted per exact package purl via `allow-dependencies-licenses`
in `06-dependency-review.yml` — never as a license-wide allowance.

### Tailered OS embed dev toolchain (PR #496, recorded 2026-08-10)

All entries come from `platform/tailered-os/pnpm-lock.yaml` and are transitive
packages of the Cloudflare Workers dev/test toolchain. None is a runtime
dependency and none is distributed in any shipped artifact: the only runtime
`dependencies` edges in the workspace are `capnweb` (MIT), `capnweb-validate`
(MIT, whose vite linkage is peer-only via unplugin), `@cloudflare/workers-types`
(types only), and internal `workspace:*` links. The Dime production image also
excludes `platform/` entirely (`.dockerignore`), so nothing here can reach the
Railway bundle.

| Package(s) | License | Chain (all dev-scope) | Why it exists | Replacement plan |
| --- | --- | --- | --- | --- |
| `@img/sharp-libvips-{darwin-arm64, darwin-x64, linux-arm, linux-arm64, linux-ppc64, linux-riscv64, linux-s390x, linux-x64, linuxmusl-arm64, linuxmusl-x64}@1.3.1` | LGPL-3.0-or-later | devDeps `wrangler` / `@cloudflare/vitest-pool-workers` → `miniflare` → `sharp@0.35.2` → optional platform binaries | libvips prebuilds miniflare (the local Workers simulator) uses for Cloudflare Images emulation in dev/test only; at most the one host-matching binary is ever installed, none is bundled or deployed | Drops automatically if upstream miniflare makes `sharp` optional or replaces it; re-audit on each wrangler/miniflare major bump |
| `@img/sharp-wasm32@0.35.2` (Apache-2.0 AND LGPL-3.0-or-later AND MIT), `@img/sharp-win32-{arm64, ia32, x64}@0.35.2` (Apache-2.0 AND LGPL-3.0-or-later) | AND-expressions incl. LGPL-3.0-or-later | same `sharp` optional-binary family | same as above (wasm/Windows variants; never installed on Linux CI or any deploy target) | same as above |
| `lightningcss@1.33.0` + `lightningcss-{android-arm64, darwin-arm64, darwin-x64, freebsd-x64, linux-arm-gnueabihf, linux-arm64-gnu, linux-arm64-musl, linux-x64-gnu, linux-x64-musl, win32-arm64-msvc, win32-x64-msvc}@1.33.0` | MPL-2.0 | devDeps `vite@7.3.6` (optionalDependency) and `vitest@4.1.10` → `vite@8.2.0` (hard dependency) | CSS transformer used by vite at build/test time; a build tool, not a library we bundle — MPL obligations attach to distributing MPL-covered files, and only its output ever ships | Drops automatically if vite stops depending on lightningcss; re-audit on each vite major bump |

MPL-2.0 is file-level weak copyleft and is not on the explicitly-forbidden list;
LGPL is, but its listed rationale (static-linked server/client bundles) does not
reach dev-only tooling that is never distributed. If any of these packages ever
appears on a runtime `dependencies` edge, the exception no longer applies —
remove its purl and treat it as a blocking finding.

Undetected-license entries (`@gadgets/workshop-shared@workspace:*`,
`@gadgets/error-reporting@workspace:*`, `capnweb@^0.8.0` as manifest ranges) are
warn-only in dependency-review and carry no exception: the `@gadgets/*` packages
are private internal workspace packages with no `license` field, and
`capnweb@0.8.0` resolves to MIT (github.com/cloudflare/capnweb).

## Rationale

The server bundle (esbuild, single-file) statically incorporates dependencies;
the client bundle ships to browsers. Both distribution modes make copyleft
obligations real, and the business (proprietary SaaS) cannot carry them.
