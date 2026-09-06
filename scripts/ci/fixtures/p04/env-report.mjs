// Fixture: report SAFE, NON-SECRET environment observations as JSON on
// stdout so P04.TEST03 can prove the child saw the controlled environment.
const names = [
  "TZ",
  "LC_ALL",
  "LANG",
  "CI_VERIFY_SEED",
  "TMPDIR",
  "CI_VERIFY_PORT",
  "NODE_OPTIONS",
  "CI_VERIFY_OWNER",
  "CI_VERIFY_GATE",
  "P04_HOST_CANARY",
  "P04_REMOVED_CANARY",
  "PATH_PRESENT",
];
const observed = {};
for (const name of names) {
  if (name === "PATH_PRESENT") {
    observed[name] = typeof process.env.PATH === "string";
    continue;
  }
  observed[name] = process.env[name] ?? null;
}
process.stdout.write(JSON.stringify(observed));
process.exit(0);
