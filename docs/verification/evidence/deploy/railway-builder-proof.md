# Railway builder identity — live build-log proof

date: 2026-08-13T14:30Z (read-only probe, Railway MCP `get-logs`, build stream)
deployment probed: `5bb7e28b-951a-4b3c-8252-ad8365658198` (the LIVE production
deployment, commit `249bf314c131e0f34aa0f1aae393411e4e8c8d55`, status SUCCESS)

## Question

`railway.json` pins `build.builder: DOCKERFILE`; the live service config read
2026-08-13 reported builder `RAILPACK/V3`. Which one actually built the
running production artifact? (Recorded as residual risk in readiness
certificate `7d9f5822…860`.)

## Evidence (verbatim build-log lines, deployment 5bb7e28b)

```
scheduling build on Metal builder "builder-kueyem"
unpacking archive
[internal] load build definition from Dockerfile
[internal] load metadata for docker.io/library/node:22-bookworm-slim
[internal] load .dockerignore
[internal] load build context
```

112 build-log entries total; zero occurrences of `railpack` or `nixpacks`
(case-insensitive) anywhere in the stream.

## Cross-check against the repository

- repo `Dockerfile` first stages: `FROM node:22-bookworm-slim AS build`,
  `FROM node:22-bookworm-slim AS proddeps` — the exact base image the build
  log loads metadata for.
- repo `railway.json`: `"builder": "DOCKERFILE", "dockerfilePath": "Dockerfile"`.

## Verdict

PROVED: the live production artifact was built from the repository
`Dockerfile`. The service-config `RAILPACK/V3` value is **inert** while
`railway.json` is present (file pin takes precedence). The residual risk
narrows to exactly one trigger: **removing or renaming `railway.json` would
silently activate Railpack** and break the artifact-identity law. That trigger
is owner-controlled repository content, covered by review.

No secret values, tokens, or environment variable contents appear in the
quoted lines; the probe was read-only.
