// The address rules without node: they recognise an address exactly as node's own isIP does, so the board
// (which resolves with node) and the web (which has no node) read every host the same way.
import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import {
  addressListed,
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
});
