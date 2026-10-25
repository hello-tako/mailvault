import { defineConfig } from "vitest/config";

/**
 * Tests run in Node. Unit specs cover pure modules directly; integration specs spin a
 * real D1 + R2 through programmatic Miniflare (see test/integration/_mf.ts). Node 20+
 * provides the Web globals the Worker relies on (crypto, Response, Headers,
 * ReadableStream), so application code executes against the same APIs as in workerd.
 */
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": new URL("./test/compat/worker-entrypoint-node.ts", import.meta.url).pathname } },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
