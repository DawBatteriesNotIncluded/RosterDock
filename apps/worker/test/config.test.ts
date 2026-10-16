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
