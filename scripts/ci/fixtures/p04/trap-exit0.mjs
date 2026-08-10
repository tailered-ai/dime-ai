// Fixture: on SIGTERM exits 0 QUICKLY — used to prove the timeout LATCH:
// a gate whose deadline fired stays TIMEOUT even though the process then
// exits 0 during termination.
process.on("SIGTERM", () => process.exit(0));
process.stdout.write("holding\n");
setInterval(() => {}, 1000);
