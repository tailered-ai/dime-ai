// Public, read-only source evidence; never publishes or accesses the database.
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { scrapeVsinBettingSplits } from "../../../server/vsinBettingSplitsScraper";
const originalFetch = globalThis.fetch;
const captured = new Map<string, string>();
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  captured.set(String(args[0]), await response.clone().text());
  return response;
};
const stamp = new Date().toISOString().replaceAll(":", "-");
for (const sport of ["CFB", "NFL"] as const) {
  const games = await scrapeVsinBettingSplits("sport", sport);
  const pilot = games.find(game => game.gameId === (sport === "CFB" ? "20260907CFB00153" : "20260909NFL00061"));
  if (!pilot?.provenance) throw new Error(`${sport} pilot unavailable`);
  const body = captured.get(pilot.provenance.sourceUrl)!;
  if (createHash("sha256").update(body).digest("hex") !== pilot.provenance.responseSha256) throw new Error("Response fingerprint mismatch");
  const prefix = new URL(`./vsin-${sport}-${stamp}`, import.meta.url);
  await writeFile(`${prefix.pathname}.html`, body, { flag: "wx" });
  await writeFile(`${prefix.pathname}.json`, JSON.stringify({ capturedGames: games.length, pilot }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ evidence: `${prefix.pathname}.json`, pilot }));
}
