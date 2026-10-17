// The board client over an injected fetch and sleep: no network, no waiting.
import { describe, expect, it } from "vitest";
import { BoardError, COMPLETE_RETRIES, createBoardClient } from "../src/board-client.js";

function board(statuses: number[]) {
  const calls: string[] = [];
  const slept: number[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    return new Response(status === 200 ? "{}" : JSON.stringify({ error: `HTTP ${status}` }), { status });
  }) as typeof fetch;
  const client = createBoardClient("http://board.test", "fleet-token", fetchImpl, {
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { client, calls, slept };
}

describe("reporting a run's completion", () => {
  it("rides out a board that is down for minutes, backing off to 30 s", async () => {
    const { client, calls, slept } = board([503, 503, 503, 503, 503, 503, 503, 503, 200]);
    await client.complete("run-token", "run-1", { status: "completed" });
    expect(calls).toHaveLength(9);
    expect(slept).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });

  it("gives up after about five minutes", async () => {
    const { client, calls, slept } = board([503]);
    await expect(client.complete("run-token", "run-1", { status: "completed" })).rejects.toThrow(/503/);
    expect(calls).toHaveLength(COMPLETE_RETRIES.retries + 1);
    const total = slept.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(5 * 60_000);
    expect(total).toBeLessThan(6 * 60_000);
  });

  it("does not retry a refusal", async () => {
    const { client, calls } = board([400]);
    const err = await client.complete("run-token", "run-1", { status: "completed" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardError);
    expect((err as BoardError).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
