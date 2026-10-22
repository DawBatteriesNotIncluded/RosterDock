import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // A suite's beforeAll makes a repository with git: on a slow Windows runner that takes past vitest's 10 s.
    hookTimeout: 60_000,
  },
});
