// Fixture: ignores SIGTERM so the timeout lifecycle must escalate to
// SIGKILL. Announces readiness on stdout, then holds.
process.on("SIGTERM", () => {
  /* deliberately ignored — escalation fixture */
});
process.stdout.write("holding\n");
setInterval(() => {}, 1000);
