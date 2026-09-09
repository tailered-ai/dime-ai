// Fixture: sleep for argv[2] ms, then exit 0. Responds to SIGTERM normally.
const ms = Number(process.argv[2] ?? 1000);
setTimeout(() => process.exit(0), ms);
