import { describe, expect, it } from "vitest";
import { canonicalJson, payloadSha256, sha256Hex, verifyActionBinding } from "../src/index.js";

describe("sha256Hex", () => {
  it("matches the known vector for the empty string and for abc", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("canonicalJson / payloadSha256", () => {
  it("is independent of key order at every level", () => {
    const a = {
      tool: "n8n.activate_workflow",
      input: { workflowId: "W1", dryRun: false },
      credential: "N8N_API",
    };
    const b = {
      credential: "N8N_API",
      input: { dryRun: false, workflowId: "W1" },
      tool: "n8n.activate_workflow",
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadSha256(a)).toBe(payloadSha256(b));
  });

  it("changes when any byte of the payload changes", () => {
    const base = { input: { invoiceIds: ["INV-0912", "INV-0917"] } };
    const drifted = { input: { invoiceIds: ["INV-0912", "INV-0918"] } };
    expect(payloadSha256(base)).not.toBe(payloadSha256(drifted));
  });

  it("keeps array order (arrays are not sets)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("verifyActionBinding", () => {
  const content = '{"workflowId":"W1"}';
  const binding = {
    artifactId: "art-1",
    sha256: sha256Hex(content),
    targetTool: "activate_workflow",
    targetServer: "n8n",
    intendedAction: "activate",
  };

  it("passes when everything matches", () => {
    const check = verifyActionBinding(binding, {
      artifactId: "art-1",
      artifactContent: content,
      targetTool: "activate_workflow",
      targetServer: "n8n",
      intendedAction: "activate",
    });
    expect(check).toEqual({ ok: true, mismatches: [] });
  });

  it("lists every drift, including a single changed byte", () => {
    const check = verifyActionBinding(binding, {
      artifactId: "art-2",
      artifactContent: '{"workflowId":"W2"}',
      targetTool: "delete_workflow",
      targetServer: "n8n-staging",
      intendedAction: "delete",
    });
    expect(check.ok).toBe(false);
    expect(check.mismatches).toHaveLength(5);
    expect(check.mismatches.join("\n")).toMatch(/sha256 mismatch/);
  });
});
