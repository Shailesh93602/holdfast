import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The concurrency tests spin up real Postgres connections and contend on
    // hot rows; give them room and run test files serially so two suites don't
    // fight over the same seeded inventory.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
