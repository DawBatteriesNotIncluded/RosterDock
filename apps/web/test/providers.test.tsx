// Company model providers on the web: one Activity sentence per event, in a manager's words, from names only;
// and Settings > Models.
import type { EventRecord, EventType, ModelProviderInput } from "@rosterdock/shared";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpClient } from "../src/api/client.ts";
import type { ModelPrice, ModelProvider, ModelProviders } from "../src/api/types.ts";
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
  holdsPartOf,
  formRequest,
  listFillLine,
  modelPriceLine,
  providerSlug,
  removeLine,
  submitForm,
  suggestedModels,
  suggestedSecretName,
  unreached,
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
    expect(said("model_provider.deleted", { ...acme })).toBe("Daniel removed the model provider Acme Azure");
    // A removal written before the label was carried names the provider by its name.
    expect(said("model_provider.deleted", { name: "acme-azure", kind: "azure_openai" })).toBe(
      "Daniel removed the model provider acme-azure",
    );
  });

  it("says what a check found, in the board's words", () => {
    expect(said("model_provider.checked", { ...acme, ok: true, detail: null, listed: 12 })).toBe(
      "Daniel checked the model provider Acme Azure: the key works, 12 models",
    );
    expect(
      said("model_provider.checked", {
        ...acme,
        ok: false,
        listed: 0,
        detail: "the key was refused (HTTP 401): it is wrong, revoked or expired",
      }),
    ).toBe(
      "Daniel checked the model provider Acme Azure: the key was refused (HTTP 401): it is wrong, revoked or expired",
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
const price = (over: Partial<ModelPrice>): ModelPrice => ({
  id: "pr",
  model: "claude-opus-5-5",
  providerId: "p1",
  estimate: false,
  currency: "USD",
  inputPerMillion: 400,
  outputPerMillion: 2000,
  cacheReadPerMillion: 40,
  cacheWritePerMillion: 500,
  seatPriceMonth: null,
  updatedAt: "2026-10-22T10:00:00.000Z",
  ...over,
});
const prices: ModelPrice[] = [
  price({ id: "pr1" }),
  price({ id: "pr2", model: "qwen3-coder", providerId: null, inputPerMillion: 10, outputPerMillion: 20 }),
];
// What the board itself has, as GET /planner says it: each CLI's sign-in where the board runs, and the API key.
const boardModels = {
  options: [
    {
      kind: "claude_cli" as const,
      label: "Claude Code CLI",
      available: true,
      detail: "signed in (claude.ai, max)",
    },
    { kind: "codex_cli" as const, label: "Codex CLI", available: true, detail: "signed in using ChatGPT" },
    {
      kind: "api" as const,
      label: "Anthropic API",
      available: false,
      detail: "no ANTHROPIC_API_KEY on the board",
    },
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
        replaceSecret={async () => undefined}
        checkNew={async () => ({ ok: true })}
        create={async () => providers.providers[0]!}
        update={async () => providers.providers[0]!}
        remove={async () => undefined}
        check={async () => providers.providers[0]!}
        initial={providers}
        initialSecrets={[]}
        loadPrices={async () => prices}
        savePrice={async () => prices[0]!}
        deletePrice={async () => undefined}
        fillListPrices={async () => ({ added: [], unknown: [] })}
        initialPrices={prices}
        loadBoardModels={async () => boardModels}
        initialBoardModels={boardModels}
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
    expect(boardLine(true)).toBe("Your operator lends these to every company.");
    expect(boardLine(false)).toBe(
      "Not lent by your operator. Once teammates think with your providers, each will need one.",
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
      /^That name looks like a key/,
    );
    // A key pasted into Name keeps its case, which gives it away; a name in capitals is only not a name yet.
    const mistral = ["mR7", "xQ2pL9", "vN4kT8", "wZ1sJ5", "bH3cY6", "dG0aF"].join("");
    expect(formProblem(form({ name: mistral }), nothingTaken)).toMatch(/^That name looks like a key/);
    expect(formProblem(form({ name: "Acme" }), nothingTaken)).toMatch(/^The name: a short name: lowercase/);
    // Part of the pasted key in the label or the name: nothing is sent.
    const pasted = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    expect(formProblem(form({ value: pasted, label: "Acme e5f6g7h8i9j0k1" }), nothingTaken)).toMatch(
      /^The label or the name holds part of the key/,
    );
    expect(formProblem(form({ value: pasted, name: "acme-g7h8i9j0k1l2" }), nothingTaken)).toMatch(
      /^The label or the name holds part of the key/,
    );
    expect(holdsPartOf("Acme prod", pasted)).toBe(false);
    // A key's own words are a label's too: Bedrock's short-term keys start bedrock-api-key-.
    const bedrock = ["bedrock", "api", "key", "YmVkcm9jay5hbWF6b25hd3MuY29tLz9B"].join("-");
    expect(holdsPartOf("Acme Bedrock API key", bedrock)).toBe(false);
    expect(holdsPartOf("acme-bedrock-api-key", bedrock)).toBe(false);
    expect(holdsPartOf("Acme YmVkcm9jay5h", bedrock)).toBe(true);
    expect(holdsPartOf("acme", "short-key")).toBe(false);
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

  it("says what each model costs through its provider, in the order the board prices it", () => {
    const anthropic = { id: "p1", kind: "anthropic" as const };
    const local = { id: "p2", kind: "openai_compatible" as const };
    expect(modelPriceLine(anthropic, { id: "claude-opus-5-5" }, prices)).toBe(
      "US$4.00 in · US$20.00 out per million",
    );
    // None of its own: the board's own price for the model, then Anthropic's list for an Anthropic provider,
    // for a model the list knows, while the company prices in USD.
    expect(modelPriceLine(local, { id: "qwen3-coder" }, prices)).toBe(
      "US$0.10 in · US$0.20 out per million, this board's own price for the model",
    );
    const sonnet = { id: "claude-sonnet-5-5", listPrice: true };
    expect(modelPriceLine(anthropic, sonnet, prices)).toBe("Anthropic's list price");
    expect(modelPriceLine(anthropic, { id: "claude-preview-x", listPrice: false }, prices)).toBe(
      "No price yet",
    );
    expect(
      modelPriceLine(anthropic, sonnet, [price({ providerId: null, model: "x", currency: "GBP" })]),
    ).toBe("No price yet");
    // No prices at all: no currency yet, so the list's applies, and would be the company's first.
    expect(modelPriceLine(anthropic, sonnet, [])).toBe("Anthropic's list price");
    // A seat on the board's own models is not a price for a provider's tokens.
    const seat = price({
      providerId: null,
      model: "claude-sonnet-5-5",
      inputPerMillion: null,
      outputPerMillion: null,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
      seatPriceMonth: 2000,
    });
    expect(modelPriceLine(anthropic, sonnet, [seat])).toBe("Anthropic's list price");
    expect(modelPriceLine(local, { id: "llama" }, prices)).toBe("No price yet");
    expect(
      modelPriceLine({ id: "p3", kind: "bedrock" }, { id: "us.anthropic.x" }, [
        price({ providerId: "p3", model: "us.anthropic.x", estimate: true }),
      ]),
    ).toBe("US$4.00 in · US$20.00 out per million · an estimate: check your AWS price");
    expect(listFillLine("bedrock", { added: ["us.anthropic.x"], unknown: ["us.anthropic.y"] })).toBe(
      "Priced us.anthropic.x at Anthropic's list price, as estimates: check your AWS price. No list price for us.anthropic.y: set it by hand.",
    );
    expect(listFillLine("anthropic", { added: [], unknown: [] })).toBe(
      "Every Claude model here with a list price already has a price.",
    );
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
    expect(html).toContain("Not lent by your operator");
    expect(html).toContain("Teammates do not think with them yet");
    // Archived, of a kind no longer offered, and its key not set.
    expect(html).toContain("Archived");
    // An archived provider's models stay listed, and nothing on them can be changed.
    expect(html).toContain("us.anthropic.claude-old");
    expect(html).not.toContain("Take us.anthropic.claude-old off the list");
    expect(html).toContain("Take claude-opus-5-5 off the list of Acme Anthropic");
    // Each card's controls say whose they are, and removing asks first.
    expect(html).toContain('aria-label="Switch off Acme Anthropic"');
    expect(html).toContain('aria-label="Remove Acme Anthropic"');
    expect(html).not.toContain("Remove for good");
    expect(html).toContain("Turned off by your operator");
    expect(html).toContain("not set yet");
    // Bedrock is not offered here: the form says so in words, and offers no Bedrock choice.
    expect(html).toContain("Turned off by your operator: Amazon Bedrock.");
    expect(html).not.toMatch(/<button[^>]*>Amazon Bedrock<\/button>/);
    // Prices on each model row; list prices only where Anthropic's list applies; no price editor open.
    expect(html).toContain("US$4.00 in · US$20.00 out per million");
    expect(html.match(/>Fill list prices</g)).toHaveLength(1);
    expect(html.match(/>Set price</g)).toHaveLength(2);
    expect(html).not.toContain("Save price");
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
        "Model id for Acme Anthropic",
        "Model label for Acme Anthropic",
        "Model id for Local vLLM",
        "Whose model, for Local vLLM",
        "Model label for Local vLLM",
        "Label",
        "Name",
        "How the key is given",
        "Value for MODELS_PROVIDER_KEY",
      ]),
    );
    // The name a key goes under follows the provider's name as it is typed.
    expect(html).toContain("Value for MODELS_PROVIDER_KEY");
    expect(html).toContain("Paste a key");
    // A saved secret is offered only when there is one to pick, never a list with nothing in it.
    expect(html).not.toContain("Use a saved secret");
    expect(
      panel({ initialSecrets: [{ name: "MODELS_OLD_KEY", updatedAt: "", updatedBy: daniel }] }),
    ).toContain("Use a saved secret");
    // Without a store, no key is pasted here: a saved or shared name only.
    const storeless = panel({ features: { oauth: false, objectStore: false } });
    expect(passwords(storeless)).toBe(0);
    expect(storeless).not.toContain("Paste a key");
    // And it says so where the key would go, with what an operator can do, instead of a picker with nothing in
    // it: no way to give a key, no picker of secrets, and nothing to press.
    expect(storeless).not.toContain("Use a saved secret");
    expect(storeless).not.toContain('aria-label="How the key is given"');
    expect(storeless).not.toContain('aria-label="Secret"');
    expect(storeless).not.toContain(">Add provider<");
    expect(storeless).toContain("This board keeps no company secrets, and its operator shares no key names");
    // In a company's words: the chart's settings are the operator's.
    expect(storeless).toContain("Ask your operator to turn on a secret store for companies");
    expect(storeless).not.toContain("board.oauth.enabled");
    // A server that takes no key needs neither, and the note says so while the kind offers one.
    expect(storeless).toContain("An OpenAI-compatible server that takes no key can be added now.");
    const sharing = panel({
      features: { oauth: false, objectStore: false, sharedEnvNames: ["SHARED_MODELS_KEY"] },
    });
    expect(sharing).toContain("This board keeps no company secrets, so a key cannot be pasted here");
    expect(sharing).toContain("Use a name your operator shares");
    // Someone who may not manage providers gets no form at all.
    const viewer = panel({ canEdit: false });
    expect(viewer).not.toContain("<input");
    expect(viewer).not.toContain("Add a provider");
    expect(viewer).toContain("Acme Anthropic");
  });

  it("lists this board's own models first: each CLI and the API key, and whether it works where the board runs", () => {
    const html = panel();
    expect(html.indexOf("This board&#x27;s own models")).toBeGreaterThan(-1);
    expect(html.indexOf("This board&#x27;s own models")).toBeLessThan(html.indexOf("Your model providers"));
    expect(html).toContain("Claude Code CLI");
    expect(html).toContain("signed in (claude.ai, max)");
    expect(html).toContain("Codex CLI");
    expect(html).toContain("signed in using ChatGPT");
    expect(html).toContain("no ANTHROPIC_API_KEY on the board");
    expect(html.match(/>works here</g)).toHaveLength(2);
    expect(html.match(/>not available</g)).toHaveLength(1);
    expect(html).toContain("Check again");
    // Where each brain is picked: every teammate's page, Peter's too.
    expect(html).toContain(
      "Pick each brain on the teammate&#x27;s page under Teammates, Peter&#x27;s included.",
    );
    // A viewer sees them too: they are the board's, not the company's to change.
    expect(panel({ canEdit: false })).toContain("signed in using ChatGPT");
  });

  it("checks a provider's key, says what it found, and offers the models it reaches when one is added", () => {
    const at = "2026-10-22T11:58:00.000Z";
    const reached = [
      {
        id: "claude-opus-5-5",
        family: "claude" as const,
        label: "Claude Opus 5.5",
        contextWindow: 1_000_000,
      },
      { id: "claude-sonnet-5-5", family: "claude" as const, label: "Claude Sonnet 5.5" },
    ];
    const ok = { ok: true, at, latencyMs: 210, detail: null, listed: 2, models: reached };
    expect(checkLine({ lastCheck: ok }, NOW)).toBe("Checked 2 min ago: key works, reaches 2 models");
    expect(
      checkLine(
        {
          lastCheck: {
            ...ok,
            ok: false,
            listed: 0,
            models: undefined,
            detail: "the key was refused (HTTP 401)",
          },
        },
        NOW,
      ),
    ).toBe("Checked 2 min ago: the key was refused (HTTP 401)");
    // An Azure resource lists the models it offers, never the deployments a model here names.
    expect(checkLine({ kind: "azure_openai", lastCheck: { ...ok, listed: 1, models: [] } }, NOW)).toBe(
      "Checked 2 min ago: key works; the resource offers 1 model, and a model here is one of your deployments, by its name",
    );

    // What the list does not have yet is offered; nothing after a check that failed, nothing on Azure.
    const checked = provider({ lastCheck: ok });
    expect(suggestedModels(checked).map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
    expect(suggestedModels(provider({ lastCheck: { ...ok, ok: false } }))).toEqual([]);
    expect(suggestedModels(provider({ kind: "azure_openai", lastCheck: ok }))).toEqual([]);
    // A model the key did not reach says so, once the check listed all it reaches; never a name that may stand
    // for a listed one (an alias, a tag left off, an ARN), and never on Azure.
    const typo = { id: "claude-opsu-5-5", source: "typed" as const };
    expect(unreached(checked, typo)).toBe(true);
    expect(unreached(checked, { id: "claude-opus-5-5", source: "typed" })).toBe(false);
    expect(unreached(checked, { ...typo, source: "listed" })).toBe(false);
    expect(unreached(checked, { id: "claude-sonnet-5", source: "typed" })).toBe(false);
    const ollama = provider({
      kind: "openai_compatible",
      lastCheck: { ...ok, listed: 1, models: [{ id: "llama3.2:latest", family: "other" }] },
    });
    expect(unreached(ollama, { id: "llama3.2", source: "typed" })).toBe(false);
    expect(unreached(ollama, { id: "qwen3", source: "typed" })).toBe(true);
    expect(
      unreached(checked, { id: "arn:aws:bedrock:us-east-1:0:inference-profile/x", source: "typed" }),
    ).toBe(false);
    expect(unreached(provider({ lastCheck: { ...ok, listed: 900 } }), typo)).toBe(false);
    expect(unreached(provider({ kind: "azure_openai", lastCheck: ok }), typo)).toBe(false);
    expect(unreached(provider({ lastCheck: null }), typo)).toBe(false);

    // On the page, two minutes before now, whenever the test runs.
    const shown = provider({
      models: [
        { id: "claude-opus-5-5", family: "claude", label: "Opus", source: "listed" },
        { id: "claude-opsu-5-5", family: "claude", source: "typed" },
      ],
      lastCheck: { ...ok, at: new Date(Date.now() - 2 * 60_000).toISOString() },
    });
    const html = panel({ initial: { ...providers, providers: [shown, ...providers.providers.slice(1)] } });
    expect(html).toContain('aria-label="Check Acme Anthropic"');
    // Not a kind whose Check is not recorded yet: it says so instead. Nor an archived provider, or one of a kind
    // no longer offered.
    expect(html).not.toContain('aria-label="Check Local vLLM"');
    expect(html).toContain("Check isn&#x27;t available for OpenAI-compatible providers yet");
    expect(checkLine({ kind: "bedrock", lastCheck: null })).toBe(
      "Check isn't available for Amazon Bedrock providers yet",
    );
    expect(checkLine({ kind: "anthropic", lastCheck: null })).toBe("Not checked yet");
    expect(html).not.toContain('aria-label="Check Old Bedrock"');
    expect(html).toContain("Checked 2 min ago: key works, reaches 2 models");
    expect(html.match(/ · not among the models the key reaches/g)).toHaveLength(1);
    expect(html).toMatch(
      /claude-opsu-5-5<\/td>.*?Runs on Claude Code · not among the models the key reaches<\/td>/,
    );
    // The model id field offers what the key reaches and the list lacks, by the provider's own names.
    expect(html).toMatch(
      /<datalist id="[^"]+"><option value="claude-sonnet-5-5">Claude Sonnet 5.5<\/option><\/datalist>/,
    );
    expect(html).toContain("Type to pick one of the 1 more the key reaches");
    expect(html).not.toContain('<option value="claude-opus-5-5"');
    // Someone who may not manage providers sees what was found, and cannot check.
    const viewer = panel({ canEdit: false, initial: { ...providers, providers: [shown] } });
    expect(viewer).toContain("Checked 2 min ago: key works, reaches 2 models");
    expect(viewer).not.toContain("Check Acme Anthropic");
  });

  it("says what removing takes and leaves, and never makes a name from a label that looks like a key", () => {
    expect(removeLine(providers.providers[0]!)).toBe(
      "Remove Acme Anthropic? Its settings, its list of models and its prices go, for good. Its key stays in this company's secrets as MODELS_ACME_KEY. Archive it instead to keep it all, unused.",
    );
    expect(removeLine({ ...providers.providers[1]!, credentials: {} })).not.toContain("key stays");
    // A name the operator shares is theirs, not the company's; a name with nothing set leaves nothing behind.
    const shared = {
      ...providers.providers[0]!,
      credentialStates: { apiKey: { state: "shared" as const } },
    };
    expect(removeLine(shared)).toContain(
      "Its key, MODELS_ACME_KEY, is one your operator shares, and stays theirs.",
    );
    expect(
      removeLine({ ...providers.providers[0]!, credentialStates: { apiKey: { state: "missing" as const } } }),
    ).not.toContain("MODELS_ACME_KEY");
    // A Mistral-style key pasted into Label: nothing is made from it, and nothing is sent.
    const key = ["mR7", "xQ2pL9", "vN4kT8", "wZ1sJ5", "bH3cY6", "dG0"].join("");
    expect(formName(form({ label: key }))).toBe("");
    expect(formProblem(form({ label: key }), nothingTaken)).toBe(
      "That label looks like a key. The key goes in its own field below.",
    );
  });
});

describe("the key a provider is added with", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is sent only as a new name: If-None-Match: *, the value in the body alone", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ name: "MODELS_ACME_KEY", updatedAt: "", updatedBy: daniel }), {
        status: 200,
      });
    });
    await httpClient.setNewSecret("c-1", "MODELS_ACME_KEY", "pasted-value");
    await httpClient.setSecret("c-1", "HUBSPOT_MCP_TOKEN", "rotated-value");
    expect(
      sent.map((s) => [s.init.method, s.url, (s.init.headers as Record<string, string>)["if-none-match"]]),
    ).toEqual([
      ["PUT", "/api/companies/c-1/secrets/MODELS_ACME_KEY", "*"],
      // Settings > Connections > Secrets sets and replaces, as before.
      ["PUT", "/api/companies/c-1/secrets/HUBSPOT_MCP_TOKEN", undefined],
    ]);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ value: "pasted-value" });
    expect(sent[0]!.url).not.toContain("pasted-value");
  });
});
