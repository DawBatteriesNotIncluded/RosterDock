import { describe, expect, it } from "vitest";
import {
  assertNoRawSecrets,
  azureEndpoint,
  compatibleEndpoint,
  engineFor,
  ModelProviderSchema,
  parseModelProviders,
  PROVIDER_KINDS,
  UpdateModelProviderSchema,
} from "../src/index.js";

const parse = (body: unknown) => ModelProviderSchema.safeParse(body);
const issues = (body: unknown) => {
  const r = parse(body);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("ROSTERDOCK_MODEL_PROVIDERS", () => {
  it("unset or blank lends the board's own models and offers every kind", () => {
    for (const raw of [undefined, "", "  ", ","])
      expect(parseModelProviders(raw)).toEqual({ kinds: [...PROVIDER_KINDS], board: true });
  });

  it("board alone offers no kind; a list without board lends nothing", () => {
    expect(parseModelProviders("board")).toEqual({ kinds: [], board: true });
    expect(parseModelProviders(" Anthropic , bedrock,anthropic")).toEqual({
      kinds: ["anthropic", "bedrock"],
      board: false,
    });
  });

  it("refuses an entry it does not know, so a typo never turns a kind off quietly", () => {
    expect(() => parseModelProviders("anthropic,azure")).toThrow(
      "ROSTERDOCK_MODEL_PROVIDERS: azure is not one of anthropic, openai, azure_openai, bedrock, openai_compatible, board",
    );
  });
});

describe("engineFor", () => {
  it("follows the model: Claude on Claude Code, OpenAI's Responses API on Codex", () => {
    expect(engineFor("anthropic", "claude")).toBe("claude_code");
    expect(engineFor("bedrock", "claude")).toBe("claude_code");
    expect(engineFor("bedrock", "openai")).toBe("codex");
    expect(engineFor("openai", "openai")).toBe("codex");
    expect(engineFor("azure_openai", "openai")).toBe("codex");
    expect(engineFor("azure_openai", "other")).toBe("codex");
    expect(engineFor("openai_compatible", "other")).toBe("codex");
  });

  it("gives none for a family no engine here runs, or a kind that does not serve it", () => {
    expect(engineFor("bedrock", "other")).toBeNull();
    expect(engineFor("anthropic", "openai")).toBeNull();
    expect(engineFor("openai", "claude")).toBeNull();
    expect(engineFor("azure_openai", "claude")).toBeNull();
  });
});

describe("a provider's schema", () => {
  const key = { apiKey: "MODELS_ACME_KEY" };

  it("takes each kind with the fields it needs", () => {
    expect(
      parse({
        kind: "anthropic",
        name: "acme",
        label: "Acme Anthropic",
        credentials: key,
        models: [{ id: "claude-opus-5.5", family: "claude" }],
      }).data,
    ).toMatchObject({
      enabled: true,
      // Written the way people say it, a Claude id is put the way Claude Code takes it.
      models: [{ id: "claude-opus-5-5", family: "claude" }],
    });
    expect(parse({ kind: "openai", name: "acme-openai", label: "OpenAI", credentials: key }).success).toBe(
      true,
    );
    expect(
      parse({
        kind: "bedrock",
        name: "acme-bedrock",
        label: "Bedrock",
        region: "us-gov-west-1",
        credentials: { bearerToken: "MODELS_ACME_BEDROCK_KEY" },
        models: [
          { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", family: "claude" },
          { id: "global.openai.example-model", family: "openai" },
          { id: "meta.llama-example", family: "other" },
        ],
      }).success,
    ).toBe(true);
    expect(
      parse({
        kind: "openai_compatible",
        name: "ollama",
        label: "Ollama",
        endpoint: "http://ollama:11434/v1/",
      }).data,
    ).toMatchObject({ endpoint: "http://ollama:11434/v1", credentials: {} });
  });

  it("keeps an Azure resource's address alone, whatever path was pasted", () => {
    expect(
      parse({
        kind: "azure_openai",
        name: "acme-azure",
        label: "Acme Azure",
        endpoint: "https://Acme-Prod.openai.azure.com/openai/v1/",
        credentials: key,
      }).data,
    ).toMatchObject({ endpoint: "https://acme-prod.openai.azure.com" });
    expect(azureEndpoint("https://acme.services.ai.azure.com")).toBe("https://acme.services.ai.azure.com");
    for (const bad of [
      "http://acme.openai.azure.com",
      "https://acme.openai.azure.com.evil.test",
      "https://evil.test/acme.openai.azure.com",
      "https://acme.openai.azure.com/deployments/x",
      "https://acme.openai.azure.com:8443",
      "https://user:pass@acme.openai.azure.com",
      "https://acme.openai.azure.com?api-version=1",
    ])
      expect(azureEndpoint(bad), bad).toBeNull();
  });

  it("takes a compatible server's base URL, never one with a credential or a query in it", () => {
    expect(compatibleEndpoint("https://llm.example.com/v1")).toBe("https://llm.example.com/v1");
    for (const bad of [
      "ftp://llm.example.com",
      "https://key:x@llm.example.com/v1",
      "https://llm.example.com/v1?key=x",
      "https://llm.example.com/v1#x",
      "not a url",
    ])
      expect(compatibleEndpoint(bad), bad).toBeNull();
  });

  it("refuses a field another kind takes, and a credential role the kind does not have", () => {
    expect(
      issues({ kind: "anthropic", name: "a", label: "A", credentials: key, endpoint: "https://x.test" }),
    ).toEqual([expect.stringMatching(/Unrecognized key.*endpoint/)]);
    expect(
      issues({ kind: "bedrock", name: "b", label: "B", region: "us-east-1", credentials: key }),
    ).not.toEqual([]);
    expect(
      issues({ kind: "bedrock", name: "b", label: "B", region: "useast1", credentials: {} }),
    ).not.toEqual([]);
    expect(issues({ kind: "azure_openai", name: "z", label: "Z", credentials: key })).not.toEqual([]);
  });

  it("takes names only: a value where a name goes is refused, and never echoed", () => {
    const value = "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz";
    const r = parse({ kind: "anthropic", name: "a", label: "A", credentials: { apiKey: value } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain(value);
    // The names a provider carries pass the raw-secret guard the board runs on every body.
    expect(() =>
      assertNoRawSecrets(
        parse({
          kind: "bedrock",
          name: "b",
          label: "B",
          region: "us-east-1",
          credentials: { bearerToken: "MODELS_B_KEY" },
        }).data,
      ),
    ).not.toThrow();
  });

  it("refuses a model the kind does not serve, a model twice, and Bedrock's Mantle ids", () => {
    expect(
      issues({
        kind: "openai",
        name: "o",
        label: "O",
        credentials: key,
        models: [{ id: "claude-opus-5-5", family: "claude" }],
      }),
    ).toEqual(["models.0.family: OpenAI serves OpenAI models here, not Claude ones"]);
    expect(
      issues({
        kind: "anthropic",
        name: "a",
        label: "A",
        credentials: key,
        models: [
          { id: "claude-opus-5-5", family: "claude" },
          { id: "claude-opus-5.5", family: "claude" },
        ],
      }),
    ).toEqual(["models.1.id: claude-opus-5-5 is listed twice"]);
    expect(
      issues({
        kind: "bedrock",
        name: "b",
        label: "B",
        region: "us-east-1",
        credentials: { bearerToken: "K" },
        models: [{ id: "openai.example-model", family: "openai" }],
      }),
    ).toEqual([expect.stringContaining("Mantle")]);
  });

  it("puts a compatible server's header with its key only", () => {
    expect(
      issues({
        kind: "openai_compatible",
        name: "c",
        label: "C",
        endpoint: "https://llm.example.com/v1",
        authHeader: "api-key",
      }),
    ).toEqual(["authHeader: a header goes with a key"]);
  });

  it("a change names no kind or name: those stay", () => {
    expect(UpdateModelProviderSchema.safeParse({ kind: "openai" }).success).toBe(false);
    expect(UpdateModelProviderSchema.safeParse({ name: "other" }).success).toBe(false);
    expect(UpdateModelProviderSchema.safeParse({ label: "New", archived: true }).success).toBe(true);
  });
});
