import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file provisions its own throwaway database, so files can run in parallel;
    // capped so the pools (dbPoolMax per board, twice) stay under Postgres' 100 connections.
    maxWorkers: 6,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
