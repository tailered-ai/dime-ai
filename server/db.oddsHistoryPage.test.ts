import { afterEach, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
const state = vi.hoisted(() => ({
  rows: Array.from({ length: 451 }, (_, n) => ({
    id: 451 - n,
    gameId: 7,
    scrapedAt: 1000 - Math.floor(n / 3),
  })),
  queries: [] as any[],
}));
vi.mock("mysql2/promise", () => ({ default: { createPool: () => ({}) } }));
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => ({
    select: () => {
      let params: unknown[] = [];
      const query: any = {
        from: () => query,
        where: (condition: any) => {
          const sql = new MySqlDialect().sqlToQuery(condition);
          state.queries.push(sql);
          params = sql.params;
          return query;
        },
        orderBy: (...columns: any[]) => {
          expect(columns).toHaveLength(2);
          return query;
        },
        limit: async (limit: number) => {
          expect(limit).toBeLessThanOrEqual(201);
          return state.rows
            .filter(
              row =>
                row.gameId === params[0] &&
                (params.length === 1 ||
                  row.scrapedAt < Number(params[1]) ||
                  (row.scrapedAt === params[2] && row.id < Number(params[3])))
            )
            .slice(0, limit);
        },
      };
      return query;
    },
  }),
}));
import { listOddsHistoryPage } from "./db";
afterEach(() => vi.unstubAllEnvs());
it("reaches every observation across 200-row pages with tied timestamps, no gaps or duplicates", async () => {
  vi.stubEnv("DATABASE_URL", "mysql://localhost/testdb");
  const seen: number[] = [];
  let cursor: { scrapedAt: number; id: number } | undefined;
  do {
    const page = await listOddsHistoryPage(7, { cursor, limit: 200 });
    seen.push(...page.history.map(row => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(state.rows.map(row => row.id));
  expect(state.queries[1].sql).toMatch(/scrapedAt.*<.*scrapedAt.*=.*id.*</);
  await expect(listOddsHistoryPage(7, { limit: 201 })).rejects.toThrow(
    /page size/
  );
});
