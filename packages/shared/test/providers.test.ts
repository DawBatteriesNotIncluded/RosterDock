import { describe, expect, it } from "vitest";
import {
  assertNoRawSecrets,
  azureEndpoint,
  labelLooksLikeKey,
  modelIdProblem,
  nameLooksLikeKey,
  providerNameRefusal,
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
    // An empty query or fragment left at the end goes, so a path added later stays a path.
    expect(compatibleEndpoint("https://llm.example.com/v1?")).toBe("https://llm.example.com/v1");
    expect(compatibleEndpoint("http://ollama:11434/v1/#")).toBe("http://ollama:11434/v1");
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

  it("takes a name, never a key shaped like one, and says neither back", () => {
    // An Azure key is 32 hex characters; one that starts with a letter is a valid env var name.
    const azureKey = "a3f9c2e1b4d5f60718293a4b5c6d7e8f";
    for (const key of [
      azureKey,
      "AKIAABCDEFGHIJKLMNOP",
      "TOKEN_aB3dE5fG7hJ9kL1mN3pQ5rS7",
      "DEADBEEFCAFEBABE0",
    ]) {
      expect(nameLooksLikeKey(key), key).toBe(true);
      const r = parse({
        kind: "azure_openai",
        name: "z",
        label: "Z",
        endpoint: "https://z.openai.azure.com",
        credentials: { apiKey: key },
      });
      expect(r.success, key).toBe(false);
      expect(JSON.stringify(r.error?.issues)).not.toContain(key);
    }
    for (const name of ["MODELS_ACME_KEY", "OPENAI", "AZURE_OPENAI_API_KEY_FOR_PRODUCTION", "x"])
      expect(nameLooksLikeKey(name), name).toBe(false);
    // A change names a role, never anything else.
    expect(
      UpdateModelProviderSchema.safeParse({ credentials: { "sk-ant-api03-abcdefghijklmnopqrstuvwxyz": "K" } })
        .success,
    ).toBe(false);
  });

  it("refuses a name or a label that is a key typed in the wrong field", () => {
    expect(providerNameRefusal("acme-azure")).toBeNull();
    expect(providerNameRefusal("Acme")).toMatch(/lowercase/);
    expect(providerNameRefusal("a3f9c2e1b4d5f60718293a4b5c6d7e8f")).toBe(
      "a short name; this looks like a key",
    );
    expect(labelLooksLikeKey("Acme Azure (prod)")).toBe(false);
    expect(labelLooksLikeKey("Production-Claude-Opus-Deployment-2026")).toBe(false);
    expect(labelLooksLikeKey("Acme a3f9c2e1b4d5f60718293a4b5c6d7e8f")).toBe(true);
    expect(labelLooksLikeKey("Acme a3f9c2e1-b4d5-4c6d-8e7f-0123456789ab")).toBe(true);
    // Labels people write: long words, addresses, brackets, slashes, other scripts.
    for (const label of [
      "Azure Entwicklungsumgebung",
      "Acme (acme-prod.openai.azure.com)",
      "Owner: dana.lee@acme.com",
      "SK-Telecom Azure",
      "xoxo-labs vLLM",
      "Production/Development",
      "生産環境のアズールオープンエーアイ接続設定用プロバイダー",
      "gpt4o-prod-eastus2-deployment",
    ])
      expect(labelLooksLikeKey(label), label).toBe(false);
    expect(providerNameRefusal("acme-internationalization")).toBeNull();
    expect(providerNameRefusal("deepseekr1distillqwen32b")).toBeNull();
    expect(providerNameRefusal("a3f9c2e1-b4d5-4c6d-8e7f-0123456789ab")).toBe(
      "a short name; this looks like a key",
    );
    expect(nameLooksLikeKey("githubPersonalAccessToken")).toBe(false);
    expect(nameLooksLikeKey("DEEPSEEKR1DISTILLQWEN32B_KEY")).toBe(false);
    // A model's name in a label is a word.
    for (const label of [
      "DeepSeekR1DistillQwen32B on vLLM",
      "Acme Mixtral8x7BInstructV01",
      "Entwicklungsumgebungsverwaltung2026",
    ])
      expect(labelLooksLikeKey(label), label).toBe(false);
  });

  it("knows keys with no digits, keys with slashes, and keys by their prefix", () => {
    // Built here, so the repository holds no string a secret scanner would stop a push for.
    const hf = ["hf", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"].join("_");
    expect(nameLooksLikeKey(hf)).toBe(true);
    expect(labelLooksLikeKey(`Router ${hf}`)).toBe(true);
    // Mixed case and no digits, flipping as a key's does.
    expect(nameLooksLikeKey("aBcDeFgHiJkLmNoPqRsTuVwXyZ")).toBe(true);
    // AWS's documented example secret access key: base64, with slashes.
    expect(labelLooksLikeKey("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true);
    expect(labelLooksLikeKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    const r = parse({
      kind: "openai",
      name: "o",
      label: "a3f9c2e1b4d5f60718293a4b5c6d7e8f",
      credentials: { apiKey: "K" },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain("a3f9c2e1b4d5f60718293a4b5c6d7e8f");
  });

  it("takes a name of one long word in one case: the names the paste flow builds", () => {
    expect(nameLooksLikeKey("MODELS_ACMEPRODUCTIONOPENAI_KEY")).toBe(false);
    expect(nameLooksLikeKey("AZUREOPENAIPRODUCTIONKEY")).toBe(false);
    expect(nameLooksLikeKey("githubPersonalAccessToken")).toBe(false);
    // In both cases with digits, or flipping case as a key does, it is a key.
    expect(nameLooksLikeKey("TOKEN_aB3dE5fG7hJ9kL1mN3pQ5rS7")).toBe(true);
    expect(nameLooksLikeKey("aBcDeFgHiJkLmNoPqRsTuVwXyZ")).toBe(true);
    // Built here, so the repository holds no string a secret scanner would stop a push for.
    expect(nameLooksLikeKey(["hf", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"].join("_"))).toBe(true);
  });

  it("knows the keys model providers issue, by prefix or by how random they read, in a label or a name", () => {
    // Built here, so the repository holds no string a secret scanner would stop a push for.
    const run = (n: number) => "mR7xQ2pL9vN4kT8wZ1sJ5bH3cY6dG0aF8eK2uB4iO6".repeat(3).slice(0, n);
    for (const key of [
      `gsk_${run(52)}`,
      `pplx-${run(48)}`,
      `csk-${run(48)}`,
      `nvapi-${run(64)}`,
      `fw_${run(24)}`,
      run(32), // Mistral's: no prefix, 32 random characters
    ]) {
      expect(labelLooksLikeKey(`Acme ${key}`), key).toBe(true);
      expect(nameLooksLikeKey(key.replace(/-/g, "_")), key).toBe(true);
    }
    // Identifiers people write, a digit in them or not, read as words.
    for (const name of ["notionIntegrationV2Secret", "hubspotPrivateApp2Token", "AzureOpenAiKeyEastUs2"])
      expect(nameLooksLikeKey(name), name).toBe(false);
    for (const label of ["Qwen25Coder32BInstructAWQ", "Llama31Nemotron70BInstructHF on vLLM"])
      expect(labelLooksLikeKey(label), label).toBe(false);
  });

  it("says why a model id will not do, as the board would", () => {
    expect(modelIdProblem("anthropic", "claude", "claude-opus-5.5", ["claude-opus-5-5"])).toBe(
      "This model is on the list already.",
    );
    expect(modelIdProblem("openai", "openai", "gpt x", [])).toBe("A model id has no spaces.");
    expect(modelIdProblem("bedrock", "openai", "gpt-oss-120b", [])).toMatch(/cross-Region inference profile/);
    expect(modelIdProblem("bedrock", "openai", "global.openai.example-model", [])).toBeNull();
    expect(modelIdProblem("openai", "claude", "claude-x", [])).toBe("OpenAI serves OpenAI models here.");
    expect(modelIdProblem("anthropic", "claude", "", [])).toBe("Give the model's id.");
  });

  it("keeps a key out of a server's address, and an account id in it", () => {
    expect(
      compatibleEndpoint("https://llm.example.com/v1/sk-proj-abcdefghijklmnopqrstuvwxyz0123"),
    ).toBeNull();
    // A gateway's address may carry an account id: not a key.
    expect(
      compatibleEndpoint("https://gateway.example.com/v1/0123456789abcdef0123456789abcdef/gw/openai"),
    ).toBe("https://gateway.example.com/v1/0123456789abcdef0123456789abcdef/gw/openai");
  });

  it("keeps a model id as the provider takes it; only Anthropic's own are put Claude Code's way", () => {
    const compatible = parse({
      kind: "openai_compatible",
      name: "c",
      label: "C",
      endpoint: "https://llm.example.com/v1",
      models: [{ id: "claude-3.7-sonnet", family: "claude" }],
    });
    expect(compatible.data?.models[0]?.id).toBe("claude-3.7-sonnet");
    const anthropic = parse({
      kind: "anthropic",
      name: "a",
      label: "A",
      credentials: { apiKey: "K" },
      models: [{ id: "claude-3.7-sonnet", family: "claude" }],
    });
    expect(anthropic.data?.models[0]?.id).toBe("claude-3-7-sonnet");
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
    ).toEqual(["models.1.id: this model is listed twice"]);
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
    // Any other id that is not a cross-Region profile or its ARN, too.
    const bedrockOpenAi = (id: string) =>
      issues({
        kind: "bedrock",
        name: "b",
        label: "B",
        region: "us-east-1",
        credentials: { bearerToken: "K" },
        models: [{ id, family: "openai" }],
      });
    expect(bedrockOpenAi("gpt-oss-120b")).toEqual([
      expect.stringContaining("cross-Region inference profile"),
    ]);
    expect(bedrockOpenAi("global.openai.example-model")).toEqual([]);
    expect(bedrockOpenAi("us.openai.example-model")).toEqual([]);
    expect(
      bedrockOpenAi("arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.openai.example-model"),
    ).toEqual([]);
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
