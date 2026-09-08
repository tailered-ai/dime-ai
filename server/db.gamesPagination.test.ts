import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sql, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, expect, it, vi } from "vitest";

let fixture: DatabaseSync;
let queries = 0;
vi.mock("mysql2/promise", () => ({
  default: { createPool: () => ({ end: async () => {} }) },
}));
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => ({
    select: () => {
      let predicate: SQL;
      let order: SQL[];
      let limit: number | undefined;
      let offset = 0;
      const chain = {
        from: () => chain,
        where: (value: SQL) => {
          predicate = value;
          return chain;
        },
        orderBy: (...value: SQL[]) => {
          order = value;
          return chain;
        },
        limit: (value: number) => {
          limit = value;
          return chain;
        },
        offset: (value: number) => {
          offset = value;
          return chain;
        },
        then: (resolve: (value: unknown[]) => void) => {
          const pagination =
            limit === undefined ? sql`` : sql` LIMIT ${limit} OFFSET ${offset}`;
          const query = new MySqlDialect().sqlToQuery(
            sql`SELECT * FROM games WHERE ${predicate} ORDER BY ${sql.join(order, sql`, `)}${pagination}`
          );
          queries++;
          resolve(
            fixture
              .prepare(query.sql)
              .all(
                ...(query.params.map(value =>
                  typeof value === "boolean" ? Number(value) : value
                ) as SQLInputValue[])
              )
          );
        },
      };
      return chain;
    },
  }),
}));
import { listGames } from "./db";

afterEach(() => {
  fixture?.close();
  vi.unstubAllEnvs();
});

it("executes stable SQL pages, isolates their caches, and preserves model gating and unpaged calls", async () => {
  vi.stubEnv("DATABASE_URL", "mysql://localhost:3306/testdb");
  fixture = new DatabaseSync(":memory:");
  fixture.exec(`CREATE TABLE games (
    id INTEGER PRIMARY KEY, sport TEXT, gameDate TEXT, gameStatus TEXT,
    startTimeEst TEXT, sortOrder INTEGER, awayBookSpread REAL, bookTotal REAL,
    publishedToFeed INTEGER, publishedModel INTEGER, modelTotal REAL
  ); INSERT INTO games VALUES
    (1, 'NCAAM', '2026-09-08', 'upcoming', 'TBD', 0, 7, 50, 1, 0, 99),
    (2, 'NCAAM', '2026-09-08', 'upcoming', '16:00', 0, 7, 50, 1, 0, 99),
    (3, 'NCAAM', '2026-09-08', 'upcoming', '12:00', 0, 7, 50, 1, 0, 99),
    (4, 'NCAAM', '2026-09-08', 'upcoming', '12:00', 0, 7, 50, 1, 1, 99),
    (5, 'NCAAM', '2026-09-08', 'suspended', '11:00', 0, 7, 50, 1, 1, 99);`);
  const first = await listGames({ gameDate: "2026-09-08", limit: 2 });
  const second = await listGames({
    gameDate: "2026-09-08",
    limit: 2,
    offset: 2,
  });
  expect(first.map(row => row.id)).toEqual([3, 4]);
  expect(second.map(row => row.id)).toEqual([2, 1]);
  expect(first.map(row => row.modelTotal)).toEqual([null, 99]);
  const beforeCache = queries;
  expect(await listGames({ gameDate: "2026-09-08", limit: 2 })).toEqual(first);
  expect(queries).toBe(beforeCache);
  expect(
    (await listGames({ gameDate: "2026-09-08" })).map(row => row.id)
  ).toEqual([3, 4, 2, 1]);
  const beforeEmpty = queries;
  expect(
    await listGames({ gameDate: "2026-09-08", limit: 2, offset: 4 })
  ).toEqual([]);
  expect(queries).toBe(beforeEmpty + 1);
});
