// Fixture: mutates its own execution cwd (candidate-mutation detection).
import { writeFileSync } from "node:fs";
writeFileSync("mutation-artifact.txt", "the gate wrote into its candidate\n");
process.exit(0);
