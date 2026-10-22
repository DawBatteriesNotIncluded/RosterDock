// Company model providers on the web: one Activity sentence per event, in a manager's words, from names only;
// and Settings > Models.
import type { EventRecord, EventType } from "@rosterdock/shared";
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
  providerInput,
  providerSlug,
  saveProvider,
  suggestedSecretName,
  whereLine,
  type ModelsPanelProps,
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
  credentialStates: { apiKey: { state: "set", setAt: "2026-10-19T12:00:00.000Z", setBy: daniel } },
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
      models: [],
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
    const set = providers.providers[0]!.credentialStates.apiKey;
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
    expect(boardLine(false)).toBe("Not lent: every teammate needs one of your providers");
    expect(checkLine({ lastCheck: null })).toBe("Not checked yet");
  });

  it("saves names only, each kind with its own fields", () => {
    const form = {
      label: "Acme",
      name: "acme",
      endpoint: " https://llm.example.com/v1 ",
      region: " us-east-1 ",
      authHeader: "api-key" as const,
      credentialName: "MODELS_ACME_KEY",
    };
    expect(providerInput({ ...form, kind: "bedrock" })).toEqual({
      kind: "bedrock",
      name: "acme",
      label: "Acme",
      region: "us-east-1",
      credentials: { bearerToken: "MODELS_ACME_KEY" },
    });
    expect(providerInput({ ...form, kind: "openai_compatible" })).toEqual({
      kind: "openai_compatible",
      name: "acme",
      label: "Acme",
      endpoint: "https://llm.example.com/v1",
      authHeader: "api-key",
      credentials: { apiKey: "MODELS_ACME_KEY" },
    });
    // A keyless server names no key and no header.
    expect(providerInput({ ...form, kind: "openai_compatible", credentialName: null })).toEqual({
      kind: "openai_compatible",
      name: "acme",
      label: "Acme",
      endpoint: "https://llm.example.com/v1",
      credentials: {},
    });
  });

  it("sets a pasted key in the company's secrets before it saves the provider, and saves nothing if it cannot", async () => {
    const calls: string[] = [];
    const input = providerInput({
      kind: "anthropic",
      label: "Acme",
      name: "acme",
      endpoint: "",
      region: "",
      authHeader: "authorization",
      credentialName: "MODELS_ACME_KEY",
    });
    await saveProvider(
      input,
      { name: "MODELS_ACME_KEY", value: "pasted" },
      {
        setSecret: async (name) => void calls.push(`PUT /secrets/${name}`),
        create: async (body) => {
          calls.push(`POST /model-providers ${JSON.stringify(body.credentials)}`);
          return providers.providers[0]!;
        },
      },
    );
    expect(calls).toEqual([
      "PUT /secrets/MODELS_ACME_KEY",
      'POST /model-providers {"apiKey":"MODELS_ACME_KEY"}',
    ]);
    // The value never reaches the provider's body.
    expect(calls.join(" ")).not.toContain("pasted");

    const refused: string[] = [];
    await expect(
      saveProvider(
        input,
        { name: "MODELS_ACME_KEY", value: "pasted" },
        {
          setSecret: async () => Promise.reject(new Error("no secret store")),
          create: async () => {
            refused.push("POST");
            return providers.providers[0]!;
          },
        },
      ),
    ).rejects.toThrow("no secret store");
    expect(refused).toEqual([]);
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
    expect(html).toContain("Not lent: every teammate needs one of your providers");
    expect(html).toContain("Teammates do not think with them yet");
    // Archived, of a kind no longer offered, and its key not set.
    expect(html).toContain("Archived");
    expect(html).toContain("Turned off by your operator");
    expect(html).toContain("not set yet");
    // Bedrock is not offered here: its choice in the form is there, and disabled.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Amazon Bedrock<\/button>/);
    // Tokens only, so both themes hold.
    expect(html).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  it("takes a value in one field only: the pasted key, for owners and admins, with a secret store", () => {
    const passwords = (html: string) => html.match(/type="password"/g)?.length ?? 0;
    const html = panel();
    expect(passwords(html)).toBe(1);
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
