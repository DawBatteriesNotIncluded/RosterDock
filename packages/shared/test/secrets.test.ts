import { describe, expect, it } from "vitest";
import {
  assertNoRawSecrets,
  containsRawSecret,
  findRawSecrets,
  isEnvVarName,
  looksLikeRawSecret,
  RawSecretError,
  redactRawSecrets,
} from "../src/index.js";

describe("looksLikeRawSecret", () => {
  it("accepts references: env-var names, vault paths, short handles", () => {
    for (const ref of [
      "N8N_API_KEY",
      "HUBSPOT_APP",
      "vault://kv/gtm/n8n",
      "secrets/prod/slack",
      "XERO_TENANT",
    ]) {
      expect(looksLikeRawSecret(ref), ref).toBe(false);
    }
  });

  it("rejects key-shaped values", () => {
    const samples = [
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "github_pat_11ABCDEFG",
      "xoxb-123-456-abc",
      "AKIAIOSFODNN7EXAMPLE",
      "Bearer abcdefghijklmnop.qrstuvwxyz0123",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
      // prefix-less base64-ish blob (Azure/AWS style secret)
      "Q2xhdWRlIGlzIGEgZ29vZCBhc3Npc3RhbnQgYW5kIHRoaXMgaXMgYSBrZXk=",
      "x".repeat(129),
    ];
    for (const sample of samples) expect(looksLikeRawSecret(sample), sample.slice(0, 12)).toBe(true);
  });
});

describe("isEnvVarName", () => {
  it("matches shell-style names only", () => {
    expect(isEnvVarName("OPENAI_API_KEY")).toBe(true);
    expect(isEnvVarName("_x1")).toBe(true);
    expect(isEnvVarName("1abc")).toBe(false);
    expect(isEnvVarName("has-dash")).toBe(false);
    expect(isEnvVarName("vault://x")).toBe(false);
  });
});

describe("findRawSecrets / assertNoRawSecrets", () => {
  it("walks nested payloads and reports paths, never values", () => {
    const payload = {
      name: "n8n",
      credentialRef: "N8N_API_KEY",
      settings: { apiKey: "sk-live-0123456789abcdef0123456789", nested: [{ token: "xoxb-1-2-3" }] },
      notes: "Bearer tokens must never be pasted here",
    };
    const findings = findRawSecrets(payload);
    expect(findings.map((f) => f.path)).toEqual(["settings.apiKey", "settings.nested[0].token"]);
    expect(() => assertNoRawSecrets(payload)).toThrow(RawSecretError);
    try {
      assertNoRawSecrets(payload);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("settings.apiKey");
      expect(message).not.toContain("sk-live");
      expect(message).not.toContain("xoxb");
    }
  });

  it("does not reject prose or long descriptions in non-reference fields", () => {
    const payload = {
      personaMd: "You are a senior n8n automation engineer. ".repeat(20),
      description: "Q2xhdWRlIGlzIGEgZ29vZCBhc3Npc3RhbnQgYW5kIHRoaXMgaXMgYSBrZXk=",
      credentialRef: "vault://kv/gtm/n8n",
    };
    expect(findRawSecrets(payload)).toEqual([]);
    expect(() => assertNoRawSecrets(payload)).not.toThrow();
  });

  it("applies the stricter reference check under secret-shaped keys", () => {
    expect(findRawSecrets({ apiKeyEnvVar: "x".repeat(200) })).toHaveLength(1);
    expect(
      findRawSecrets({ password: "Q2xhdWRlIGlzIGEgZ29vZCBhc3Npc3RhbnQgYW5kIHRoaXMgaXMgYSBrZXk=" }),
    ).toHaveLength(1);
    expect(findRawSecrets({ apiKeyEnvVar: "OPENAI_API_KEY" })).toEqual([]);
  });

  it("handles scalars and null at the root", () => {
    expect(findRawSecrets(null)).toEqual([]);
    expect(findRawSecrets(42)).toEqual([]);
    expect(findRawSecrets("sk-abcdef0123456789")).toEqual([{ path: "", reason: "secret-shaped string" }]);
  });
});

// Every key below is a made-up fake in the shape of the real thing.
describe("containsRawSecret", () => {
  it("finds a key anywhere in a line, not only at its start", () => {
    for (const line of [
      "OPENAI_API_KEY=sk-proj-FAKE0123456789abcdefghij",
      "export ANTHROPIC_API_KEY=sk-ant-api03-FAKE0123456789abcdef",
      'const key = "sk-ant-api03-FAKE0123456789abcdef";',
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "  token: ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "  pat = github_pat_11FAKE0123456789abcdef",
      "SLACK_BOT=xoxb-1234567890-FAKEfakeFAKE",
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      "cookie: session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln",
      "key: |\n-----BEGIN OPENSSH PRIVATE KEY-----",
    ])
      expect(containsRawSecret(line), line).toBe(true);
  });

  it("finds an unquoted value given to a secret-named variable, as a shell or an .env file writes it", () => {
    for (const line of [
      "DB_PASSWORD=hunter2hunter2",
      "export GITHUB_TOKEN=FAKEfake0123456789",
      "S3_SECRET_KEY=fake-secret-value",
      "RUN CLIENT_SECRET=fakefakefake npm test",
    ])
      expect(containsRawSecret(line), line).toBe(true);
  });

  it("leaves names, references, placeholders and prose alone", () => {
    for (const line of [
      "const apiKey = process.env.OPENAI_API_KEY;",
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
      "GITHUB_TOKEN=$GITHUB_TOKEN",
      "API_KEY=<your key>",
      "TOKEN_URL=https://example.com/oauth/token",
      "if (password === confirmPassword) {",
      "const parts = raw.split(',').map((token)=>token.trim());",
      "this.token=next;",
      "Bearer tokens are sent in the Authorization header.",
      'headers.authorization = "Bearer " + token;',
      "pip install scikit-learn; the task-runner moved",
      "integrity: sha512-Q2xhdWRlIGlzIGEgZ29vZCBhc3Npc3RhbnQgYW5kIHRoaXMgaXMgYSBrZXk+/w==",
      "N8N_API_KEY",
    ])
      expect(containsRawSecret(line), line).toBe(false);
  });
});

describe("redactRawSecrets", () => {
  it("takes key material out of text and leaves prose that names it", () => {
    // Made-up fakes in the shape of the real keys.
    const page = [
      "Set the key: sk-ant-api03-FAKE0123456789abcdefghij and go.",
      "export OPENAI_API_KEY=sk-proj-FAKE0123456789abcdefghij",
      "DB_PASSWORD=hunter2hunter2 in the example",
      'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://api.example.com',
      "A GitHub token looks like ghp_0123456789abcdefghijklmnopqrstuvwxyz.",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- after",
      "Bearer tokens and sk- prefixes are explained here; API_KEY=${API_KEY} is a reference.",
    ].join("\n");
    const out = redactRawSecrets(page);
    for (const value of ["sk-ant-api03", "sk-proj", "hunter2", "abcdefghijklmnop", "ghp_", "MIIEow"])
      expect(out).not.toContain(value);
    expect(out).toContain("Set the key: [redacted] and go.");
    expect(out).toContain("DB_PASSWORD=[redacted] in the example");
    expect(out).toContain("Authorization: Bearer [redacted]");
    expect(out).toContain("[redacted] after");
    expect(out).toContain(
      "Bearer tokens and sk- prefixes are explained here; API_KEY=${API_KEY} is a reference.",
    );
    expect(containsRawSecret(out)).toBe(false);
  });

  it("reads a page of unclosed key headers in one pass", () => {
    const page = "-----BEGIN PRIVATE KEY-----".repeat(40_000);
    const start = performance.now();
    expect(redactRawSecrets(page)).not.toContain("BEGIN");
    expect(performance.now() - start).toBeLessThan(500);
  });
});
