// The address rules without node: they recognise an address exactly as node's own isIP does, so the board
// (which resolves with node) and the web (which has no node) read every host the same way.
import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import {
  addressListed,
  forCompany,
  hostListed,
  isAddress,
  parsePrivateDestinations,
  refuseAddress,
  refuseDestination,
} from "../src/address.js";

describe("addresses without node", () => {
  it("recognises an address exactly as node does", () => {
    const corpus = [
      "127.0.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "256.0.0.1",
      "01.2.3.4",
      "1.2.3",
      "1.2.3.4.5",
      " 1.2.3.4",
      "::",
      "::1",
      "1::",
      "1:2:3:4:5:6:7:8",
      "1:2:3:4:5:6:7::",
      "::1:2:3:4:5:6:7",
      "::1:2:3:4:5:6:7:8",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      ":::",
      ":1",
      "1:",
      "fe80::1%eth0",
      "::ffff:127.0.0.1",
      "::ffff:127.0.0",
      "::127.0.0.1",
      "64:ff9b::10.0.0.1",
      "1:2:3:4:5:6:1.2.3.4",
      "1:2:3:4:5:6:7:1.2.3.4",
      "12345::1",
      "g::1",
      "localhost",
      "example.com",
      "",
    ];
    for (const text of corpus) expect(isAddress(text), JSON.stringify(text)).toBe(isIP(text) !== 0);
    // What isn't an address is refused whole.
    expect(refuseAddress("1::2::3")).toBe("not an address");
  });

  it("reads an IPv4 range written as IPv6 as that IPv4 range", () => {
    const allow = parsePrivateDestinations("::ffff:192.168.7.0/120,[64:ff9b::10.1.0.0]/112");
    expect(addressListed("192.168.7.9", allow)).toBe(true);
    expect(addressListed("::ffff:192.168.7.200", allow)).toBe(true);
    expect(addressListed("192.168.8.1", allow)).toBe(false);
    expect(refuseDestination("10.1.4.5", allow)).toBeNull();
    expect(refuseDestination("10.2.0.1", allow)).toBe("a private address");
    expect(() => parsePrivateDestinations("::ffff:10.0.0.0/129")).toThrow(
      "no prefix length from /96 to /128",
    );
    expect(() => parsePrivateDestinations("::ffff:10.0.0.0/95")).toThrow("is every IPv4 address there is");
    for (const all of ["::ffff:0:0/96", "64:ff9b::/96", "[64:ff9b::]/96"])
      expect(() => parsePrivateDestinations(all), all).toThrow("is every IPv4 address there is");
  });

  it("keeps what the operator gives one company for that company alone", () => {
    const a = "4f1aee73-e65e-4c8d-83f7-aa1169379d7f";
    const b = "0b6c1f0e-27f4-4a8e-9a43-3d5c4c6c1d2e";
    const allow = parsePrivateDestinations(
      `10.20.0.0/16, ${a.toUpperCase()}=ollama.ai.svc.cluster.local, ${a}=10.30.0.0/16, ${b} = 192.168.5.5`,
    );
    expect(allow.entries).toEqual(["10.20.0.0/16"]);
    expect(Object.keys(allow.companies ?? {})).toEqual([a, b]);
    // Nobody narrowed the list: only what every company may reach counts.
    expect(hostListed("ollama.ai.svc.cluster.local", allow)).toBe(false);
    expect(refuseDestination("10.30.0.1", allow)).toBe("a private address");
    expect(refuseDestination("10.20.0.1", allow)).toBeNull();
    // Narrowed to a company: its own, and every company's.
    const forA = forCompany(allow, a);
    expect(forA.entries).toEqual(["10.20.0.0/16", "ollama.ai.svc.cluster.local", "10.30.0.0/16"]);
    expect(hostListed("ollama.ai.svc.cluster.local", forA)).toBe(true);
    expect(refuseDestination("10.30.0.1", forA)).toBeNull();
    expect(refuseDestination("192.168.5.5", forA)).toBe("a private address");
    const forB = forCompany(allow, b.toUpperCase());
    expect(hostListed("ollama.ai.svc.cluster.local", forB)).toBe(false);
    expect(refuseDestination("192.168.5.5", forB)).toBeNull();
    // A narrowed list is that company's: narrowing it to another refuses rather than hand over its entries.
    expect(forA.companies).toBeUndefined();
    expect(forCompany(forA, a.toUpperCase())).toBe(forA);
    expect(() => forCompany(forA, b)).toThrow("narrowed to one company was narrowed to another");
    // An entry the operator gave a company and every company is listed once.
    expect(forCompany(parsePrivateDestinations(`10.20.0.0/16,${a}=10.20.0.0/16`), a).entries).toEqual([
      "10.20.0.0/16",
    ]);
    expect(forCompany(allow, "1b2c3d4e-0000-4000-8000-000000000000").entries).toEqual(["10.20.0.0/16"]);
    for (const bad of [
      `acme=ollama.internal`,
      `=ollama.internal`,
      `${a}=`,
      `${a}=http://x.internal`,
      `${a}=*`,
    ])
      expect(() => parsePrivateDestinations(bad), bad).toThrow(/^ROSTERDOCK_PRIVATE_DESTINATIONS: /);
  });
});
