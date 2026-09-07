import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, expect, it, vi } from "vitest";

let fixture: DatabaseSync;

vi.mock("mysql2/promise", () => ({
  default: { createPool: () => ({ end: async () => {} }) },
}));
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => {
    let rows: unknown[];
    const chain = {
      select: () => chain,
      from: () => chain,
      where: (predicate: SQL) => {
        // Execute the real listGames WHERE clause. This predicate uses portable
        // SQL; SQLite supplies a private in-memory engine, never a remote DB.
        const query = new MySqlDialect().sqlToQuery(predicate);
        rows = fixture
          .prepare(`SELECT * FROM games WHERE ${query.sql}`)
          .all(
            ...(query.params.map(value =>
              typeof value === "boolean" ? Number(value) : value
            ) as SQLInputValue[])
          );
        return chain;
      },
      orderBy: () => Promise.resolve(rows),
    };
    return chain;
  },
}));

import { listGames } from "./db";

afterEach(() => {
  fixture?.close();
  vi.unstubAllEnvs();
});

it("keeps every NCAAF lifecycle while retaining other leagues' suspended/postponed exclusions", async () => {
  vi.stubEnv("DATABASE_URL", "mysql://localhost:3306/testdb");
  fixture = new DatabaseSync(":memory:");
  fixture.exec(`CREATE TABLE games (
    id INTEGER PRIMARY KEY, sport TEXT, gameDate TEXT, gameStatus TEXT,
    startTimeEst TEXT, sortOrder INTEGER, awayBookSpread REAL, bookTotal REAL, publishedToFeed INTEGER
  )`);
  const statuses = ["upcoming", "live", "final", "postponed", "suspended"];
  const sports = ["NCAAF", "NFL", "MLB", "NBA", "NHL", "NCAAM"];
  const insert = fixture.prepare(
    "INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  let id = 0;
  for (const sport of sports) {
    for (const [index, status] of statuses.entries()) {
      insert.run(
        ++id,
        sport,
        "2026-09-05",
        status,
        `1${index}:00`,
        index,
        7,
        50,
        1
      );
    }
  }
  // The NCAAF exemption must not bypass the requested date constraint.
  insert.run(++id, "NCAAF", "2026-09-04", "suspended", "12:00", 0, 7, 50, 1);

  for (const sport of [...sports, undefined]) {
    const rows = await listGames({
      sport,
      gameDate: "2026-09-05",
      forceRefresh: true,
    });
    const expectedSports = sport ? [sport] : sports;
    for (const expectedSport of expectedSports) {
      expect(
        rows
          .filter(row => row.sport === expectedSport)
          .map(row => row.gameStatus)
      ).toEqual(
        ["NCAAF", "NFL"].includes(expectedSport)
          ? statuses
          : statuses.slice(0, 3)
      );
    }
    expect(rows.every(row => row.gameDate === "2026-09-05")).toBe(true);
  }
});

it("retains explicitly published NCAAF games without prices, without admitting unpublished or other-sport rows", async () => {
  vi.stubEnv("DATABASE_URL", "mysql://localhost:3306/testdb");
  fixture = new DatabaseSync(":memory:");
  fixture.exec(`CREATE TABLE games (
    id INTEGER PRIMARY KEY, sport TEXT, gameDate TEXT, gameStatus TEXT,
    startTimeEst TEXT, sortOrder INTEGER, awayBookSpread REAL, bookTotal REAL, publishedToFeed INTEGER
  );
  INSERT INTO games VALUES
    (1, 'NCAAF', '2026-09-06', 'upcoming', '16:00', 0, NULL, NULL, 1),
    (2, 'NCAAF', '2026-09-06', 'upcoming', '16:00', 1, NULL, NULL, 0),
    (3, 'NCAAM', '2026-09-06', 'upcoming', '16:00', 2, NULL, NULL, 1),
    (4, 'NCAAF', '2026-09-05', 'upcoming', '16:00', 3, NULL, NULL, 1),
    (5, 'NFL', '2026-09-06', 'upcoming', '16:00', 4, NULL, NULL, 1),
    (6, 'NFL', '2026-09-06', 'upcoming', '16:00', 5, NULL, NULL, 0);`);
  for (const sport of ["NCAAF", undefined]) {
    expect(
      (
        await listGames({ sport, gameDate: "2026-09-06", forceRefresh: true })
      ).map(row => row.id)
    ).toEqual(sport ? [1] : [1, 5]);
  }
});
