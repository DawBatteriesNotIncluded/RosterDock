import { describe, expect, it } from "vitest";
import {
  ClientPolicySchema,
  CreateConnectionSchema,
  domainList,
  domainsPhrase,
  effectiveWebDomains,
  hostOnList,
  narrowDomains,
  normalizeDomain,
  SandboxPresetSchema,
  UpdateConnectionSchema,
} from "../src/index.js";

describe("web domain lists", () => {
  it("keeps a domain however a person typed it, and refuses what is not one", () => {
    for (const [typed, kept] of [
      ["example.com", "example.com"],
      ["  Docs.Example.COM ", "docs.example.com"],
      ["*.example.com", "example.com"],
      [".example.com", "example.com"],
      ["https://example.com/path?q=1#top", "example.com"],
      ["example.com:8443", "example.com"],
      ["example.com.", "example.com"],
      ["bücher.de", "xn--bcher-kva.de"],
      ["123.com", "123.com"],
    ] as const)
      expect(normalizeDomain(typed), typed).toBe(kept);
    for (const bad of [
      "",
      "localhost",
      "10.0.0.1",
      "0x7f.1",
      "[::1]",
      "user@example.com",
      "exa mple.com",
      "ex_ample.com",
      "-example.com",
      `${"a".repeat(64)}.com`,
    ])
      expect(normalizeDomain(bad), bad).toBeNull();
  });

  it("reads a stored list once each, and an empty list as no list", () => {
    expect(domainList(["Example.com", "example.com", "nope", 3, "docs.example.org"])).toEqual([
      "example.com",
      "docs.example.org",
    ]);
    expect(domainList([])).toBeNull();
    expect(domainList(null)).toBeNull();
    expect(domainList("example.com")).toBeNull();
  });

  it("a domain covers the sites under it, and nothing that only ends like it", () => {
    expect(hostOnList("example.com", ["example.com"])).toBe(true);
    expect(hostOnList("docs.example.com", ["example.com"])).toBe(true);
    expect(hostOnList("DOCS.EXAMPLE.COM.", ["example.com"])).toBe(true);
    expect(hostOnList("badexample.com", ["example.com"])).toBe(false);
    expect(hostOnList("example.com.evil.org", ["example.com"])).toBe(false);
    expect(hostOnList("example.com", ["docs.example.com"])).toBe(false);
    expect(hostOnList("anything.org", null)).toBe(true);
    expect(hostOnList("anything.org", [])).toBe(false);
  });

  it("narrowing keeps only the sites both lists allow, and never widens", () => {
    expect(narrowDomains(null, null)).toBeNull();
    expect(narrowDomains(null, ["example.com"])).toEqual(["example.com"]);
    expect(narrowDomains(["example.com"], null)).toEqual(["example.com"]);
    // The narrower of a domain and one under it.
    expect(narrowDomains(["example.com"], ["docs.example.com"])).toEqual(["docs.example.com"]);
    expect(narrowDomains(["docs.example.com"], ["example.com"])).toEqual(["docs.example.com"]);
    // A list cannot add a site the other does not allow.
    expect(narrowDomains(["example.com"], ["example.com", "other.org"])).toEqual(["example.com"]);
    expect(narrowDomains(["example.com"], ["other.org"])).toEqual([]);
    expect(narrowDomains([], ["example.com"])).toEqual([]);
    // A domain under one already kept adds nothing.
    expect(narrowDomains(["example.com", "docs.example.com"], ["example.com"])).toEqual(["example.com"]);
  });

  it("the company's list is the ceiling; the department narrows it, then the client", () => {
    expect(effectiveWebDomains({ company: null })).toEqual({ domains: null, narrowedBy: [] });
    expect(effectiveWebDomains({ company: [], department: [], client: [] })).toEqual({
      domains: null,
      narrowedBy: [],
    });
    expect(effectiveWebDomains({ company: null, department: ["gong.io"], client: ["help.gong.io"] })).toEqual(
      { domains: ["help.gong.io"], narrowedBy: ["department", "client"] },
    );
    expect(
      effectiveWebDomains({ company: ["gong.io", "hubspot.com"], department: ["gong.io", "evil.org"] }),
    ).toEqual({ domains: ["gong.io"], narrowedBy: ["department"] });
    // A list that allows what the company's does already narrows nothing.
    expect(effectiveWebDomains({ company: ["gong.io"], department: ["gong.io"], client: null })).toEqual({
      domains: ["gong.io"],
      narrowedBy: [],
    });
    // Disjoint lists leave no site.
    expect(effectiveWebDomains({ company: ["gong.io"], client: ["hubspot.com"] })).toEqual({
      domains: [],
      narrowedBy: ["client"],
    });
    expect(domainsPhrase(null)).toBe("any public site");
    expect(domainsPhrase([])).toBe("no site");
    expect(domainsPhrase(["gong.io"])).toBe("only gong.io and the sites under it");
  });

  it("the schemas keep the domains normalised and refuse what is not one", () => {
    expect(
      CreateConnectionSchema.parse({
        name: "web",
        kind: "web",
        domains: ["*.Gong.io", "https://hubspot.com/x"],
      }).domains,
    ).toEqual(["gong.io", "hubspot.com"]);
    expect(UpdateConnectionSchema.safeParse({ domains: ["localhost"] }).success).toBe(false);
    expect(UpdateConnectionSchema.parse({ domains: null }).domains).toBeNull();
    expect(SandboxPresetSchema.parse({ webDomains: ["Docs.Gong.io"] }).webDomains).toEqual(["docs.gong.io"]);
    expect(ClientPolicySchema.parse({ webDomains: ["gong.io"] })).toEqual({
      default: null,
      caps: {},
      webDomains: ["gong.io"],
    });
    // A policy without a list says nothing about the web, as before.
    expect(ClientPolicySchema.parse({})).toEqual({ default: null, caps: {} });
  });
});
