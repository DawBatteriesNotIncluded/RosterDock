// Settings > Models: what the company thinks with. This board's own models first (the Claude Code and Codex
// CLIs and the Anthropic API key, each with whether it works where the board runs), then the company's own
// model accounts: each provider with where it is reached, where its key comes from (never the key), its Check
// (whether the key works, and the models it reaches, offered when a model is added) and the models it serves,
// and a form per kind to add one. A key pasted here goes write-only into the company's
// secrets (PUT /secrets/:name) before the provider is saved with that name; it is the only value this page
// ever takes, and it is never shown again.
import { Trash2 } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import type {
  ListedModel,
  ModelFamily,
  ModelPriceInput,
  ModelProviderInput,
  ProviderKind,
  ProviderModel,
  UpdateModelProviderInput,
} from "@rosterdock/shared";
import {
  azureEndpoint,
  BEDROCK_REGION_RE,
  COMPATIBLE_AUTH_HEADERS,
  compatibleEndpoint,
  engineFor,
  FAMILY_LABELS,
  familiesFor,
  labelLooksLikeKey,
  modelIdProblem,
  MAX_PROVIDER_LABEL,
  nameLooksLikeKey,
  PROVIDER_KIND_LABELS,
  PROVIDER_KINDS,
  providerNameRefusal,
  type CompatibleAuthHeader,
} from "@rosterdock/shared/providers";
import type {
  CompanyData,
  CompanySecret,
  CredentialState,
  Features,
  ListPricesResult,
  ModelPrice,
  ModelProvider,
  ModelProviders,
  PlannerInfo,
} from "../api/types.ts";
import { Button, Field, Pill, Segs, Tip } from "../components/ui.tsx";
import { actorInfo, relativeTime, toMinor } from "../lib/format.ts";
import { money } from "./CostsView.tsx";

export interface ModelsPanelProps {
  data: Pick<CompanyData, "teammates" | "members" | "events">;
  canEdit: boolean;
  /** Without a secret store (features.oauth) a key cannot be pasted here; saved and shared names still work. */
  features: Features;
  load(): Promise<ModelProviders>;
  loadSecrets(): Promise<CompanySecret[]>;
  /** Sets a pasted key under a new name only: never over a value already set (the board refuses with 409). */
  setSecret(name: string, value: string): Promise<unknown>;
  /** Sets or replaces the value under a provider's key name: a key not set yet, or one rotated. */
  replaceSecret(name: string, value: string): Promise<unknown>;
  /** Would the board add this provider? Asked before a key is set, so a refusal leaves no key behind. */
  checkNew(input: ModelProviderInput): Promise<unknown>;
  create(input: ModelProviderInput): Promise<ModelProvider>;
  update(id: string, input: UpdateModelProviderInput): Promise<ModelProvider>;
  remove(id: string): Promise<void>;
  /** Check: whether its key works and which models it reaches, with one free call the board makes. */
  check(id: string): Promise<ModelProvider>;
  initial?: ModelProviders;
  initialSecrets?: CompanySecret[];
  /** The company's prices: a provider's are the ones with its id. */
  loadPrices(): Promise<ModelPrice[]>;
  savePrice(input: ModelPriceInput): Promise<ModelPrice>;
  deletePrice(priceId: string): Promise<void>;
  /** List prices for one provider's Claude models: Anthropic's at the list, Bedrock's as estimates. */
  fillListPrices(providerId: string): Promise<ListPricesResult>;
  initialPrices?: ModelPrice[];
  /** This board's own models: each CLI and the API key, and whether it works where the board runs. */
  loadBoardModels(refresh?: boolean): Promise<Pick<PlannerInfo, "options">>;
  initialBoardModels?: Pick<PlannerInfo, "options">;
}

/** A provider's short name from what people call it: acme-azure from "Acme Azure (prod)". */
export function providerSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** The name a pasted key is kept under in the company's secrets: MODELS_ACME_AZURE_KEY. */
export function suggestedSecretName(name: string): string {
  const core = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `MODELS_${core || "PROVIDER"}_KEY`;
}

/** The credential each kind takes: a Bedrock API key is a bearer token; the others an API key. */
export function credentialRole(kind: ProviderKind): "apiKey" | "bearerToken" {
  return kind === "bedrock" ? "bearerToken" : "apiKey";
}

/** Where a credential name gets its value, in a sentence: when and by whom, shared, or not yet. */
export function credentialLine(
  state: CredentialState | undefined,
  data: Pick<CompanyData, "teammates" | "members">,
  now: number = Date.now(),
): string {
  if (!state || state.state === "missing") return "not set yet";
  if (state.state === "shared") return "shared by your operator";
  return `set ${relativeTime(state.setAt, now)} by ${actorInfo(data, state.setBy)?.name ?? "someone"}`;
}

/** Which engine runs a model, for its row. */
export function engineLine(kind: ProviderKind, family: ModelFamily): string {
  const engine = engineFor(kind, family);
  return engine === "claude_code"
    ? "Runs on Claude Code"
    : engine === "codex"
      ? "Runs on Codex"
      : "No engine here runs it";
}

/** Where the board reaches a provider. */
export function whereLine(p: Pick<ModelProvider, "kind" | "endpoint" | "region">): string {
  switch (p.kind) {
    case "anthropic":
      return "api.anthropic.com";
    case "openai":
      return "api.openai.com";
    case "bedrock":
      return `Bedrock in ${p.region ?? "?"}`;
    case "azure_openai":
    case "openai_compatible":
      return p.endpoint ?? "?";
  }
}

/**
 * Whether teammates may keep the board's own models, in a sentence. Until teammates think with a provider,
 * every one still uses the board's own, whatever the operator lends.
 */
export function boardLine(board: boolean): string {
  return board
    ? "Your operator lends these to every company."
    : "Not lent by your operator. Once teammates think with your providers, each will need one.";
}

/**
 * The last check, in a sentence; nothing checked yet says so. An Azure resource lists the models it offers, not
 * your deployments, which are what a model here names.
 */
export function checkLine(
  p: Pick<ModelProvider, "lastCheck"> & { kind?: ProviderKind },
  now: number = Date.now(),
): string {
  const c = p.lastCheck;
  if (!c) return "Not checked yet";
  const when = `Checked ${relativeTime(c.at, now)}`;
  if (!c.ok) return `${when}: ${c.detail ?? "no answer"}`;
  const models = `${c.listed} model${c.listed === 1 ? "" : "s"}`;
  return p.kind === "azure_openai"
    ? `${when}: key works; the resource offers ${models}, and a model here is one of your deployments, by its name`
    : `${when}: key works, reaches ${models}`;
}

/**
 * The models the last check found that the list does not have yet, for a person to add from. None for Azure,
 * whose resource lists its models, not your deployments.
 */
export function suggestedModels(p: Pick<ModelProvider, "kind" | "lastCheck" | "models">): ListedModel[] {
  if (p.kind === "azure_openai" || !p.lastCheck?.ok) return [];
  const listed = new Set(p.models.map((m) => m.id));
  return (p.lastCheck.models ?? []).filter((m) => !listed.has(m.id));
}

/**
 * Whether a model on the list is one the key did not reach at its last check: only when that check listed every
 * model the key reaches, never on Azure, whose list names no deployment, and never for a name that may stand
 * for a listed one: an alias of a dated id (claude-opus-4-5 for claude-opus-4-5-20251101), a tag left off
 * (llama3.2 for llama3.2:latest), or an ARN.
 */
export function unreached(
  p: Pick<ModelProvider, "kind" | "lastCheck">,
  model: Pick<ProviderModel, "id" | "source">,
): boolean {
  const c = p.lastCheck;
  if (p.kind === "azure_openai" || !c?.ok || (c.models?.length ?? 0) < c.listed) return false;
  if (model.source === "listed" || model.id.startsWith("arn:")) return false;
  return !(c.models ?? []).some(
    (m) => m.id === model.id || m.id.startsWith(`${model.id}-`) || m.id.startsWith(`${model.id}:`),
  );
}

/** A price per million tokens, in and out, in a line. */
function perMillion(p: Pick<ModelPrice, "inputPerMillion" | "outputPerMillion" | "currency">): string {
  return `${money(p.inputPerMillion, p.currency)} in · ${money(p.outputPerMillion, p.currency)} out per million`;
}

/**
 * What a model through a provider costs, in a line, in the order the board prices it: the provider's own price;
 * else this board's own price for the model; else, for an Anthropic provider, Anthropic's list price (when the
 * company's prices are in its currency, USD); else none yet.
 */
export function modelPriceLine(
  provider: Pick<ModelProvider, "id" | "kind">,
  model: { id: string; listPrice?: boolean },
  prices: readonly ModelPrice[],
): string {
  const own = prices.find((x) => x.providerId === provider.id && x.model === model.id);
  if (own) return `${perMillion(own)}${own.estimate ? " · an estimate: check your AWS price" : ""}`;
  // A seat on the board's own models says nothing of what a provider's tokens cost.
  const board = prices.find((x) => x.providerId === null && x.model === model.id && perTokenPrice(x));
  if (board) return `${perMillion(board)}, this board's own price for the model`;
  // The company's one currency is its prices'; before it has any, the list's may be its first.
  const currency = prices[0]?.currency ?? null;
  if (provider.kind === "anthropic" && model.listPrice && (currency === null || currency === "USD"))
    return "Anthropic's list price";
  return "No price yet";
}

/** Whether a price says what tokens cost: a seat alone does not. */
function perTokenPrice(p: ModelPrice): boolean {
  return [p.inputPerMillion, p.outputPerMillion, p.cacheReadPerMillion, p.cacheWritePerMillion].some(
    (v) => v !== null,
  );
}

/** What filling list prices did, in a sentence or two. */
export function listFillLine(kind: ProviderKind, r: ListPricesResult): string {
  const parts = [
    r.added.length
      ? kind === "bedrock"
        ? `Priced ${r.added.join(", ")} at Anthropic's list price, as estimates: check your AWS price.`
        : `Priced ${r.added.join(", ")} at Anthropic's list price.`
      : "Every Claude model here with a list price already has a price.",
  ];
  if (r.unknown.length)
    parts.push(
      `No list price for ${r.unknown.join(", ")}: set ${r.unknown.length === 1 ? "it" : "them"} by hand.`,
    );
  return parts.join(" ");
}

/** What the form asks for under each kind, for a person who has not done this before. */
export const KIND_HINTS: Record<ProviderKind, string> = {
  anthropic: "An Anthropic API key. Claude models run on Claude Code.",
  openai: "An OpenAI API key. OpenAI models run on Codex.",
  azure_openai:
    "Your resource's address, such as https://acme.openai.azure.com, and its key. A model here is your deployment's name.",
  bedrock:
    "The region your models are in, and a Bedrock API key. AWS recommends long-term API keys for exploration only.",
  openai_compatible:
    "The server's base URL, such as https://llm.example.com/v1, and its key if it takes one. Codex teammates need its Responses API; Peter can also use Chat Completions.",
};

/** How the credential is given: a key pasted now, a secret the company already set, a name the operator shares, or none. */
export type CredentialChoice = "paste" | "saved" | "shared" | "none";

/** What the add form holds. Only `value` is ever a value, and it goes to the company's secrets alone. */
export interface ProviderForm {
  kind: ProviderKind;
  label: string;
  /** The provider's name as typed; null: made from the label. */
  name: string | null;
  endpoint: string;
  region: string;
  authHeader: CompatibleAuthHeader;
  how: CredentialChoice;
  /** The pasted key, with `how` paste. */
  value: string;
  /** The saved secret or the shared name, with `how` saved or shared. */
  picked: string;
}

/**
 * Whether text holds twelve characters or more of a key in a row, letters and digits only, in either case. Only
 * a stretch with a digit and a letter in it counts: a key's words (Bedrock's start bedrock-api-key-) are words
 * a label may use too, and a random stretch of twelve almost always has both.
 */
export function holdsPartOf(text: string, key: string): boolean {
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = flat(text);
  const k = flat(key);
  for (let i = 0; i + 12 <= k.length; i++) {
    const part = k.slice(i, i + 12);
    if (/[0-9]/.test(part) && /[a-z]/.test(part) && t.includes(part)) return true;
  }
  return false;
}

/** The provider's name: as typed, or made from the label. */
export function formName(f: Pick<ProviderForm, "name" | "label">): string {
  if (f.name !== null) return f.name.trim();
  // Never made from a label that looks like a key: the key would be on the page, in the name and the key's name.
  return labelLooksLikeKey(f.label) ? "" : providerSlug(f.label);
}

/** The name a pasted key goes under, from the provider's name. */
export function formSecretName(f: Pick<ProviderForm, "name" | "label">): string {
  return suggestedSecretName(formName(f));
}

/**
 * What saving the form sends: the provider's body (names only), and with a pasted key, the name and value that
 * go to PUT /secrets/:name first. The key is never in the body; the body names it by the same name.
 */
export function formRequest(f: ProviderForm): {
  input: ModelProviderInput;
  paste: { name: string; value: string } | null;
} {
  const name = formName(f);
  const credentialName = f.how === "paste" ? formSecretName(f) : f.how === "none" ? "" : f.picked;
  const base = { name, label: f.label.trim() };
  const key = credentialName.trim();
  const input: ModelProviderInput =
    f.kind === "anthropic" || f.kind === "openai"
      ? { kind: f.kind, ...base, credentials: { apiKey: key } }
      : f.kind === "azure_openai"
        ? { kind: f.kind, ...base, endpoint: f.endpoint.trim(), credentials: { apiKey: key } }
        : f.kind === "bedrock"
          ? { kind: f.kind, ...base, region: f.region.trim(), credentials: { bearerToken: key } }
          : key
            ? {
                kind: f.kind,
                ...base,
                endpoint: f.endpoint.trim(),
                authHeader: f.authHeader,
                credentials: { apiKey: key },
              }
            : { kind: f.kind, ...base, endpoint: f.endpoint.trim(), credentials: {} };
  return { input, paste: f.how === "paste" ? { name: formSecretName(f), value: f.value } : null };
}

/**
 * Why the form cannot be saved as it is, by the board's own rules, so nothing the board would refuse is sent,
 * and above all no key is set under a name before the provider is: `missing` while something is left to fill
 * in, a sentence when something given will not do, null when it is ready.
 */
export function formProblem(
  f: ProviderForm,
  taken: {
    /** Every provider, archived ones included. */
    providers: readonly Pick<ModelProvider, "name" | "credentials">[];
    /** The company's secrets; null until they are loaded, and no key is pasted before. */
    secrets: readonly CompanySecret[] | null;
    /** The names the operator shares. */
    shared: readonly string[];
  },
): string | "missing" | null {
  const label = f.label.trim();
  const name = formName(f);
  if (label && labelLooksLikeKey(label))
    return "That label looks like a key. The key goes in its own field below.";
  // As typed, before any rule on its case: a key keeps its case here, and its case is what gives it away.
  const typed = f.name?.trim() ?? "";
  if (typed && (labelLooksLikeKey(typed) || nameLooksLikeKey(typed.replace(/-/g, "_"))))
    return "That name looks like a key. The key goes in its own field below.";
  if (f.how === "paste" && (holdsPartOf(label, f.value) || holdsPartOf(name, f.value)))
    return "The label or the name holds part of the key. The key goes in its own field below, and nowhere else.";
  if (label.length > MAX_PROVIDER_LABEL) return `A label is ${MAX_PROVIDER_LABEL} characters at most.`;
  const nameRefusal = name ? providerNameRefusal(name) : null;
  if (nameRefusal) return `The name: ${nameRefusal}.`;
  if (name && taken.providers.some((v) => v.name === name))
    return `This company already has a provider named ${name}, archived ones included. Give this one another name.`;
  if (f.kind === "azure_openai" && f.endpoint.trim() && !azureEndpoint(f.endpoint))
    return "The resource's address is https://<resource>.openai.azure.com or https://<resource>.services.ai.azure.com.";
  if (f.kind === "openai_compatible" && f.endpoint.trim() && !compatibleEndpoint(f.endpoint))
    return "The base URL is http or https, with no key, password or query in it.";
  if (f.kind === "bedrock" && f.region.trim() && !BEDROCK_REGION_RE.test(f.region.trim()))
    return "The region is an AWS region, such as us-east-1.";
  if (f.how === "paste" && name) {
    const secret = formSecretName(f);
    // A pasted key never replaces another: a secret of that name may be another provider's live key, and a
    // name the operator shares would be hidden from every connection behind this company's own value.
    if (taken.shared.includes(secret))
      return `${secret} is a name your operator shares. Give this provider another name.`;
    if (
      (taken.secrets ?? []).some((s) => s.name === secret) ||
      taken.providers.some((v) => Object.values(v.credentials).includes(secret))
    )
      return `${secret} is already set. Choose "Use a saved secret" to use it, or give this provider another name.`;
    if (taken.secrets === null) return "missing";
  }
  if (!label || !name) return "missing";
  if ((f.kind === "azure_openai" || f.kind === "openai_compatible") && !f.endpoint.trim()) return "missing";
  if (f.kind === "bedrock" && !f.region.trim()) return "missing";
  if (f.how === "paste" && !f.value.trim()) return "missing";
  // A pick a reload took away is no pick.
  if (f.how === "saved" && !(taken.secrets ?? []).some((s) => s.name === f.picked)) return "missing";
  if (f.how === "shared" && !taken.shared.includes(f.picked)) return "missing";
  return null;
}

/**
 * Save the form: nothing while it has a problem; else the board checks the provider, a pasted key goes
 * write-only into the company's secrets under a new name (never over one already set), and the provider is
 * saved with that name. A refusal at any step stops the rest: no key is set for a provider the board refuses.
 * Null: nothing was sent.
 */
export async function submitForm(
  f: ProviderForm,
  taken: Parameters<typeof formProblem>[1],
  deps: Pick<ModelsPanelProps, "checkNew" | "setSecret" | "create">,
): Promise<ModelProvider | null> {
  if (formProblem(f, taken) !== null) return null;
  const { input, paste } = formRequest(f);
  await deps.checkNew(input);
  if (paste) await deps.setSecret(paste.name, paste.value);
  return deps.create(input);
}

/**
 * This board's own models: the Claude Code and Codex CLIs and the Anthropic API key, each with whether it works
 * where the board runs. Teammates run on the CLIs on the workers; Peter plans with one of these on the board.
 */
function BoardModelsCard(p: {
  /** Whether the operator lends them to every company. */
  lent: boolean;
  load: ModelsPanelProps["loadBoardModels"];
  initial?: Pick<PlannerInfo, "options">;
}) {
  const [options, setOptions] = useState<PlannerInfo["options"] | null>(p.initial?.options ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async (refresh: boolean) => {
    setBusy(true);
    try {
      setOptions((await p.load(refresh)).options);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    // Loaded once; Check again asks the CLIs anew.
    if (!p.initial) void ask(false);
  }, []);
  return (
    <div className="card flex flex-col gap-2 px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">This board&apos;s own models</span>
        <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void ask(true)}>
          Check again
        </Button>
      </div>
      <span className="text-[13px]">{boardLine(p.lent)}</span>
      <span className="hint">
        A teammate on the Claude Code CLI or the Codex CLI runs it on the board&apos;s workers, signed in by
        your operator. Peter plans on the board itself, with one of these signed in where it runs. Pick each
        brain on the teammate&apos;s page under Teammates, Peter&apos;s included.
      </span>
      {options === null ? (
        <span className="hint">{error ?? "Asking the board what it has…"}</span>
      ) : (
        <table className="text-[13px]" style={{ borderCollapse: "collapse" }}>
          <tbody>
            {options.map((o) => (
              <tr key={o.kind} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="py-1 pr-3 font-semibold whitespace-nowrap">{o.label}</td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  <Pill tone="muted">{o.available ? "works here" : "not available"}</Pill>
                </td>
                <td className="hint py-1">{o.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {options !== null && error ? (
        <span className="text-[13px]" style={{ color: "var(--bad)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** What a person calls a family. */
function familyName(f: ModelFamily): string {
  return f === "other" ? "Another family" : FAMILY_LABELS[f];
}

/** The models as a change sends them back: what the person gave, never where the board says they came from. */
function given(models: readonly ProviderModel[]) {
  return models.map(({ id, label, family, contextWindow }) => ({
    id,
    family,
    ...(label ? { label } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  }));
}

function AddProviderForm(p: {
  offered: ProviderKind[];
  features: Features;
  /** Null until loaded. */
  secrets: CompanySecret[] | null;
  /** They could not be loaded: no key is pasted, and the form says why. */
  secretsFailed?: boolean;
  /** Every provider, archived ones included. */
  providers: ModelProvider[];
  /** Null once saved; else why not, shown under the form, which stays as it was. */
  onSubmit(f: ProviderForm, taken: Parameters<typeof formProblem>[1]): Promise<string | null>;
}) {
  const canPaste = p.features.oauth;
  const shared = p.features.sharedEnvNames ?? [];
  const saved = p.secrets ?? [];
  // How a key may be given here: pasted only with a secret store; a saved secret only when there is one to pick.
  const choicesFor = (kind: ProviderKind): { value: CredentialChoice; label: string }[] => [
    ...(canPaste ? [{ value: "paste" as const, label: "Paste a key" }] : []),
    ...(saved.length ? [{ value: "saved" as const, label: "Use a saved secret" }] : []),
    ...(shared.length ? [{ value: "shared" as const, label: "Use a name your operator shares" }] : []),
    ...(kind === "openai_compatible" ? [{ value: "none" as const, label: "No key" }] : []),
  ];
  const firstKind = PROVIDER_KINDS.find((k) => p.offered.includes(k)) ?? "anthropic";
  const blank: ProviderForm = {
    kind: firstKind,
    label: "",
    name: null,
    endpoint: "",
    region: "",
    authHeader: "authorization",
    how: "paste",
    value: "",
    picked: "",
  };
  const [f, setForm] = useState<ProviderForm>(blank);
  const set = (change: Partial<ProviderForm>) => setForm((was) => ({ ...was, ...change }));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const taken = { providers: p.providers, secrets: p.secrets, shared };
  const choices = choicesFor(f.kind);
  // Always one of this kind's ways, never a way it does not offer (another kind's, or a saved secret before the
  // list loads); null when the board offers none, and then no picker shows, only why.
  const how = choices.find((c) => c.value === f.how)?.value ?? choices[0]?.value ?? null;
  const given: ProviderForm | null = how ? { ...f, how } : null;
  const problem = given ? formProblem(given, taken) : "missing";
  const secretName = formSecretName(f);
  const turnedOff = PROVIDER_KINDS.filter((k) => !p.offered.includes(k));
  const save = async () => {
    if (!given) return;
    setBusy(true);
    const why = await p.onSubmit(given, taken);
    setBusy(false);
    setRefusal(why);
    if (why === null) setForm({ ...blank, kind: f.kind });
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <span className="font-semibold">Add a provider</span>
      <Segs
        label="Kind"
        value={f.kind}
        onChange={(k) => set({ kind: k, picked: "" })}
        options={PROVIDER_KINDS.filter((k) => p.offered.includes(k)).map((k) => ({
          value: k,
          label: PROVIDER_KIND_LABELS[k],
        }))}
      />
      {turnedOff.length ? (
        <span className="hint">
          Turned off by your operator: {turnedOff.map((k) => PROVIDER_KIND_LABELS[k]).join(", ")}.
        </span>
      ) : null}
      <span className="hint">{KIND_HINTS[f.kind]}</span>
      <div className="flex flex-wrap gap-3">
        <Field label="Label" hint="What people read, such as Acme Azure (prod)">
          <input
            aria-label="Label"
            value={f.label}
            onChange={(e) => set({ label: e.target.value })}
            style={{ width: 220 }}
          />
        </Field>
        <Field label="Name" hint="Short, lowercase; teammates' settings use it">
          <input
            aria-label="Name"
            className="mono"
            value={f.name ?? formName(f)}
            // Once typed, the name is the person's, cleared or not, and kept as typed: the form says what will
            // not do, and a key pasted here keeps the case that gives it away.
            onChange={(e) => set({ name: e.target.value })}
            style={{ width: 180 }}
          />
        </Field>
        {f.kind === "azure_openai" || f.kind === "openai_compatible" ? (
          <Field label={f.kind === "azure_openai" ? "Resource address" : "Base URL"}>
            <input
              aria-label={f.kind === "azure_openai" ? "Resource address" : "Base URL"}
              className="mono"
              value={f.endpoint}
              onChange={(e) => set({ endpoint: e.target.value })}
              placeholder={
                f.kind === "azure_openai" ? "https://acme.openai.azure.com" : "https://llm.example.com/v1"
              }
              style={{ width: 280 }}
            />
          </Field>
        ) : null}
        {f.kind === "bedrock" ? (
          <Field label="Region">
            <input
              aria-label="Region"
              className="mono"
              value={f.region}
              onChange={(e) => set({ region: e.target.value })}
              placeholder="us-east-1"
              style={{ width: 140 }}
            />
          </Field>
        ) : null}
        {f.kind === "openai_compatible" && how !== "none" ? (
          <Field label="Key goes in">
            <select
              aria-label="Key goes in"
              value={f.authHeader}
              onChange={(e) => set({ authHeader: e.target.value as CompatibleAuthHeader })}
            >
              {COMPATIBLE_AUTH_HEADERS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      {how ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={f.kind === "bedrock" ? "Bedrock API key" : "Key"}>
            <select
              aria-label="How the key is given"
              value={how}
              onChange={(e) => set({ how: e.target.value as CredentialChoice, picked: "", value: "" })}
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {how === "paste" ? (
            <Field
              label={`Value for ${secretName}`}
              hint="Goes into this company's secrets under that name and is never shown again"
            >
              <input
                aria-label={`Value for ${secretName}`}
                type="password"
                autoComplete="off"
                className="mono"
                value={f.value}
                onChange={(e) => set({ value: e.target.value })}
                placeholder="paste the key"
                style={{ width: 260 }}
              />
            </Field>
          ) : how === "saved" ? (
            <Field
              label="Secret"
              {...(canPaste ? { hint: "Set under Settings > Connections > Secrets" } : {})}
            >
              <select aria-label="Secret" value={f.picked} onChange={(e) => set({ picked: e.target.value })}>
                <option value="">Pick one</option>
                {saved.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : how === "shared" ? (
            <Field label="Shared name">
              <select
                aria-label="Shared name"
                value={f.picked}
                onChange={(e) => set({ picked: e.target.value })}
              >
                <option value="">Pick one</option>
                {shared.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Button variant="primary" disabled={problem !== null || busy} onClick={() => void save()}>
            Add provider
          </Button>
        </div>
      ) : (
        // No way to give this kind a key here: say so where the key would go, never a picker with nothing in it.
        <div className="note">
          <span>
            This board keeps no company secrets, and its operator shares no key names, so there is no key to
            give a provider here yet.
          </span>
          <span className="hint">
            Ask your operator to turn on a secret store for companies, or to share a key&apos;s name with
            them.
            {p.offered.includes("openai_compatible")
              ? " An OpenAI-compatible server that takes no key can be added now."
              : ""}
          </span>
        </div>
      )}
      {problem && problem !== "missing" ? <span className="hint">{problem}</span> : null}
      {refusal ? (
        <span className="text-[13px]" style={{ color: "var(--bad)" }}>
          {refusal}
        </span>
      ) : null}
      {!canPaste && how ? (
        <span className="hint">
          {choices.some((c) => c.value !== "none")
            ? "This board keeps no company secrets, so a key cannot be pasted here: use a name your operator shares. "
            : "This board keeps no company secrets, and its operator shares no key names: only a server that takes no key can be added here. "}
          Ask your operator to turn on a secret store for companies, or to share a key&apos;s name with them.
        </span>
      ) : null}
      {p.secretsFailed && how === "paste" ? (
        <span className="hint">
          This company&apos;s secrets could not be read, so a key cannot be pasted now, nor a saved one
          picked. Reload the page to read them again.
        </span>
      ) : null}
    </div>
  );
}

function AddModelForm(p: {
  kind: ProviderKind;
  /** What people call the provider, so each card's fields have names of their own. */
  of: string;
  listed: readonly string[];
  /** The models the key reaches that the list does not have yet: offered as the id is typed. */
  suggestions: readonly ListedModel[];
  /** Null once added; else why not, shown beside the form. */
  onAdd(id: string, family: ModelFamily, label: string, contextWindow?: number): Promise<string | null>;
}) {
  const families = familiesFor(p.kind);
  const listId = useId();
  const [id, setId] = useState("");
  // A compatible server's models are seldom Claude's or OpenAI's own.
  const [family, setFamily] = useState<ModelFamily>(p.kind === "openai_compatible" ? "other" : families[0]!);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The label a picked model filled in, until the person types their own: it goes when the id moves off it.
  const [filled, setFilled] = useState<string | null>(null);
  // A model picked from what the key reaches: whose it is, its name and its context window, as the provider said.
  const picked = p.suggestions.find((s) => s.id === id.trim());
  const typeId = (next: string) => {
    setId(next);
    const hit = p.suggestions.find((s) => s.id === next.trim());
    if (!hit) {
      if (filled !== null && label === filled) setLabel("");
      setFilled(null);
      return;
    }
    if (families.includes(hit.family)) setFamily(hit.family);
    if ((!label.trim() || label === filled) && hit.label && !labelLooksLikeKey(hit.label)) {
      setLabel(hit.label);
      setFilled(hit.label);
    }
  };
  // The board's own rules, said before anything is sent; a label that looks like a key is refused there too.
  const problem = !id.trim()
    ? null
    : (modelIdProblem(p.kind, family, id, p.listed) ??
      (label.trim() && labelLooksLikeKey(label) ? "That label looks like a key." : null));
  const add = async () => {
    setBusy(true);
    const why = await p.onAdd(id.trim(), family, label.trim(), picked?.contextWindow);
    setBusy(false);
    setRefusal(why);
    if (why !== null) return;
    setId("");
    setLabel("");
    setFilled(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Add a model id"
          hint={
            p.kind === "azure_openai"
              ? "Your deployment's name"
              : p.suggestions.length
                ? `Type to pick one of the ${p.suggestions.length} more the key reaches`
                : undefined
          }
        >
          <input
            aria-label={`Model id for ${p.of}`}
            className="mono"
            value={id}
            onChange={(e) => typeId(e.target.value)}
            {...(p.suggestions.length ? { list: listId } : {})}
            style={{ width: 240 }}
          />
        </Field>
        {p.suggestions.length ? (
          <datalist id={listId}>
            {p.suggestions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label ?? s.id}
              </option>
            ))}
          </datalist>
        ) : null}
        {families.length > 1 ? (
          <Field label="Whose model">
            <select
              aria-label={`Whose model, for ${p.of}`}
              value={family}
              onChange={(e) => setFamily(e.target.value as ModelFamily)}
            >
              {families.map((f) => (
                <option key={f} value={f}>
                  {familyName(f)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Label">
          <input
            aria-label={`Model label for ${p.of}`}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setFilled(null);
            }}
            style={{ width: 160 }}
          />
        </Field>
        <Button
          size="sm"
          aria-label={`Add the model to ${p.of}`}
          disabled={!id.trim() || problem !== null || busy}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      {(problem ?? refusal) ? (
        <span className="text-[13px]" style={problem ? {} : { color: "var(--bad)" }}>
          {problem ?? refusal}
        </span>
      ) : null}
    </div>
  );
}

/** What removing a provider takes and what it leaves, said before it goes. */
export function removeLine(
  v: Pick<ModelProvider, "label" | "credentials" | "credentialStates" | "kind">,
): string {
  const role = credentialRole(v.kind);
  const key = v.credentials[role];
  const state = v.credentialStates[role]?.state;
  const kept = !key
    ? ""
    : state === "shared"
      ? ` Its key, ${key}, is one your operator shares, and stays theirs.`
      : state === "set"
        ? ` Its key stays in this company's secrets as ${key}.`
        : "";
  return `Remove ${v.label}? Its settings, its list of models and its prices go, for good.${kept} Archive it instead to keep it all, unused.`;
}

/** A provider's settings, changed: its label, where it is reached, and its key's name or value. */
function EditProvider(p: {
  provider: ModelProvider;
  secrets: readonly CompanySecret[];
  shared: readonly string[];
  /** Whether a value may be set here: the board keeps a secret store. */
  canSetValue: boolean;
  onSave(input: UpdateModelProviderInput): Promise<string | null>;
  /** Set or replace the value under the provider's key name: rotation, or a key not set yet. */
  onSetValue(name: string, value: string): Promise<string | null>;
  onClose(): void;
}) {
  const v = p.provider;
  const role = credentialRole(v.kind);
  const keyName = v.credentials[role] ?? "";
  const [label, setLabel] = useState(v.label);
  const [endpoint, setEndpoint] = useState(v.endpoint ?? "");
  const [region, setRegion] = useState(v.region ?? "");
  const [name, setName] = useState(keyName);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const names = [...new Set([keyName, ...p.secrets.map((x) => x.name), ...p.shared].filter(Boolean))];
  const problem =
    labelLooksLikeKey(label) || !label.trim()
      ? "A label is what people read, such as Acme Azure (prod)."
      : v.kind === "azure_openai" && !azureEndpoint(endpoint)
        ? "The resource's address is https://<resource>.openai.azure.com or https://<resource>.services.ai.azure.com."
        : v.kind === "openai_compatible" && !compatibleEndpoint(endpoint)
          ? "The base URL is http or https, with no key, password or query in it."
          : v.kind === "bedrock" && !BEDROCK_REGION_RE.test(region.trim())
            ? "The region is an AWS region, such as us-east-1."
            : null;
  const save = async () => {
    setBusy(true);
    const why = await p.onSave({
      label: label.trim(),
      ...(v.kind === "azure_openai" || v.kind === "openai_compatible" ? { endpoint: endpoint.trim() } : {}),
      ...(v.kind === "bedrock" ? { region: region.trim() } : {}),
      ...(name && name !== keyName ? { credentials: { [role]: name } } : {}),
    });
    setBusy(false);
    setSaid(why);
    if (why === null) p.onClose();
  };
  const setKey = async () => {
    setBusy(true);
    const why = await p.onSetValue(keyName, value);
    setBusy(false);
    setSaid(why);
    if (why === null) setValue("");
  };
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Label">
          <input
            aria-label={`Label of ${v.label}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ width: 220 }}
          />
        </Field>
        {v.kind === "azure_openai" || v.kind === "openai_compatible" ? (
          <Field label={v.kind === "azure_openai" ? "Resource address" : "Base URL"}>
            <input
              aria-label={`Address of ${v.label}`}
              className="mono"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              style={{ width: 280 }}
            />
          </Field>
        ) : null}
        {v.kind === "bedrock" ? (
          <Field label="Region">
            <input
              aria-label={`Region of ${v.label}`}
              className="mono"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              style={{ width: 140 }}
            />
          </Field>
        ) : null}
        {keyName || names.length ? (
          <Field label={role === "bearerToken" ? "Bedrock API key's name" : "Key's name"}>
            <select
              aria-label={`Key's name for ${v.label}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            >
              {/* A provider with no key yet shows that, never a name it does not have. */}
              {!keyName ? (
                <option value="">{v.kind === "openai_compatible" ? "No key" : "Pick one"}</option>
              ) : null}
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Button size="sm" variant="primary" disabled={busy || problem !== null} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" onClick={p.onClose}>
          Cancel
        </Button>
      </div>
      {keyName && p.canSetValue ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label={`New value for ${keyName}`}
            hint="Replaces the value under that name, for everything that names it, and is never shown again"
          >
            <input
              aria-label={`New value for ${keyName}`}
              type="password"
              autoComplete="off"
              className="mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{ width: 260 }}
            />
          </Field>
          <Button size="sm" disabled={busy || !value.trim()} onClick={() => void setKey()}>
            Set the value
          </Button>
        </div>
      ) : null}
      {(problem ?? said) ? (
        <span className="text-[13px]" style={problem ? {} : { color: "var(--bad)" }}>
          {problem ?? said}
        </span>
      ) : null}
    </div>
  );
}

/** One model's price on a provider: per million tokens, in the company's one currency. */
function PriceEditor(p: {
  model: string;
  currency: string;
  /** The company has no price yet, so this one sets its currency. */
  firstPrice: boolean;
  initial: ModelPrice | undefined;
  /** Null once saved, else why not: said under the editor, where it was asked. */
  onSave(input: Omit<ModelPriceInput, "model" | "providerId">): Promise<string | null>;
  /** Take the provider's own price away, so the board's own price for the model, or none, applies again. */
  onRemove?(): Promise<string | null>;
}) {
  const major = (minor: number | null | undefined) => (minor == null ? "" : (minor / 100).toFixed(2));
  const [typedCurrency, setCurrency] = useState(p.currency);
  // Typed only for the company's first price; after that, the company's.
  const currency = p.firstPrice ? typedCurrency : p.currency;
  const [input, setInput] = useState(major(p.initial?.inputPerMillion));
  const [output, setOutput] = useState(major(p.initial?.outputPerMillion));
  const [cacheRead, setCacheRead] = useState(major(p.initial?.cacheReadPerMillion));
  const [cacheWrite, setCacheWrite] = useState(major(p.initial?.cacheWritePerMillion));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const field = (label: string, value: string, set: (v: string) => void) => (
    <Field label={label}>
      <input
        aria-label={`${label} for ${p.model}`}
        className="mono"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        style={{ width: 90 }}
      />
    </Field>
  );
  return (
    <div className="flex flex-wrap items-end gap-2">
      {p.firstPrice ? (
        <Field
          label="Currency"
          hint="The first price sets the company's one currency. Anthropic's list prices are in USD."
        >
          <input
            aria-label="Currency"
            className="mono"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            style={{ width: 60 }}
          />
        </Field>
      ) : null}
      {field(`Input (${currency})`, input, setInput)}
      {field(`Output (${currency})`, output, setOutput)}
      {field("Cache read", cacheRead, setCacheRead)}
      {field("Cache write", cacheWrite, setCacheWrite)}
      <Button
        size="sm"
        disabled={
          busy || !/^[A-Z]{3}$/.test(currency) || (toMinor(input) === null && toMinor(output) === null)
        }
        onClick={async () => {
          setBusy(true);
          setRefusal(
            await p.onSave({
              currency,
              inputPerMillion: toMinor(input),
              outputPerMillion: toMinor(output),
              cacheReadPerMillion: toMinor(cacheRead),
              cacheWritePerMillion: toMinor(cacheWrite),
            }),
          );
          setBusy(false);
        }}
      >
        Save price
      </Button>
      {p.onRemove ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setRefusal(await p.onRemove!());
            setBusy(false);
          }}
        >
          Remove price
        </Button>
      ) : null}
      {refusal ? (
        <span role="alert" className="basis-full text-[13px]" style={{ color: "var(--bad)" }}>
          {refusal}
        </span>
      ) : null}
    </div>
  );
}

function ProviderCard(p: {
  provider: ModelProvider;
  canEdit: boolean;
  data: ModelsPanelProps["data"];
  secrets: readonly CompanySecret[];
  shared: readonly string[];
  canSetValue: boolean;
  prices: ModelPrice[];
  /** Null once done; else why not, shown on the card. */
  onUpdate(input: UpdateModelProviderInput): Promise<string | null>;
  onRemove(): Promise<string | null>;
  /** Check its key; what it found lands on the provider, and the card says it. */
  onCheck(): Promise<string | null>;
  onSetValue(name: string, value: string): Promise<string | null>;
  onSavePrice(input: ModelPriceInput): Promise<string | null>;
  onDeletePrice(priceId: string): Promise<string | null>;
  /** What was priced, or why nothing was: said beside the button. */
  onFillList(): Promise<ListPricesResult | string>;
}) {
  const [pricing, setPricing] = useState<string | null>(null);
  const [filled, setFilled] = useState<{ line: string; refused: boolean } | null>(null);
  const v = p.provider;
  // The company's one currency; before its first price, the list's on a card the list prices (its first price
  // in USD keeps the list applying), else the board's usual GBP.
  const currency = p.prices[0]?.currency ?? (v.kind === "anthropic" || v.kind === "bedrock" ? "USD" : "GBP");
  const own = (model: string) => p.prices.find((x) => x.providerId === v.id && x.model === model);
  const role = credentialRole(v.kind);
  const keyName = v.credentials[role];
  const state = v.credentialStates[role];
  const missing = !!keyName && (!state || state.state === "missing");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const act = async (fn: () => Promise<string | null>) => setError(await fn());
  const suggestions = suggestedModels(v);
  return (
    <div className="card flex flex-col gap-2 px-[18px] py-4" style={v.archivedAt ? { opacity: 0.7 } : {}}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{v.label}</span>
        <span className="mono hint">{v.name}</span>
        <Pill tone="muted">{PROVIDER_KIND_LABELS[v.kind]}</Pill>
        {!v.offered ? <Pill tone="muted">Turned off by your operator</Pill> : null}
        {v.archivedAt ? (
          <Pill tone="muted">Archived</Pill>
        ) : !v.enabled ? (
          <Pill tone="muted">Switched off</Pill>
        ) : null}
        {p.canEdit ? (
          <span className="ml-auto flex items-center gap-2">
            {!v.archivedAt && v.offered ? (
              <Button
                size="sm"
                aria-label={`Check ${v.label}`}
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  await act(p.onCheck);
                  setChecking(false);
                }}
              >
                {checking ? "Checking…" : "Check"}
              </Button>
            ) : null}
            {!v.archivedAt ? (
              <Button size="sm" aria-label={`Change ${v.label}`} onClick={() => setEditing(!editing)}>
                {editing ? "Close" : "Change"}
              </Button>
            ) : null}
            {!v.archivedAt ? (
              <Button
                size="sm"
                aria-label={`${v.enabled ? "Switch off" : "Switch on"} ${v.label}`}
                onClick={() => void act(() => p.onUpdate({ enabled: !v.enabled }))}
              >
                {v.enabled ? "Switch off" : "Switch on"}
              </Button>
            ) : null}
            <Button
              size="sm"
              aria-label={`${v.archivedAt ? "Bring back" : "Archive"} ${v.label}`}
              onClick={() => void act(() => p.onUpdate({ archived: !v.archivedAt }))}
            >
              {v.archivedAt ? "Bring back" : "Archive"}
            </Button>
            <Tip text="Remove">
              <Button size="sm" aria-label={`Remove ${v.label}`} onClick={() => setConfirming(true)}>
                <Trash2 size={14} />
              </Button>
            </Tip>
          </span>
        ) : null}
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px]">{removeLine(v)}</span>
          <Button
            size="sm"
            variant="danger"
            onClick={() => void act(p.onRemove).then(() => setConfirming(false))}
          >
            Remove for good
          </Button>
          <Button size="sm" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
      {error ? (
        <span className="text-[13px]" style={{ color: "var(--bad)" }}>
          {error}
        </span>
      ) : null}
      <span className="hint">
        <span className="mono">{whereLine(v)}</span>
        {v.kind === "openai_compatible" && !keyName ? " · no key" : null}
      </span>
      {keyName ? (
        <span className="hint">
          {role === "bearerToken" ? "Bedrock API key" : "Key"}: <span className="mono">{keyName}</span> ·{" "}
          <span style={missing ? { color: "var(--warn-ink)" } : {}}>{credentialLine(state, p.data)}</span>
          {missing && p.canEdit && !v.archivedAt && !editing ? (
            <>
              {" "}
              <Button size="sm" aria-label={`Set the key of ${v.label}`} onClick={() => setEditing(true)}>
                Set it
              </Button>
            </>
          ) : null}
        </span>
      ) : null}
      <span className="hint" style={v.lastCheck && !v.lastCheck.ok ? { color: "var(--warn-ink)" } : {}}>
        {checkLine(v)}
      </span>
      {editing ? (
        <EditProvider
          provider={v}
          secrets={p.secrets}
          shared={p.shared}
          canSetValue={p.canSetValue}
          onSave={p.onUpdate}
          onSetValue={p.onSetValue}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {v.models.length ? (
        <table className="text-[13px]" style={{ borderCollapse: "collapse" }}>
          <tbody>
            {v.models.map((m) => (
              <Fragment key={m.id}>
                <tr style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="mono py-1 pr-3">{m.id}</td>
                  <td className="py-1 pr-3">{m.label ?? ""}</td>
                  <td className="hint py-1 pr-3">{familyName(m.family)}</td>
                  <td className="hint py-1 pr-3">
                    {engineLine(v.kind, m.family)}
                    {unreached(v, m) ? " · not among the models the key reaches" : ""}
                  </td>
                  <td className="hint py-1 pr-3">
                    {modelPriceLine(v, m, p.prices)}
                    {p.canEdit && !v.archivedAt ? (
                      <>
                        {" "}
                        <Button
                          size="sm"
                          aria-label={`Set the price of ${m.id} on ${v.label}`}
                          onClick={() => setPricing(pricing === m.id ? null : m.id)}
                        >
                          {pricing === m.id ? "Close" : "Set price"}
                        </Button>
                      </>
                    ) : null}
                  </td>
                  <td className="py-1 text-right">
                    {p.canEdit && !v.archivedAt ? (
                      <Tip text="Take it off the list">
                        <Button
                          size="sm"
                          aria-label={`Take ${m.id} off the list of ${v.label}`}
                          onClick={() =>
                            void act(() =>
                              p.onUpdate({ models: given(v.models.filter((x) => x.id !== m.id)) }),
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      </Tip>
                    ) : null}
                  </td>
                </tr>
                {pricing === m.id ? (
                  <tr>
                    <td colSpan={6} className="pb-2">
                      <PriceEditor
                        model={m.id}
                        currency={currency}
                        firstPrice={!p.prices.length}
                        initial={p.prices.find((x) => x.providerId === v.id && x.model === m.id)}
                        onSave={async (price) => {
                          const why = await p.onSavePrice({ ...price, model: m.id, providerId: v.id });
                          if (why === null) setPricing(null);
                          return why;
                        }}
                        {...(own(m.id)
                          ? {
                              onRemove: async () => {
                                const why = await p.onDeletePrice(own(m.id)!.id);
                                if (why === null) setPricing(null);
                                return why;
                              },
                            }
                          : {})}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <span className="hint">No models listed yet.</span>
      )}
      {p.canEdit && !v.archivedAt && (v.kind === "anthropic" || v.kind === "bedrock") ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              const r = await p.onFillList();
              setFilled(
                typeof r === "string"
                  ? { line: r, refused: true }
                  : { line: listFillLine(v.kind, r), refused: false },
              );
            }}
          >
            Fill list prices
          </Button>
          {filled?.refused ? (
            <span role="alert" className="text-[13px]" style={{ color: "var(--bad)" }}>
              {filled.line}
            </span>
          ) : (
            <span className="hint">
              {filled?.line ??
                (v.kind === "bedrock"
                  ? "Anthropic's list prices for the Claude models here, as estimates: AWS sets its own."
                  : "Anthropic's list prices, in USD, for the models here without one.")}
            </span>
          )}
        </div>
      ) : null}
      {p.canEdit && !v.archivedAt ? (
        <AddModelForm
          kind={v.kind}
          of={v.label}
          listed={v.models.map((m) => m.id)}
          suggestions={suggestions}
          onAdd={(id, family, label, contextWindow) =>
            p.onUpdate({
              models: [
                ...given(v.models),
                { id, family, ...(label ? { label } : {}), ...(contextWindow ? { contextWindow } : {}) },
              ],
            })
          }
        />
      ) : null}
    </div>
  );
}

export function ModelsPanel(p: ModelsPanelProps) {
  const [info, setInfo] = useState<ModelProviders | null>(p.initial ?? null);
  // Null until loaded: a key is not pasted before the form knows which names are taken.
  const [secrets, setSecrets] = useState<CompanySecret[] | null>(p.initialSecrets ?? null);
  const [secretsFailed, setSecretsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prices, setPrices] = useState<ModelPrice[]>(p.initialPrices ?? []);
  // Both at once, so no card shows its models before their prices; prices that cannot be read keep the last.
  const reload = async () => {
    const [next, list] = await Promise.all([p.load(), p.loadPrices().catch(() => null)]);
    setInfo(next);
    if (list) setPrices(list);
  };
  // Loaded again when a provider, a secret or a price changes, here or anywhere: a change someone else made
  // is what the next change builds on.
  const changedSeq =
    p.data.events.find(
      (e) =>
        e.type.startsWith("model_provider.") || e.type.startsWith("secret.") || e.type === "company.updated",
    )?.seq ?? 0;
  useEffect(() => {
    // What the top card says is about the last load: one that worked clears it.
    void reload().then(
      () => setError(null),
      (err: unknown) => setError((err as Error).message),
    );
    // A list that cannot be read keeps the one before, never an empty one that would hide what is taken.
    if (p.canEdit)
      void p.loadSecrets().then(
        (list) => {
          setSecrets(list);
          setSecretsFailed(false);
        },
        () => setSecretsFailed(true),
      );
  }, [changedSeq]);
  /** Make a change, then load the providers again: null once done, else why not, for the place it was asked. */
  const change = async (fn: () => Promise<unknown>): Promise<string | null> => {
    let refusal: string | null = null;
    try {
      await fn();
    } catch (err) {
      refusal = (err as Error).message;
    }
    await reload().catch(() => {});
    return refusal;
  };
  const shared = p.features.sharedEnvNames ?? [];
  const card = (v: ModelProvider) => (
    <ProviderCard
      key={v.id}
      provider={v}
      canEdit={p.canEdit}
      data={p.data}
      secrets={secrets ?? []}
      shared={shared}
      canSetValue={p.features.oauth}
      prices={prices}
      onUpdate={(input) => change(() => p.update(v.id, input))}
      onRemove={() => change(() => p.remove(v.id))}
      onCheck={() => change(() => p.check(v.id))}
      onSavePrice={(input) => change(() => p.savePrice(input))}
      onDeletePrice={(id) => change(() => p.deletePrice(id))}
      onFillList={async () => {
        let r: ListPricesResult | null = null;
        const why = await change(async () => (r = await p.fillListPrices(v.id)));
        return why ?? r!;
      }}
      onSetValue={async (name, value) => {
        const why = await change(() => p.replaceSecret(name, value));
        setSecrets(await p.loadSecrets().catch(() => secrets));
        return why;
      }}
    />
  );
  if (!info) return <div className="card px-[18px] py-4 hint">{error ?? "Loading providers…"}</div>;
  const live = info.providers.filter((v) => !v.archivedAt);
  const archived = info.providers.filter((v) => v.archivedAt);
  return (
    <>
      <BoardModelsCard
        lent={info.offered.board}
        load={p.loadBoardModels}
        {...(p.initialBoardModels ? { initial: p.initialBoardModels } : {})}
      />
      <div className="card flex flex-col gap-2 px-[18px] py-4">
        <span className="font-semibold">Your model providers</span>
        <span className="hint">
          Your own model accounts. Keys are kept by name in this company&apos;s secrets and never shown again.
          Check asks a provider which models its key reaches, and costs nothing. Teammates do not think with
          them yet: every teammate and Peter still use this board&apos;s own models.
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {info.offered.kinds.length ? (
            info.offered.kinds.map((k) => (
              <Pill key={k} tone="muted">
                {PROVIDER_KIND_LABELS[k]}
              </Pill>
            ))
          ) : (
            <span className="hint">This board's operator offers no providers.</span>
          )}
        </div>
        {error ? (
          <span className="text-[13px]" style={{ color: "var(--bad)" }}>
            {error}
          </span>
        ) : null}
      </div>
      {live.map(card)}
      {p.canEdit && info.offered.kinds.length ? (
        <AddProviderForm
          offered={info.offered.kinds}
          features={p.features}
          secrets={secrets}
          secretsFailed={secretsFailed && secrets === null}
          providers={info.providers}
          onSubmit={async (f, taken) => {
            let sent = false;
            const why = await change(async () => {
              sent = (await submitForm(f, taken, p)) !== null;
            });
            if (f.how === "paste") setSecrets(await p.loadSecrets().catch(() => secrets));
            return why ?? (sent ? null : "Nothing was sent: something above is still to fill in.");
          }}
        />
      ) : null}
      {archived.length ? (
        <>
          <span className="eyebrow px-1">Archived</span>
          {archived.map(card)}
        </>
      ) : null}
    </>
  );
}
