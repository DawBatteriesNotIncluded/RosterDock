// Settings > Models: the company's own model accounts. What this board offers, each provider with where it
// is reached, where its key comes from (never the key) and the models it serves, and a form per kind to add
// one. A key pasted here goes write-only into the company's secrets (PUT /secrets/:name) before the provider
// is saved with that name; it is the only value this page ever takes, and it is never shown again.
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ModelFamily,
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
  MAX_PROVIDER_LABEL,
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
  ModelProvider,
  ModelProviders,
} from "../api/types.ts";
import { Button, Field, Pill, Tip } from "../components/ui.tsx";
import { actorInfo, relativeTime } from "../lib/format.ts";

export interface ModelsPanelProps {
  data: Pick<CompanyData, "teammates" | "members" | "events">;
  canEdit: boolean;
  /** Without a secret store (features.oauth) a key cannot be pasted here; saved and shared names still work. */
  features: Features;
  load(): Promise<ModelProviders>;
  loadSecrets(): Promise<CompanySecret[]>;
  /** Sets a pasted key under a new name only: never over a value already set (the board refuses with 409). */
  setSecret(name: string, value: string): Promise<unknown>;
  /** Would the board add this provider? Asked before a key is set, so a refusal leaves no key behind. */
  checkNew(input: ModelProviderInput): Promise<unknown>;
  create(input: ModelProviderInput): Promise<ModelProvider>;
  update(id: string, input: UpdateModelProviderInput): Promise<ModelProvider>;
  remove(id: string): Promise<void>;
  initial?: ModelProviders;
  initialSecrets?: CompanySecret[];
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
    ? "This board's own models: available"
    : "This board's own models: not lent. Once teammates think with your providers, each will need one.";
}

/** The last check, in a sentence; nothing checked yet says so. */
export function checkLine(p: Pick<ModelProvider, "lastCheck">, now: number = Date.now()): string {
  const c = p.lastCheck;
  if (!c) return "Not checked yet";
  return c.ok
    ? `Checked ${relativeTime(c.at, now)}: key works, ${c.listed} model${c.listed === 1 ? "" : "s"}`
    : `Checked ${relativeTime(c.at, now)}: ${c.detail ?? "no answer"}`;
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

/** The provider's name: as typed, or made from the label. */
export function formName(f: Pick<ProviderForm, "name" | "label">): string {
  return f.name === null ? providerSlug(f.label) : f.name.trim();
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
  /** Every provider, archived ones included. */
  providers: ModelProvider[];
  /** True once saved; false leaves the form as it was, with the reason shown above. */
  onSubmit(f: ProviderForm, taken: Parameters<typeof formProblem>[1]): Promise<boolean>;
}) {
  const canPaste = p.features.oauth;
  const shared = p.features.sharedEnvNames ?? [];
  const blank: ProviderForm = {
    kind: PROVIDER_KINDS.find((k) => p.offered.includes(k)) ?? "anthropic",
    label: "",
    name: null,
    endpoint: "",
    region: "",
    authHeader: "authorization",
    how: canPaste ? "paste" : "saved",
    value: "",
    picked: "",
  };
  const [f, setForm] = useState<ProviderForm>(blank);
  const set = (change: Partial<ProviderForm>) => setForm((was) => ({ ...was, ...change }));
  const [busy, setBusy] = useState(false);
  const taken = { providers: p.providers, secrets: p.secrets, shared };
  const problem = formProblem(f, taken);
  const secretName = formSecretName(f);
  const turnedOff = PROVIDER_KINDS.filter((k) => !p.offered.includes(k));
  const choices: { value: CredentialChoice; label: string }[] = [
    ...(canPaste ? [{ value: "paste" as const, label: "Paste a key" }] : []),
    { value: "saved", label: "Use a saved secret" },
    ...(shared.length ? [{ value: "shared" as const, label: "Use a name your operator shares" }] : []),
    ...(f.kind === "openai_compatible" ? [{ value: "none" as const, label: "No key" }] : []),
  ];
  const save = async () => {
    setBusy(true);
    const saved = await p.onSubmit(f, taken);
    setBusy(false);
    if (saved) setForm({ ...blank, kind: f.kind });
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <span className="font-semibold">Add a provider</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kind">
        {PROVIDER_KINDS.filter((k) => p.offered.includes(k)).map((k) => (
          <Button
            key={k}
            size="sm"
            role="radio"
            aria-checked={f.kind === k}
            {...(f.kind === k ? { variant: "primary" as const } : {})}
            onClick={() =>
              set({
                kind: k,
                picked: "",
                ...(f.how === "none" && k !== "openai_compatible" ? { how: blank.how } : {}),
              })
            }
          >
            {PROVIDER_KIND_LABELS[k]}
          </Button>
        ))}
      </div>
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
            value={formName(f)}
            // Once typed, the name is the person's, cleared or not.
            onChange={(e) => set({ name: e.target.value.toLowerCase() })}
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
        {f.kind === "openai_compatible" && f.how !== "none" ? (
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
      <div className="flex flex-wrap items-end gap-3">
        <Field label={f.kind === "bedrock" ? "Bedrock API key" : "Key"}>
          <select
            aria-label="How the key is given"
            value={f.how}
            onChange={(e) => set({ how: e.target.value as CredentialChoice, picked: "", value: "" })}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        {f.how === "paste" ? (
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
        ) : f.how === "saved" ? (
          <Field label="Secret" hint="Set under Settings > Connections > Secrets">
            <select aria-label="Secret" value={f.picked} onChange={(e) => set({ picked: e.target.value })}>
              <option value="">Pick one</option>
              {(p.secrets ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        ) : f.how === "shared" ? (
          <Field label="Name">
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
      {problem && problem !== "missing" ? <span className="hint">{problem}</span> : null}
    </div>
  );
}

function AddModelForm(p: {
  kind: ProviderKind;
  onAdd(id: string, family: ModelFamily, label: string): Promise<boolean>;
}) {
  const families = familiesFor(p.kind);
  const [id, setId] = useState("");
  // A compatible server's models are seldom Claude's or OpenAI's own.
  const [family, setFamily] = useState<ModelFamily>(p.kind === "openai_compatible" ? "other" : families[0]!);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const added = await p.onAdd(id.trim(), family, label.trim());
    setBusy(false);
    if (!added) return;
    setId("");
    setLabel("");
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Add a model id" hint={p.kind === "azure_openai" ? "Your deployment's name" : undefined}>
        <input
          aria-label="Model id"
          className="mono"
          value={id}
          onChange={(e) => setId(e.target.value)}
          style={{ width: 240 }}
        />
      </Field>
      {families.length > 1 ? (
        <Field label="Whose model">
          <select
            aria-label="Whose model"
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
          aria-label="Model label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: 160 }}
        />
      </Field>
      <Button size="sm" disabled={!id.trim() || busy} onClick={() => void add()}>
        Add
      </Button>
    </div>
  );
}

function ProviderCard(p: {
  provider: ModelProvider;
  canEdit: boolean;
  data: ModelsPanelProps["data"];
  onUpdate(input: UpdateModelProviderInput): Promise<boolean>;
  onRemove(): Promise<boolean>;
}) {
  const v = p.provider;
  const role = credentialRole(v.kind);
  const keyName = v.credentials[role];
  const state = v.credentialStates[role];
  const missing = !!keyName && (!state || state.state === "missing");
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
            {!v.archivedAt ? (
              <Button size="sm" onClick={() => void p.onUpdate({ enabled: !v.enabled })}>
                {v.enabled ? "Switch off" : "Switch on"}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void p.onUpdate({ archived: !v.archivedAt })}>
              {v.archivedAt ? "Bring back" : "Archive"}
            </Button>
            <Tip text="Remove">
              <Button size="sm" aria-label={`Remove ${v.label}`} onClick={() => void p.onRemove()}>
                <Trash2 size={14} />
              </Button>
            </Tip>
          </span>
        ) : null}
      </div>
      <span className="hint">
        <span className="mono">{whereLine(v)}</span>
        {v.kind === "openai_compatible" && !keyName ? " · no key" : null}
      </span>
      {keyName ? (
        <span className="hint">
          {role === "bearerToken" ? "Bedrock API key" : "Key"}: <span className="mono">{keyName}</span> ·{" "}
          <span style={missing ? { color: "var(--warn-ink)" } : {}}>{credentialLine(state, p.data)}</span>
        </span>
      ) : null}
      <span className="hint">{checkLine(v)}</span>
      {v.models.length ? (
        <table className="text-[13px]" style={{ borderCollapse: "collapse" }}>
          <tbody>
            {v.models.map((m) => (
              <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="mono py-1 pr-3">{m.id}</td>
                <td className="py-1 pr-3">{m.label ?? ""}</td>
                <td className="hint py-1 pr-3">{familyName(m.family)}</td>
                <td className="hint py-1 pr-3">{engineLine(v.kind, m.family)}</td>
                <td className="py-1 text-right">
                  {p.canEdit && !v.archivedAt ? (
                    <Tip text="Take it off the list">
                      <Button
                        size="sm"
                        aria-label={`Take ${m.id} off the list`}
                        onClick={() =>
                          void p.onUpdate({ models: given(v.models.filter((x) => x.id !== m.id)) })
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </Tip>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className="hint">No models listed yet.</span>
      )}
      {p.canEdit && !v.archivedAt ? (
        <AddModelForm
          kind={v.kind}
          onAdd={(id, family, label) =>
            p.onUpdate({ models: [...given(v.models), { id, family, ...(label ? { label } : {}) }] })
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
  const [error, setError] = useState<string | null>(null);
  const reload = async () => setInfo(await p.load());
  // Loaded again when a provider, a secret or a price changes, here or anywhere: a change someone else made
  // is what the next change builds on.
  const changedSeq =
    p.data.events.find(
      (e) =>
        e.type.startsWith("model_provider.") || e.type.startsWith("secret.") || e.type === "company.updated",
    )?.seq ?? 0;
  useEffect(() => {
    void reload().catch((err: unknown) => setError((err as Error).message));
    // A list that cannot be read keeps the one before, never an empty one that would hide what is taken.
    if (p.canEdit) void p.loadSecrets().then(setSecrets, () => {});
  }, [changedSeq]);
  /** Make a change, then load the providers again; a refusal is shown above, and says false. */
  const change = async (fn: () => Promise<unknown>): Promise<boolean> => {
    let ok = false;
    try {
      await fn();
      setError(null);
      ok = true;
    } catch (err) {
      setError((err as Error).message);
    }
    await reload().catch(() => {});
    return ok;
  };
  if (!info) return <div className="card px-[18px] py-4 hint">{error ?? "Loading providers…"}</div>;
  const live = info.providers.filter((v) => !v.archivedAt);
  const archived = info.providers.filter((v) => v.archivedAt);
  return (
    <>
      <div className="card flex flex-col gap-2 px-[18px] py-4">
        <span className="font-semibold">Your model providers</span>
        <span className="hint">
          Your own model accounts. Keys are kept by name in this company&apos;s secrets and never shown again.
          Teammates do not think with them yet: every teammate and Peter still use this board&apos;s own
          models.
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
        <span className="text-[13px]">{boardLine(info.offered.board)}</span>
        {error ? (
          <span className="text-[13px]" style={{ color: "var(--bad)" }}>
            {error}
          </span>
        ) : null}
      </div>
      {live.map((v) => (
        <ProviderCard
          key={v.id}
          provider={v}
          canEdit={p.canEdit}
          data={p.data}
          onUpdate={(input) => change(() => p.update(v.id, input))}
          onRemove={() => change(() => p.remove(v.id))}
        />
      ))}
      {p.canEdit && info.offered.kinds.length ? (
        <AddProviderForm
          offered={info.offered.kinds}
          features={p.features}
          secrets={secrets}
          providers={info.providers}
          onSubmit={async (f, taken) => {
            let sent = false;
            const ok = await change(async () => {
              sent = (await submitForm(f, taken, p)) !== null;
            });
            if (f.how === "paste") setSecrets(await p.loadSecrets().catch(() => secrets));
            return ok && sent;
          }}
        />
      ) : null}
      {archived.length ? (
        <>
          <span className="eyebrow px-1">Archived</span>
          {archived.map((v) => (
            <ProviderCard
              key={v.id}
              provider={v}
              canEdit={p.canEdit}
              data={p.data}
              onUpdate={(input) => change(() => p.update(v.id, input))}
              onRemove={() => change(() => p.remove(v.id))}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
