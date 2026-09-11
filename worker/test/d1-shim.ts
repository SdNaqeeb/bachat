// A minimal D1Database-compatible shim backed by Node's built-in
// node:sqlite, used to run worker/schema.sql and the real route/lib SQL in
// tests without needing a live Cloudflare account.
//
// Why not @cloudflare/vitest-pool-workers? It is the officially documented
// approach and is still configured in vitest.config.workers.ts for use in
// CI (GitHub Actions, Linux) — but on Windows, when the repository path
// contains a space (as this one does: "Personal Repositories"), workerd's
// module resolver mis-builds file:// URLs and the whole pool fails to boot
// (upstream issue in the miniflare/workerd module loader, not something
// fixable from application code). This shim exercises the exact same
// schema.sql and the exact same SQL strings used in src/, on real SQLite,
// so behaviour is equivalent for everything this project queries
// (it does not support D1-specific quirks like storage-key partitioning,
// which none of our routes rely on).

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";

// Loaded via createRequire rather than a static ESM import: Vite's resolver
// (used by vitest under the hood) does not yet recognise node:sqlite as a
// built-in and tries to resolve it as an npm package. require() bypasses
// that resolution step entirely while still running in Node.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

class D1StatementShim {
  constructor(
    private readonly stmt: StatementSync,
    private params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): D1StatementShim {
    return new D1StatementShim(this.stmt, params);
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    this.stmt.run(...(this.params as never[]));
    return { success: true, meta: {} };
  }

  async first<T>(): Promise<T | null> {
    const row = this.stmt.get(...(this.params as never[]));
    return (row as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.stmt.all(...(this.params as never[]));
    return { results: rows as T[] };
  }
}

export class D1Shim {
  private readonly db: DatabaseSyncType;

  constructor() {
    this.db = new DatabaseSync(":memory:");
  }

  prepare(sql: string): D1StatementShim {
    return new D1StatementShim(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async batch<T = unknown>(statements: D1StatementShim[]): Promise<T[]> {
    this.db.exec("BEGIN");
    try {
      const results: T[] = [];
      for (const s of statements) {
        results.push((await s.run()) as T);
      }
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function asD1(shim: D1Shim): D1Database {
  return shim as unknown as D1Database;
}
