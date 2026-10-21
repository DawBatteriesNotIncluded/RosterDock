// The board's web reads: which addresses it refuses, how a name is resolved and checked (every address,
// on every hop), and the transport that connects only to what was checked. The resolver and the fetch are
// fakes; the transport's own test talks to a server on 127.0.0.1 only. No network.
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPage } from "../src/reviews/sources.js";
import { publicAddresses, refuseAddress, type Resolve } from "../src/web/address.js";
import { guardedLookup, pinnedFetch } from "../src/web/transport.js";

describe("which addresses the board reads the web at", () => {
  it("takes public addresses, IPv4 and IPv6, and an IPv4 written as IPv6 by its IPv4", () => {
    for (const a of [
      "93.184.215.14",
      "8.8.8.8",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "169.253.255.255",
      "2606:4700:4700::1111",
      "::ffff:93.184.215.14",
      "64:ff9b::808:808",
      "2002:5db8:d70e::1",
    ])
      expect(refuseAddress(a), a).toBeNull();
  });

  it("refuses loopback, private, link-local, unique-local, metadata and every other special address", () => {
    const refused: [string, RegExp][] = [
      ["127.0.0.1", /loopback/],
      ["127.255.1.2", /loopback/],
      ["10.1.2.3", /private/],
      ["172.16.0.1", /private/],
      ["172.31.255.255", /private/],
      ["192.168.1.1", /private/],
      ["169.254.169.254", /link-local address, where cloud metadata lives/],
      ["100.100.100.200", /shared/],
      ["0.0.0.0", /unspecified/],
      ["255.255.255.255", /reserved/],
      ["224.0.0.1", /multicast/],
      ["198.18.0.1", /reserved/],
      ["192.0.2.1", /documentation/],
      ["::1", /loopback/],
      ["::", /unspecified/],
      ["fe80::1", /link-local/],
      ["fe80::1%eth0", /link-local/],
      ["fc00::1", /unique-local/],
      ["fd00:ec2::254", /unique-local/],
      ["ff02::1", /multicast/],
      ["::ffff:127.0.0.1", /loopback address \(as IPv6\)/],
      ["::ffff:a9fe:a9fe", /link-local/],
      ["64:ff9b::a00:1", /private/],
      ["2002:a00:1::1", /private address \(in a 6to4 address\)/],
      ["2001:db8::1", /documentation/],
      ["2001::1", /Teredo/],
      ["100::1", /reserved/],
      ["not-an-address", /not an address/],
    ];
    for (const [a, why] of refused) expect(refuseAddress(a), a).toMatch(why);
  });

  it("refuses a name whole when any address it resolves to is not public, or when it has none", async () => {
    const resolve: Resolve = async (host) =>
      ({
        "public.example.com": ["93.184.215.14", "2606:4700:4700::1111"],
        "mixed.example.com": ["93.184.215.14", "10.0.0.5"],
        "empty.example.com": [],
      })[host] ??
      Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
    expect(await publicAddresses(resolve, "public.example.com")).toEqual([
      "93.184.215.14",
      "2606:4700:4700::1111",
    ]);
    await expect(publicAddresses(resolve, "mixed.example.com")).rejects.toThrow(
      "mixed.example.com resolves to 10.0.0.5, a private address; the board reads only public addresses",
    );
    await expect(publicAddresses(resolve, "empty.example.com")).rejects.toThrow("does not resolve");
    await expect(publicAddresses(resolve, "nowhere.example.com")).rejects.toThrow(
      "nowhere.example.com does not resolve (ENOTFOUND)",
    );
  });

  it("hands a socket only the addresses it checked, of the family it asks for", async () => {
    const lookup = guardedLookup(async () => ["93.184.215.14", "2606:4700:4700::1111"]);
    const ask = (options: { all?: boolean; family?: number }) =>
      new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
        lookup("public.example.com", options, (err, address, family) => resolve({ err, address, family })),
      );
    expect((await ask({ all: true })).address).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(await ask({ family: 6 })).toMatchObject({ err: null, address: "2606:4700:4700::1111", family: 6 });
    const refused = guardedLookup(async () => ["93.184.215.14", "127.0.0.1"]);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      refused("rebind.example.com", { all: true }, (e) => resolve(e)),
    );
    expect(err?.code).toBe("EREFUSED");
    expect(err?.message).toContain("rebind.example.com resolves to 127.0.0.1, a loopback address");
  });
});

describe("the pinned transport", () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      if (req.url === "/page") res.end("<html><title>Hello</title><p>From the test server.</p></html>");
      else if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(zlib.gzipSync("compressed text"));
      } else if (req.url === "/moved") {
        res.writeHead(302, { location: "http://elsewhere.test/" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // Only for these tests: every name is the test server. The guard is tested on its own above and below.
  const toTestServer = guardedLookupFor(["127.0.0.1"]);

  it("reads a page, decodes a compressed one, and follows no redirect", async () => {
    const f = pinnedFetch(toTestServer);
    const page = await f(`http://site.test:${port}/page`, { method: "GET" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("From the test server.");
    const gz = await f(`http://site.test:${port}/gzip`, {});
    expect(await gz.text()).toBe("compressed text");
    const moved = await f(`http://site.test:${port}/moved`, {});
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("http://elsewhere.test/");
    expect(seen).toContain(`site.test:${port} /page`);
    expect(seen.some((s) => s.startsWith("elsewhere.test"))).toBe(false);
  });

  it("never connects to an address the guard refuses, nor to a literal address", async () => {
    seen.length = 0;
    const guarded = pinnedFetch(guardedLookup(async () => ["127.0.0.1"]));
    await expect(guarded(`http://rebind.example.com:${port}/page`, {})).rejects.toThrow(
      /rebind\.example\.com resolves to 127\.0\.0\.1, a loopback address/,
    );
    await expect(pinnedFetch(toTestServer)(`http://127.0.0.1:${port}/page`, {})).rejects.toThrow(
      "a literal address is not fetched",
    );
    expect(seen).toEqual([]);
  });
});

/** A lookup that answers every name with these addresses, unchecked: the test server's, in the transport's test. */
function guardedLookupFor(addresses: string[]): Parameters<typeof pinnedFetch>[0] {
  return (_host, options, callback) => {
    const list = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  };
}

describe("one page through the guard", () => {
  const web = (routes: Record<string, () => Response>, names: Record<string, string[]>) => {
    const calls: string[] = [];
    return {
      calls,
      reader: {
        resolve: async (host: string) => names[host] ?? ["93.184.215.14"],
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push(url);
          expect(init?.redirect).toBe("manual");
          const route = routes[url];
          if (!route) return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
          return route();
        }) as typeof fetch,
      },
    };
  };
  const req = (url: string, more: Partial<Parameters<typeof fetchPage>[1]> = {}) => ({
    url,
    timeoutMs: 2000,
    maxBytes: 64 * 1024,
    userAgent: "test",
    ...more,
  });
  const html = (body: string, type = "text/html") =>
    new Response(body, { status: 200, headers: { "content-type": type } });

  it("refuses a name that resolves to a private address, before anything is sent", async () => {
    const { reader, calls } = web({}, { "intranet.example.com": ["10.0.0.5"] });
    const page = await fetchPage(reader, req("https://intranet.example.com/wiki"));
    expect(page).toMatchObject({ ok: false, status: null, bytes: 0, text: null });
    expect(page.note).toBe(
      "intranet.example.com resolves to 10.0.0.5, a private address; the board reads only public addresses",
    );
    expect(calls).toEqual([]);
  });

  it("checks every redirect hop the same way: a hop to metadata or to a literal address is refused", async () => {
    const { reader, calls } = web(
      {
        "https://docs.example.com/a": () =>
          new Response(null, { status: 301, headers: { location: "http://meta.example.org/latest" } }),
        "https://docs.example.com/b": () =>
          new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
        "https://docs.example.com/c": () => new Response(null, { status: 302, headers: { location: "/a" } }),
      },
      { "meta.example.org": ["169.254.169.254"] },
    );
    const viaName = await fetchPage(reader, req("https://docs.example.com/a"));
    expect(viaName.note).toBe(
      "redirected to http://meta.example.org/latest: meta.example.org resolves to 169.254.169.254, a link-local address, where cloud metadata lives; the board reads only public addresses",
    );
    expect(viaName.finalUrl).toBe("http://meta.example.org/latest");
    const viaLiteral = await fetchPage(reader, req("https://docs.example.com/b"));
    expect(viaLiteral.note).toBe(
      "redirected to http://169.254.169.254/latest: a literal address is not fetched",
    );
    // Two redirects deep, the refused hop is refused all the same.
    expect((await fetchPage(reader, req("https://docs.example.com/c"))).note).toContain(
      "redirected to http://meta.example.org/latest: meta.example.org resolves to 169.254.169.254",
    );
    expect(calls.filter((c) => c.includes("169.254") || c.includes("meta.example.org"))).toEqual([]);
  });

  it("asks the host check on every hop, so a redirect cannot leave a company's sites", async () => {
    const { reader, calls } = web(
      {
        "https://docs.gong.io/x": () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } }),
      },
      {},
    );
    const onList = (host: string) =>
      host.endsWith("gong.io") ? null : `${host} is not on this company's list`;
    const page = await fetchPage(reader, req("https://docs.gong.io/x", { hostRefusal: onList }));
    expect(page.note).toBe(
      "redirected to https://evil.example.net/: evil.example.net is not on this company's list",
    );
    expect(calls).toEqual(["https://docs.gong.io/x"]);
    expect((await fetchPage(reader, req("https://other.org/", { hostRefusal: onList }))).note).toBe(
      "other.org is not on this company's list",
    );
  });

  it("cuts a body at the cap, reads the charset the server names, and redacts secret-shaped strings", async () => {
    const { reader } = web(
      {
        "https://big.example.com/": () => html(`<p>${"a".repeat(100_000)}</p>`),
        "https://latin.example.com/": () =>
          new Response(Buffer.from("<p>Caf\xe9 cr\xe8me</p>", "latin1"), {
            status: 200,
            headers: { "content-type": "text/html; charset=iso-8859-1" },
          }),
        "https://leak.example.com/": () =>
          html(
            "<title>ghp_0123456789abcdefghijklmnopqrstuvwxyz</title><p>key: sk-ant-api03-FAKE0123456789abcdefghij</p>",
          ),
      },
      {},
    );
    const big = await fetchPage(reader, req("https://big.example.com/", { maxBytes: 1024 }));
    expect(big).toMatchObject({ ok: true, status: 200, bytes: 1024, cut: true });
    const latin = await fetchPage(reader, req("https://latin.example.com/"));
    expect(latin.text).toBe("Café crème");
    const leak = await fetchPage(reader, req("https://leak.example.com/"));
    expect(leak.title).toBe("[redacted]");
    expect(leak.text).toBe("key: [redacted]");
  });

  it("gives up at the deadline", async () => {
    const reader = {
      resolve: async () => ["93.184.215.14"],
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        )) as typeof fetch,
    };
    const page = await fetchPage(reader, req("https://slow.example.com/", { timeoutMs: 1000 }));
    expect(page.note).toBe("no answer in 1s");
  });
});
