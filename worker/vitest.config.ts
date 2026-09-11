import { defineConfig } from "vitest/config";

// Plain Node environment. Route/lib SQL is exercised against a real SQLite
// engine via test/d1-shim.ts (see the comment there for why: workerd's
// module loader currently breaks on Windows paths containing spaces, which
// this repository's path has). A parallel @cloudflare/vitest-pool-workers
// config is kept in vitest.config.workers.ts for CI environments (Linux)
// where the official pool works, if stricter D1-fidelity testing is wanted.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
