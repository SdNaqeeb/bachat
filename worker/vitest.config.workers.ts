import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Official Cloudflare-recommended test setup (real workerd + D1 semantics).
// Known not to work on Windows when the repo path contains a space — see
// the comment in test/d1-shim.ts. Use this from CI (Linux) if you want
// stricter fidelity than the default node:sqlite-backed `npm test`.
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.workers.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: { INGEST_KEY: "test-secret" },
        },
      },
    },
  },
});
