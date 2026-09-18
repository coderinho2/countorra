import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    // Every tests/rls/*.test.ts spins up a fresh PGlite (WASM Postgres)
    // instance per test and re-applies all migrations — correct (each
    // test gets a genuinely clean database), but running all RLS files
    // in parallel with everything else under the default 10s hook
    // timeout was observed to time out under load even though each
    // suite passes cleanly in isolation. Generous timeouts plus capping
    // worker concurrency trade a slower `npm test` for a reliable one.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
      // See tests/stubs/server-only.ts.
      "server-only": path.resolve(dirname, "./tests/stubs/server-only.ts"),
    },
  },
});
