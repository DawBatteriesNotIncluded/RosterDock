// The live stream: the board names every frame by its event type, and EventSource hands a named frame only
// to a listener of that name, so the client must listen for every type there is. No network: EventSource is
// a fake that delivers frames by name.
import { EVENT_TYPES, type EventRecord } from "@rosterdock/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpClient } from "../src/api/client.ts";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, EventListener[]>();
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  /** A frame as the board writes it: `event: <name>` and the record as data. */
  deliver(name: string, data: string) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data } as MessageEvent<string>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.last = null;
});

describe("subscribe", () => {
  it("delivers a frame of every event type the board appends, once each", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const seen: string[] = [];
    const stop = httpClient.subscribe("c-1", 41, (ev) => seen.push(ev.type));
    const source = FakeEventSource.last!;
    expect(source.url).toBe("/api/companies/c-1/events/stream?afterSeq=41");

    EVENT_TYPES.forEach((type, i) => {
      const ev: EventRecord = {
        id: `e-${i}`,
        companyId: "c-1",
        seq: 42 + i,
        type,
        actor: null,
        subject: null,
        payload: {},
        createdAt: "2026-10-16T12:00:00.000Z",
      };
      source.deliver(type, JSON.stringify(ev));
    });
    expect(seen).toEqual([...EVENT_TYPES]);
    // Among them the ones the hand-kept list used to miss.
    expect(seen).toEqual(expect.arrayContaining(["teammate.drift", "review.reassigned", "pr.closed"]));

    stop();
    expect(source.closed).toBe(true);
  });
});
