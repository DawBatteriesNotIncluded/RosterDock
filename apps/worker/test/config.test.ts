import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://x", ROSTERDOCK_WORKER_TOKEN: "t" };

describe("worker config", () => {
  it("consumes the default queue, or its pool's queue when ROSTERDOCK_WORKER_POOL is set", () => {
    expect(loadConfig(base).queueName).toBe("runs");
    expect(loadConfig(base).pool).toBeNull();
    const pooled = loadConfig({ ...base, ROSTERDOCK_WORKER_POOL: "secure" });
    expect(pooled.pool).toBe("secure");
    expect(pooled.queueName).toBe("runs.secure");
    expect(() => loadConfig({ ...base, ROSTERDOCK_WORKER_POOL: "Not A Pool" })).toThrow(/not a pool name/);
  });

  it("takes whole-number settings, and refuses a typo instead of running on NaN", () => {
    const c = loadConfig(base);
    expect([c.heartbeatMs, c.testTimeoutMs, c.startAttempts, c.startRetryMs, c.metricsPort]).toEqual([
      15_000, 600_000, 60, 5_000, 0,
    ]);
    expect(
      loadConfig({ ...base, ROSTERDOCK_HEARTBEAT_MS: "5000", ROSTERDOCK_WORKER_METRICS_PORT: "9464" }),
    ).toMatchObject({
      heartbeatMs: 5000,
      metricsPort: 9464,
    });
    expect(() => loadConfig({ ...base, ROSTERDOCK_HEARTBEAT_MS: "15s" })).toThrow(
      'ROSTERDOCK_HEARTBEAT_MS must be a whole number from 1000 up, not "15s"',
    );
    expect(() => loadConfig({ ...base, ROSTERDOCK_WORKER_METRICS_PORT: "70000" })).toThrow(/from 0 to 65535/);
    expect(() => loadConfig({ ...base, ROSTERDOCK_START_ATTEMPTS: "0" })).toThrow(/START_ATTEMPTS/);
  });

  it("reads the collector from the standard variables", () => {
    expect(loadConfig(base).otlp).toBeNull();
    const t = loadConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
      OTEL_SERVICE_NAME: "w",
    });
    expect(t.otlp).toEqual({ endpoint: "http://otel:4318/v1/traces", headers: {}, serviceName: "w" });
  });
});
