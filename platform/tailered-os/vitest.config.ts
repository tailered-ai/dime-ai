// Config barrier for the embedded location. Vitest resolves its config by walking
// UP from the package under test; packages/error-reporter has no local config, and
// without this file the search escapes Tailered OS and loads the Dime repository's
// root vitest.config.ts (wrong dependency graph, wrong config). An empty default
// export stops the search here with vitest's defaults — packages with their own
// config (custom-gatekeeper) are unaffected because a package-local config wins.
export default {};
