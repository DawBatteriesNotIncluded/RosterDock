// What a company chooses the board should reach: the operator's list of private destinations, every hop
// checked before anything is sent, each call site's redirect rule and deadline, and the pinned transport
// carrying a body and an event stream (MCP's included, through the SDK's client) to a server on 127.0.0.1
// that the list allows. The resolvers are fakes, and so is the fetch above the transport's own tests. No
// network.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { discoverTools } from "../src/mcp/client.js";
import {
  NO_PRIVATE_DESTINATIONS,
  parsePrivateDestinations,
  reachableAddresses,
  RefusedAddress,
  refuseDestination,
} from "../src/web/address.js";
import { boardEgress, egressFetch } from "../src/web/egress.js";
import { PUBLIC_TEST_ADDRESS, testEgress } from "./helpers.js";

const NOT_ALLOWED = "which this board's operator has not allowed";

describe("the private destinations an operator allows", () => {
  it("reads names, names under a domain, addresses and ranges, and stops the board on anything else", () => {
    const allow = parsePrivateDestinations(
      " Ollama.internal, *.svc.cluster.local ,127.0.0.1,[::1],10.0.0.0/8,[fd00::]/8, 172.16.5.9/12 ",
    );
    expect(allow.names).toEqual(["ollama.internal", "*.svc.cluster.local"]);
    expect(allow.entries).toEqual([
      "ollama.internal",
      "*.svc.cluster.local",
      "127.0.0.1",
      "[::1]",
      "10.0.0.0/8",
      "[fd00::]/8",
      "172.16.5.9/12",
    ]);
    expect(parsePrivateDestinations(undefined)).toEqual(NO_PRIVATE_DESTINATIONS);
    expect(parsePrivateDestinations(" , ")).toEqual(NO_PRIVATE_DESTINATIONS);
    for (const bad of [
      "*",
      "*.",
      "http://ollama.internal",
      "ollama.internal:11434",
      "10.0.0.0/33",
      "::1/129",
      "10.0.0",
      "a..b",
      "x.internal/8",
      "1.2.3.4/8/9",
      "under score.internal",
    ])
      expect(() => parsePrivateDestinations(bad), bad).toThrow(/^ROSTERDOCK_PRIVATE_DESTINATIONS: /);
  });

  it("is the board's setting: nothing private without it, and no start on an entry it cannot read", () => {
    const env = { DATABASE_URL: "postgres://rosterdock@localhost/rosterdock" };
    expect(loadConfig(env).privateDestinations).toEqual(NO_PRIVATE_DESTINATIONS);
    expect(
      loadConfig({ ...env, ROSTERDOCK_PRIVATE_DESTINATIONS: "localhost,127.0.0.0/8,::1" }).privateDestinations
        .entries,
    ).toEqual(["localhost", "127.0.0.0/8", "::1"]);
    expect(() =>
      loadConfig({ ...env, ROSTERDOCK_PRIVATE_DESTINATIONS: "10.0.0.0/8 192.168.0.0/16" }),
    ).toThrow('ROSTERDOCK_PRIVATE_DESTINATIONS: "10.0.0.0/8 192.168.0.0/16" is not a host name');
  });

  it("admits an address in a listed range and nothing else; a public address needs no list", () => {
    const allow = parsePrivateDestinations("10.0.0.0/8,127.0.0.1,fd00::/8,172.16.5.9/12");
    for (const a of ["10.1.2.3", "127.0.0.1", "::ffff:10.9.9.9", "fd00:ec2::254", "172.20.0.1", "172.32.0.1"])
      expect(refuseDestination(a, allow), a).toBeNull();
    const refused: [string, RegExp][] = [
      ["127.0.0.2", /loopback/],
      ["192.168.1.1", /private/],
      ["169.254.169.254", /cloud metadata/],
      ["::1", /loopback/],
      ["fc00::1", /unique-local/],
    ];
    for (const [a, why] of refused) expect(refuseDestination(a, allow), a).toMatch(why);
    // Nothing listed: nothing private.
    expect(refuseDestination("10.1.2.3", NO_PRIVATE_DESTINATIONS)).toBe("a private address");
    expect(refuseDestination("127.0.0.1", NO_PRIVATE_DESTINATIONS)).toBe("a loopback address");
  });

  it("trusts a listed name with whatever it resolves to, and only that name", async () => {
    const allow = parsePrivateDestinations("ollama.internal,*.svc.cluster.local");
    const resolve = async () => ["10.0.0.7"];
    for (const host of ["ollama.internal", "OLLAMA.internal.", "mcp.tools.svc.cluster.local"])
      await expect(reachableAddresses(resolve, host, allow), host).resolves.toEqual(["10.0.0.7"]);
    for (const host of [
      "svc.cluster.local",
      "evilsvc.cluster.local",
      "ollama.internal.evil.test",
      "other.internal",
    ])
      await expect(reachableAddresses(resolve, host, allow), host).rejects.toThrow(
        `refused: ${host} resolves to 10.0.0.7, a private address, ${NOT_ALLOWED}`,
      );
    // A name nobody listed is judged by every address it has: one private address refuses it whole.
    await expect(
      reachableAddresses(async () => [PUBLIC_TEST_ADDRESS, "10.0.0.7"], "mixed.example.com", allow),
    ).rejects.toThrow(`refused: mixed.example.com resolves to 10.0.0.7, a private address, ${NOT_ALLOWED}`);
    await expect(
      reachableAddresses(async () => [PUBLIC_TEST_ADDRESS], "public.example.com", NO_PRIVATE_DESTINATIONS),
    ).resolves.toEqual([PUBLIC_TEST_ADDRESS]);
  });
});

/** A transport that records what it was sent and answers from a table; anything else is an empty 200. */
function transport(routes: Record<string, (init: RequestInit) => Response> = {}) {
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(init?.redirect).toBe("manual");
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const route = routes[url];
    return route ? route(init ?? {}) : new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fetch, calls };
}

const moved = (status: number, location: string) => () =>
  new Response(null, { status, headers: { location } });

const names: Record<string, string[]> = {
  localhost: ["127.0.0.1"],
  "intranet.example.com": ["10.0.0.5"],
  "internal.example.com": ["10.0.0.9"],
  "metadata.example.com": ["169.254.169.254"],
};
const resolve = async (host: string) => names[host] ?? [PUBLIC_TEST_ADDRESS];

describe("a company's destination through the egress", () => {
  it("refuses a private address before anything is sent: in the URL, or behind a name", async () => {
    const t = transport();
    const f = egressFetch(testEgress(t.fetch, { resolve }), { redirect: "error", timeoutMs: 2000 });
    await expect(f("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      `refused: 169.254.169.254 is a link-local address, where cloud metadata lives, ${NOT_ALLOWED}`,
    );
    await expect(f("http://[::1]:8080/mcp")).rejects.toThrow(
      `refused: ::1 is a loopback address, ${NOT_ALLOWED}`,
    );
    await expect(f("http://[::ffff:a9fe:a9fe]/")).rejects.toThrow(
      /refused: ::ffff:a9fe:a9fe is a link-local/,
    );
    await expect(f("https://intranet.example.com/mcp", { method: "POST", body: "{}" })).rejects.toThrow(
      `refused: intranet.example.com resolves to 10.0.0.5, a private address, ${NOT_ALLOWED}`,
    );
    await expect(f("http://localhost:3001/mcp")).rejects.toThrow(
      `refused: localhost resolves to 127.0.0.1, a loopback address, ${NOT_ALLOWED}`,
    );
    await expect(f("http://metadata.example.com/")).rejects.toBeInstanceOf(RefusedAddress);
    await expect(f("file:///etc/passwd")).rejects.toThrow(
      "refused: file is not reached, only http and https",
    );
    await expect(f("https://user:pw@api.example.com/")).rejects.toThrow(
      "refused: a URL with credentials in it; give the credential by name instead",
    );
    await expect(f("https://public.example.com/")).resolves.toBeInstanceOf(Response);
    expect(t.calls.map((c) => c.url)).toEqual(["https://public.example.com/"]);
  });

  it("reaches what the operator lists, and nothing beside it", async () => {
    const t = transport();
    const f = egressFetch(testEgress(t.fetch, { resolve, allow: "localhost,10.0.0.5" }), {
      redirect: "error",
      timeoutMs: 2000,
    });
    expect((await f("http://localhost:3001/mcp")).status).toBe(200);
    expect((await f("https://intranet.example.com/mcp")).status).toBe(200);
    expect((await f("http://10.0.0.5:8080/")).status).toBe(200);
    await expect(f("https://internal.example.com/")).rejects.toThrow(
      `refused: internal.example.com resolves to 10.0.0.9, a private address, ${NOT_ALLOWED}`,
    );
    await expect(f("http://127.0.0.1:3001/")).rejects.toThrow(
      `refused: 127.0.0.1 is a loopback address, ${NOT_ALLOWED}`,
    );
    expect(t.calls.map((c) => c.url)).toEqual([
      "http://localhost:3001/mcp",
      "https://intranet.example.com/mcp",
      "http://10.0.0.5:8080/",
    ]);
  });

  it("checks every redirect hop again: a hop to a private address is never sent", async () => {
    const t = transport({
      "https://auth.example.com/.well-known/oauth-authorization-server": moved(
        302,
        "http://169.254.169.254/latest",
      ),
      "https://auth.example.com/b": moved(301, "https://internal.example.com/c"),
    });
    const follow = egressFetch(testEgress(t.fetch, { resolve }), { redirect: "follow", timeoutMs: 2000 });
    await expect(follow("https://auth.example.com/.well-known/oauth-authorization-server")).rejects.toThrow(
      `refused: 169.254.169.254 is a link-local address, where cloud metadata lives, ${NOT_ALLOWED}`,
    );
    await expect(follow("https://auth.example.com/b")).rejects.toThrow(
      `refused: internal.example.com resolves to 10.0.0.9, a private address, ${NOT_ALLOWED}`,
    );
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/b",
    ]);
  });

  it("follows a public redirect as fetch does: a 303 reads, the credential stays at its origin, three hops at most", async () => {
    const t = transport({
      "https://a.example.com/token": moved(303, "/done"),
      "https://a.example.com/x": moved(307, "https://b.example.com/y"),
      "https://a.example.com/loop": moved(302, "/loop"),
    });
    const follow = egressFetch(testEgress(t.fetch, { resolve }), { redirect: "follow", timeoutMs: 2000 });
    const auth = { authorization: "Bearer a-token-000000", "content-type": "application/json" };
    expect(
      (await follow("https://a.example.com/token", { method: "POST", headers: auth, body: "{}" })).status,
    ).toBe(200);
    expect(t.calls[1]).toMatchObject({ url: "https://a.example.com/done", method: "GET", body: undefined });
    expect(t.calls[1]!.headers.get("authorization")).toBe("Bearer a-token-000000");
    expect(t.calls[1]!.headers.get("content-type")).toBeNull();
    await follow("https://a.example.com/x", { method: "PUT", headers: auth, body: "{}" });
    expect(t.calls[3]).toMatchObject({ url: "https://b.example.com/y", method: "PUT", body: "{}" });
    expect(t.calls[3]!.headers.get("authorization")).toBeNull();
    t.calls.length = 0;
    await expect(follow("https://a.example.com/loop")).rejects.toThrow(
      "a.example.com redirected more than 3 times",
    );
    expect(t.calls).toHaveLength(4);
  });

  it("refuses a redirect where the call site says so, naming no more than the host, and hands one back where it asks", async () => {
    const hook = "https://hooks.example.com/services/T0/B0/secret-token-000";
    const t = transport({
      [hook]: moved(307, "https://other.example.com/services/T0/B0/secret-token-000?token=abc"),
      "https://mcp.example.com/mcp": moved(308, "https://mcp.example.com/mcp/"),
    });
    const egress = testEgress(t.fetch, { resolve });
    const refuse = egressFetch(egress, { redirect: "error", timeoutMs: 2000 });
    const err = await refuse(hook, { method: "POST", body: "{}" }).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "hooks.example.com answered 307, a redirect to other.example.com, which the board does not follow here: use the address it points to",
    );
    await expect(refuse("https://mcp.example.com/mcp", { method: "POST", body: "{}" })).rejects.toThrow(
      "mcp.example.com answered 308, a redirect to another address on the same host, which the board does not follow here",
    );
    const handed = await egressFetch(egress, { redirect: "manual", timeoutMs: 2000 })(hook);
    expect(handed.status).toBe(307);
    expect(t.calls.map((c) => c.url)).toEqual([hook, "https://mcp.example.com/mcp", hook]);
  });

  it("gives up at the deadline, a name that never resolves included, and leaves a stream open once its headers are in", async () => {
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as typeof fetch;
    // A body that sends one chunk now and the next after the deadline, and stops when the request is aborted.
    const slowBody = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("one "));
            const timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("two"));
              controller.close();
            }, 1300);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              controller.error(new Error("aborted"));
            });
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const never = async () => new Promise<string[]>(() => {});
    const opts = { redirect: "error", timeoutMs: 1000 } as const;
    const [slowDns, slowServer, streamed, whole] = await Promise.allSettled([
      egressFetch(testEgress(hang, { resolve: never }), opts)("https://slow-dns.example.com/"),
      egressFetch(testEgress(hang, { resolve }), opts)("https://slow.example.com/"),
      egressFetch(testEgress(slowBody, { resolve }), { ...opts, stream: true })(
        "https://events.example.com/",
      ).then((r) => r.text()),
      egressFetch(
        testEgress(slowBody, { resolve }),
        opts,
      )("https://events.example.com/").then((r) => r.text()),
    ]);
    expect(slowDns).toMatchObject({
      status: "rejected",
      reason: new Error("slow-dns.example.com gave no answer in 1s"),
    });
    expect(slowServer).toMatchObject({
      status: "rejected",
      reason: new Error("slow.example.com gave no answer in 1s"),
    });
    expect(streamed).toEqual({ status: "fulfilled", value: "one two" });
    expect(whole.status).toBe("rejected");
  });
});

describe("the pinned transport for a company's destinations", () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  let release: (() => void) | null = null;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.headers.host} ${req.url}`);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/echo") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              contentType: req.headers["content-type"],
              contentLength: req.headers["content-length"],
              body,
            }),
          );
        } else if (req.url === "/events") {
          // One event now, the next only when the test says: a transport that waited for the end would hang.
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write("event: message\ndata: one\n\n");
          release = () => res.end("event: message\ndata: two\n\n");
        } else if (req.url === "/mcp") mcpServer(req.method!, body, res);
        else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });

  const loopback = parsePrivateDestinations("127.0.0.1");
  const toServer = async () => ["127.0.0.1"];

  it("sends a body whole to an address the operator lists, and refuses at the socket what the check would refuse", async () => {
    const allowed = egressFetch(boardEgress(loopback, toServer), { redirect: "error", timeoutMs: 5000 });
    const echo = await allowed(`http://echo.test:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(await echo.json()).toEqual({
      method: "POST",
      contentType: "application/json",
      contentLength: "46",
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    const form = await allowed(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token" }),
    });
    expect(await form.json()).toMatchObject({
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      body: "grant_type=refresh_token",
    });
    seen.length = 0;
    // Nothing listed: the check refuses before anything is sent.
    await expect(
      egressFetch(boardEgress(NO_PRIVATE_DESTINATIONS, toServer), { redirect: "error", timeoutMs: 5000 })(
        `http://echo.test:${port}/echo`,
      ),
    ).rejects.toThrow(`refused: echo.test resolves to 127.0.0.1, a loopback address, ${NOT_ALLOWED}`);
    // A name that answers the check with a public address and the socket with this one (DNS rebinding): the
    // socket connects only to what its own lookup admitted, so nothing reaches the server.
    let asked = 0;
    const rebinding = async () => (asked++ === 0 ? [PUBLIC_TEST_ADDRESS] : ["127.0.0.1"]);
    await expect(
      egressFetch(boardEgress(NO_PRIVATE_DESTINATIONS, rebinding), { redirect: "error", timeoutMs: 5000 })(
        `http://rebind.test:${port}/echo`,
      ),
    ).rejects.toThrow(`refused: rebind.test resolves to 127.0.0.1, a loopback address, ${NOT_ALLOWED}`);
    // And the transport on its own refuses an address in the URL the list does not take.
    await expect(
      boardEgress(NO_PRIVATE_DESTINATIONS, toServer).fetch(`http://127.0.0.1:${port}/echo`),
    ).rejects.toThrow(`refused: 127.0.0.1 is a loopback address, ${NOT_ALLOWED}`);
    expect(seen).toEqual([]);
  });

  it("streams an event stream as it arrives, past the deadline once its headers are in", async () => {
    const f = egressFetch(boardEgress(loopback, toServer), {
      redirect: "error",
      timeoutMs: 300,
      stream: true,
    });
    const res = await f(`http://events.test:${port}/events`, { headers: { accept: "text/event-stream" } });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe("event: message\ndata: one\n\n");
    await new Promise((r) => setTimeout(r, 500));
    release!();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      rest += decoder.decode(chunk.value);
    expect(rest).toBe("event: message\ndata: two\n\n");
  });

  it("carries MCP's streamable HTTP, its answers as event streams, to a listed name and to no other", async () => {
    const target = { transport: "http" as const, url: `http://mcp.cluster.test:${port}/mcp` };
    const tools = await discoverTools(target, {
      egress: boardEgress(parsePrivateDestinations("*.cluster.test"), toServer),
      timeoutMs: 5000,
    });
    expect(tools.map((t) => t.name)).toEqual(["whoami"]);
    expect(seen.filter((s) => s.startsWith("POST")).length).toBeGreaterThanOrEqual(3);
    seen.length = 0;
    await expect(
      discoverTools(target, {
        egress: boardEgress(parsePrivateDestinations("*.other.test"), toServer),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(`refused: mcp.cluster.test resolves to 127.0.0.1, a loopback address, ${NOT_ALLOWED}`);
    expect(seen).toEqual([]);
  });
});

/**
 * Just enough of an MCP server over streamable HTTP: every answer is an event stream, and the answer to
 * tools/list is never ended, so a client gets it only if the transport hands the stream on as it arrives.
 */
function mcpServer(method: string, raw: string, res: http.ServerResponse): void {
  if (method !== "POST") {
    res.writeHead(method === "DELETE" ? 200 : 405);
    res.end();
    return;
  }
  const msg = JSON.parse(raw) as { id?: number; method: string; params?: { protocolVersion?: string } };
  if (msg.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const result =
    msg.method === "initialize"
      ? {
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "egress-test", version: "1.0.0" },
        }
      : msg.method === "tools/list"
        ? { tools: [{ name: "whoami", description: "Who the token is", inputSchema: { type: "object" } }] }
        : {};
  res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" });
  res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
  if (msg.method !== "tools/list") res.end();
}
