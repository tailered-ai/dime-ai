// Fixture: deliberately leaves an owned child behind (P04.NEG01). Spawns a
// detached long sleeper that inherits this process's environment — including
// the executor's ownership markers — then exits 0 without reaping it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, "sleep.mjs"), "60000"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
process.stdout.write(`orphaned ${child.pid}\n`);
process.exit(0);
