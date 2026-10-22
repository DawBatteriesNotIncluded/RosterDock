// Company model providers on the web: one Activity sentence per event, in a manager's words, from names only;
// and Settings > Models.
import type { EventRecord, EventType, ModelProviderInput } from "@rosterdock/shared";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelProviders } from "../src/api/types.ts";
import { TooltipProvider } from "../src/components/ui/tooltip.tsx";
import { describeEvent } from "../src/lib/format.ts";
import {
  boardLine,
  checkLine,
  credentialLine,
  credentialRole,
  engineLine,
  ModelsPanel,
  formName,
  formProblem,
  formRequest,
  providerSlug,
  submitForm,
  suggestedSecretName,
  whereLine,
  type ModelsPanelProps,
  type ProviderForm,
} from "../src/views/ModelsPanel.tsx";
import { fixture } from "./fixtures.ts";

const daniel = { kind: "user" as const, id: fixture.members[0]!.userId };
const ev = (type: EventType, payload: Record<string, unknown>): EventRecord => ({
  id: "e",
  companyId: fixture.company.id,
  seq: 1,
  type,
  actor: daniel,
  subject: { kind: "model_provider", id: "p" },
  payload,
  createdAt: "2026-10-22T10:00:00.000Z",
});
const said = (type: EventType, payload: Record<string, unknown>) =>
  describeEvent(ev(type, payload), fixture).text;

describe("model provider events", () => {
  const acme = { name: "acme-azure", label: "Acme Azure", kind: "azure_openai" };

  it("says who added, changed, archived, brought back or removed which provider", () => {
    expect(said("model_provider.created", acme)).toBe("Daniel added the model provider Acme Azure");
    expect(said("model_provider.updated", { ...acme, changes: ["label", "models"] })).toBe(
      "Daniel changed the model provider Acme Azure",
    );
    expect(said("model_provider.updated", { ...acme, changes: ["enabled"], enabled: false })).toBe(
      "Daniel switched the model provider Acme Azure off",
    );
    expect(said("model_provider.archived", { ...acme, changes: ["archived"], archived: true })).toBe(
      "Daniel archived the model provider Acme Azure",
    );
    expect(said("model_provider.updated", { ...acme, changes: ["archived"], archived: false })).toBe(
      "Daniel brought back the model provider Acme Azure",
    );
    expect(said("model_provider.deleted", { name: "acme-azure", kind: "azure_openai" })).toBe(
      "Daniel removed the model provider acme-azure",
    );
  });
});

// Settings > Models: the helpers behind each line, the order a pasted key goes in, and the panel as it renders.
const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const provider = (over: Partial<ModelProvider>): ModelProvider => ({
  id: "p1",
  companyId: fixture.company.id,
  name: "acme",
  label: "Acme Anthropic",
  kind: "anthropic",
  endpoint: null,
  region: null,
  authHeader: null,
  credentials: { apiKey: "MODELS_ACME_KEY" },
  // Three days before now, whenever the test runs.
  credentialStates: {
    apiKey: { state: "set", setAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), setBy: daniel },
  },
  models: [{ id: "claude-opus-5-5", family: "claude", label: "Opus", source: "typed" }],
  enabled: true,
  offered: true,
  lastCheck: null,
  archivedAt: null,
  createdBy: daniel,
  createdAt: "2026-10-19T12:00:00.000Z",
  updatedAt: "2026-10-19T12:00:00.000Z",
  ...over,
});
const providers: ModelProviders = {
  offered: { kinds: ["anthropic", "openai", "azure_openai", "openai_compatible"], board: false },
  providers: [
    provider({}),
    provider({
      id: "p2",
      name: "local",
      label: "Local vLLM",
      kind: "openai_compatible",
      endpoint: "http://vllm.ai.svc.cluster.local:8000/v1",
      credentials: {},
      credentialStates: {},
      models: [{ id: "qwen3-coder", family: "other", source: "typed" }],
    }),
    provider({
      id: "p3",
      name: "old",
      label: "Old Bedrock",
      kind: "bedrock",
      region: "us-east-1",
      credentials: { bearerToken: "MODELS_OLD_KEY" },
      credentialStates: { bearerToken: { state: "missing" } },
      models: [{ id: "us.anthropic.claude-old", family: "claude", source: "typed" }],
      offered: false,
      archivedAt: "2026-10-20T12:00:00.000Z",
    }),
  ],
};
const panel = (over: Partial<ModelsPanelProps> = {}) =>
  renderToString(
    <TooltipProvider>
      <ModelsPanel
        data={fixture}
        canEdit
        features={{ oauth: true, objectStore: false, sharedEnvNames: ["SHARED_MODELS_KEY"] }}
        load={async () => providers}
        loadSecrets={async () => []}
        setSecret={async () => undefined}
        checkNew={async () => ({ ok: true })}
        create={async () => providers.providers[0]!}
        update={async () => providers.providers[0]!}
        remove={async () => undefined}
        initial={providers}
        initialSecrets={[]}
        {...over}
      />
    </TooltipProvider>,
  ).replace(/<!-- -->/g, "");

describe("Settings > Models", () => {
  it("names a provider and its key from what people call it", () => {
    expect(providerSlug("Acme Azure (prod)")).toBe("acme-azure-prod");
    expect(providerSlug("  Été / 2026  ")).toBe("t-2026");
    expect(suggestedSecretName("acme-azure-prod")).toBe("MODELS_ACME_AZURE_PROD_KEY");
    expect(credentialRole("bedrock")).toBe("bearerToken");
    expect(credentialRole("azure_openai")).toBe("apiKey");
  });

  it("says where a key comes from, never what it is", () => {
    const set = { state: "set" as const, setAt: "2026-10-19T12:00:00.000Z", setBy: daniel };
    expect(credentialLine(set, fixture, NOW)).toBe("set 3 d ago by Daniel");
    expect(credentialLine({ state: "shared" }, fixture, NOW)).toBe("shared by your operator");
    expect(credentialLine({ state: "missing" }, fixture, NOW)).toBe("not set yet");
    expect(credentialLine(undefined, fixture, NOW)).toBe("not set yet");
  });

  it("says which engine runs each model, where the board reaches it, and what the board lends", () => {
    expect(engineLine("anthropic", "claude")).toBe("Runs on Claude Code");
    expect(engineLine("bedrock", "openai")).toBe("Runs on Codex");
    expect(engineLine("bedrock", "other")).toBe("No engine here runs it");
    expect(whereLine({ kind: "anthropic", endpoint: null, region: null })).toBe("api.anthropic.com");
    expect(whereLine({ kind: "bedrock", endpoint: null, region: "eu-west-1" })).toBe("Bedrock in eu-west-1");
    expect(boardLine(true)).toBe("This board's own models: available");
    expect(boardLine(false)).toBe(
      "This board's own models: not lent. Once teammates think with your providers, each will need one.",
    );
    expect(checkLine({ lastCheck: null })).toBe("Not checked yet");
  });

  const form = (over: Partial<ProviderForm> = {}): ProviderForm => ({
    kind: "anthropic",
    label: "Acme",
    name: null,
    endpoint: "",
    region: "",
    authHeader: "authorization",
    how: "paste",
    value: "pasted-value",
    picked: "",
    ...over,
  });
  const nothingTaken = { providers: [], secrets: [], shared: [] };

  it("saves names only, each kind with its own fields, and a pasted key under the name the body gives", () => {
    // The pasted key goes under the name the provider's body names, and never into the body.
    const pasted = formRequest(form({ label: "Acme Azure (prod)" }));
    expect(pasted.paste).toEqual({ name: "MODELS_ACME_AZURE_PROD_KEY", value: "pasted-value" });
    expect(pasted.input).toEqual({
      kind: "anthropic",
      name: "acme-azure-prod",
      label: "Acme Azure (prod)",
      credentials: { apiKey: "MODELS_ACME_AZURE_PROD_KEY" },
    });
    expect(JSON.stringify(pasted.input)).not.toContain("pasted-value");
    // A name typed by hand is the one the key goes under.
    expect(formRequest(form({ name: "prod" })).paste?.name).toBe("MODELS_PROD_KEY");
    const others = { endpoint: " https://llm.example.com/v1 ", region: " us-east-1 ", value: "" };
    expect(formRequest(form({ ...others, kind: "bedrock", how: "saved", picked: "MODELS_B_KEY" }))).toEqual({
      input: {
        kind: "bedrock",
        name: "acme",
        label: "Acme",
        region: "us-east-1",
        credentials: { bearerToken: "MODELS_B_KEY" },
      },
      paste: null,
    });
    expect(
      formRequest(
        form({ ...others, kind: "openai_compatible", how: "shared", picked: "K", authHeader: "api-key" }),
      ).input,
    ).toEqual({
      kind: "openai_compatible",
      name: "acme",
      label: "Acme",
      endpoint: "https://llm.example.com/v1",
      authHeader: "api-key",
      credentials: { apiKey: "K" },
    });
    // A keyless server names no key and no header.
    expect(formRequest(form({ ...others, kind: "openai_compatible", how: "none" })).input).toEqual({
      kind: "openai_compatible",
      name: "acme",
      label: "Acme",
      endpoint: "https://llm.example.com/v1",
      credentials: {},
    });
  });

  it("holds the form back, before any key is set, on anything the board would refuse", () => {
    expect(formProblem(form(), nothingTaken)).toBeNull();
    expect(formProblem(form({ label: "" }), nothingTaken)).toBe("missing");
    expect(formProblem(form({ value: "" }), nothingTaken)).toBe("missing");
    expect(formProblem(form({ how: "saved" }), nothingTaken)).toBe("missing");
    // A key typed where a label or a name goes: refused before it could become a secret's name.
    expect(formProblem(form({ label: "a3f9c2e1b4d5f60718293a4b5c6d7e8f" }), nothingTaken)).toMatch(
      /^That label looks like a key/,
    );
    expect(formProblem(form({ name: "a3f9c2e1b4d5f60718293a4b5c6d7e8f" }), nothingTaken)).toMatch(
      /^The name: a short name; this looks like a key/,
    );
    expect(formProblem(form({ name: "acme prod" }), nothingTaken)).toMatch(/^The name: a short name/);
    expect(formProblem(form({ label: "Acme ".repeat(17) }), nothingTaken)).toBe(
      "A label is 80 characters at most.",
    );
    // Another provider of that name, archived or not, and a key already set under the name: never replaced.
    const acme = { name: "acme", credentials: { apiKey: "MODELS_ACME_KEY" } };
    expect(formProblem(form({ kind: "openai" }), { providers: [acme], secrets: [], shared: [] })).toMatch(
      /already has a provider named acme/,
    );
    expect(
      formProblem(form({ name: "acme2" }), {
        providers: [{ name: "other", credentials: { apiKey: "MODELS_ACME2_KEY" } }],
        secrets: [],
        shared: [],
      }),
    ).toMatch(/^MODELS_ACME2_KEY is already set/);
    expect(
      formProblem(form(), {
        providers: [],
        secrets: [{ name: "MODELS_ACME_KEY", updatedAt: "", updatedBy: daniel }],
        shared: [],
      }),
    ).toMatch(/^MODELS_ACME_KEY is already set/);
    // Using a saved secret that is already set is the point of it.
    expect(
      formProblem(form({ how: "saved", picked: "MODELS_ACME_KEY" }), {
        providers: [],
        secrets: [{ name: "MODELS_ACME_KEY", updatedAt: "", updatedBy: daniel }],
        shared: [],
      }),
    ).toBeNull();
    // Each kind's own fields, by the board's rules.
    expect(
      formProblem(form({ kind: "azure_openai", endpoint: "acme.openai.azure.com" }), nothingTaken),
    ).toMatch(/resource's address/);
    expect(
      formProblem(form({ kind: "azure_openai", endpoint: "https://acme.openai.azure.com" }), nothingTaken),
    ).toBeNull();
    expect(
      formProblem(
        form({ kind: "openai_compatible", endpoint: "https://llm.example.com/v1?key=1" }),
        nothingTaken,
      ),
    ).toMatch(/base URL/);
    expect(formProblem(form({ kind: "bedrock", region: "frankfurt" }), nothingTaken)).toMatch(/AWS region/);
    expect(formProblem(form({ kind: "bedrock" }), nothingTaken)).toBe("missing");
  });

  it("asks the board first, then sets a pasted key under a new name, then saves the provider; a refusal stops the rest", async () => {
    const calls: string[] = [];
    const deps = (refuse?: "check" | "secret") => ({
      checkNew: async () => {
        calls.push("POST /model-providers/check-new");
        if (refuse === "check") throw new Error("refused: llm.internal resolves to a private address");
      },
      setSecret: async (name: string) => {
        calls.push(`PUT /secrets/${name} (only if new)`);
        if (refuse === "secret") throw new Error("MODELS_ACME_KEY is already set");
      },
      create: async (body: ModelProviderInput) => {
        calls.push(`POST /model-providers ${JSON.stringify(body.credentials)}`);
        return providers.providers[0]!;
      },
    });
    expect(await submitForm(form(), nothingTaken, deps())).not.toBeNull();
    expect(calls).toEqual([
      "POST /model-providers/check-new",
      "PUT /secrets/MODELS_ACME_KEY (only if new)",
      'POST /model-providers {"apiKey":"MODELS_ACME_KEY"}',
    ]);
    // The value never reaches the provider's body.
    expect(calls.join(" ")).not.toContain("pasted-value");
    // The board refuses the provider: no key is set for it.
    calls.length = 0;
    await expect(submitForm(form(), nothingTaken, deps("check"))).rejects.toThrow("private address");
    expect(calls).toEqual(["POST /model-providers/check-new"]);
    // The name is taken after all: nothing is saved over it, and no provider names it.
    calls.length = 0;
    await expect(submitForm(form(), nothingTaken, deps("secret"))).rejects.toThrow("already set");
    expect(calls).toEqual(["POST /model-providers/check-new", "PUT /secrets/MODELS_ACME_KEY (only if new)"]);
    // A form with a problem sends nothing at all: a name an archived provider holds, a shared name, or
    // secrets not loaded yet.
    calls.length = 0;
    const archived = { name: "acme", credentials: {} };
    expect(await submitForm(form(), { ...nothingTaken, providers: [archived] }, deps())).toBeNull();
    expect(await submitForm(form(), { ...nothingTaken, shared: ["MODELS_ACME_KEY"] }, deps())).toBeNull();
    expect(await submitForm(form(), { ...nothingTaken, secrets: null }, deps())).toBeNull();
    expect(await submitForm(form({ label: "" }), nothingTaken, deps())).toBeNull();
    expect(calls).toEqual([]);
  });

  it("never pastes under a name the operator shares, and forgets a pick a reload took away", () => {
    expect(formProblem(form(), { ...nothingTaken, shared: ["MODELS_ACME_KEY"] })).toBe(
      "MODELS_ACME_KEY is a name your operator shares. Give this provider another name.",
    );
    const saved = form({ how: "saved", picked: "GONE_KEY" });
    expect(formProblem(saved, nothingTaken)).toBe("missing");
    expect(
      formProblem(saved, {
        ...nothingTaken,
        secrets: [{ name: "GONE_KEY", updatedAt: "", updatedBy: daniel }],
      }),
    ).toBeNull();
    expect(formProblem(form({ how: "shared", picked: "OLD" }), { ...nothingTaken, shared: ["NEW"] })).toBe(
      "missing",
    );
    // A typed name is the person's: cleared, it is missing, not the label's again.
    expect(formName(form({ name: "" }))).toBe("");
    expect(formProblem(form({ name: "" }), nothingTaken)).toBe("missing");
    expect(formName(form({ name: null, label: "Acme Azure" }))).toBe("acme-azure");
  });

  it("shows each provider by name, its key's source, its models and what the operator turned off", () => {
    const html = panel();
    expect(html).toContain("Acme Anthropic");
    expect(html).toContain("MODELS_ACME_KEY");
    expect(html).toMatch(/set \d+ d ago by Daniel/);
    expect(html).toContain("claude-opus-5-5");
    expect(html).toContain("Runs on Claude Code");
    expect(html).toContain('<span class="mono">http://vllm.ai.svc.cluster.local:8000/v1</span> · no key');
    expect(html).toContain("Runs on Codex");
    expect(html).toContain("This board&#x27;s own models: not lent");
    expect(html).toContain("Teammates do not think with them yet");
    // Archived, of a kind no longer offered, and its key not set.
    expect(html).toContain("Archived");
    // An archived provider's models stay listed, and nothing on them can be changed.
    expect(html).toContain("us.anthropic.claude-old");
    expect(html).not.toContain("Take us.anthropic.claude-old off the list");
    expect(html).toContain("Take claude-opus-5-5 off the list");
    expect(html).toContain("Turned off by your operator");
    expect(html).toContain("not set yet");
    // Bedrock is not offered here: the form says so in words, and offers no Bedrock choice.
    expect(html).toContain("Turned off by your operator: Amazon Bedrock.");
    expect(html).not.toMatch(/<button[^>]*>Amazon Bedrock<\/button>/);
    // Tokens only, so both themes hold.
    expect(html).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  it("takes a value in one field only: the pasted key, for owners and admins, with a secret store", () => {
    const passwords = (html: string) => html.match(/type="password"/g)?.length ?? 0;
    const html = panel();
    expect(passwords(html)).toBe(1);
    // Every field on the page is one of these; only the pasted key's takes a value.
    const fields = [...html.matchAll(/<(?:input|select)[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(fields.length).toBe(html.match(/<(?:input|select)\b/g)?.length);
    expect(new Set(fields)).toEqual(
      new Set([
        "Model id",
        "Whose model",
        "Model label",
        "Label",
        "Name",
        "How the key is given",
        "Value for MODELS_PROVIDER_KEY",
      ]),
    );
    // The name a key goes under follows the provider's name as it is typed.
    expect(html).toContain("Value for MODELS_PROVIDER_KEY");
    expect(html).toContain("Paste a key");
    // Without a store, no key is pasted here: a saved or shared name only.
    const storeless = panel({ features: { oauth: false, objectStore: false } });
    expect(passwords(storeless)).toBe(0);
    expect(storeless).not.toContain("Paste a key");
    // Someone who may not manage providers gets no form at all.
    const viewer = panel({ canEdit: false });
    expect(viewer).not.toContain("<input");
    expect(viewer).not.toContain("Add a provider");
    expect(viewer).toContain("Acme Anthropic");
  });
});
