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
  COMPATIBLE_AUTH_HEADERS,
  engineFor,
  FAMILY_LABELS,
  familiesFor,
  PROVIDER_KIND_LABELS,
  PROVIDER_KINDS,
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
  data: Pick<CompanyData, "teammates" | "members">;
  canEdit: boolean;
  /** Without a secret store (features.oauth) a key cannot be pasted here; saved and shared names still work. */
  features: Features;
  load(): Promise<ModelProviders>;
  loadSecrets(): Promise<CompanySecret[]>;
  setSecret(name: string, value: string): Promise<unknown>;
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

/** Whether teammates may keep the board's own models, in a sentence. */
export function boardLine(board: boolean): string {
  return board
    ? "This board's own models: available"
    : "Not lent: every teammate needs one of your providers";
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

export interface ProviderForm {
  kind: ProviderKind;
  label: string;
  name: string;
  endpoint: string;
  region: string;
  authHeader: CompatibleAuthHeader;
  /** The name the credential goes under; null for a compatible server without a key. */
  credentialName: string | null;
}

/** The body the form saves: names only. */
export function providerInput(f: ProviderForm): ModelProviderInput {
  const base = { name: f.name.trim(), label: f.label.trim() };
  const key = f.credentialName?.trim() ?? "";
  switch (f.kind) {
    case "anthropic":
    case "openai":
      return { kind: f.kind, ...base, credentials: { apiKey: key } };
    case "azure_openai":
      return { kind: f.kind, ...base, endpoint: f.endpoint.trim(), credentials: { apiKey: key } };
    case "bedrock":
      return { kind: f.kind, ...base, region: f.region.trim(), credentials: { bearerToken: key } };
    case "openai_compatible":
      return key
        ? {
            kind: f.kind,
            ...base,
            endpoint: f.endpoint.trim(),
            authHeader: f.authHeader,
            credentials: { apiKey: key },
          }
        : { kind: f.kind, ...base, endpoint: f.endpoint.trim(), credentials: {} };
  }
}

/**
 * Save a provider: a pasted key first goes write-only into the company's secrets under its name, then the
 * provider is saved with that name. A key that could not be set saves nothing.
 */
export async function saveProvider(
  input: ModelProviderInput,
  paste: { name: string; value: string } | null,
  deps: Pick<ModelsPanelProps, "setSecret" | "create">,
): Promise<ModelProvider> {
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
  secrets: CompanySecret[];
  /** True once saved; false leaves the form as it was, with the reason shown above. */
  onSave(input: ModelProviderInput, paste: { name: string; value: string } | null): Promise<boolean>;
}) {
  const first = PROVIDER_KINDS.find((k) => p.offered.includes(k)) ?? "anthropic";
  const [kind, setKind] = useState<ProviderKind>(first);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [authHeader, setAuthHeader] = useState<CompatibleAuthHeader>("authorization");
  const canPaste = p.features.oauth;
  const shared = p.features.sharedEnvNames ?? [];
  const [how, setHow] = useState<CredentialChoice>(canPaste ? "paste" : "saved");
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const slug = named ? name : providerSlug(label);
  const secretName = suggestedSecretName(slug);
  const credentialName = how === "paste" ? secretName : how === "none" ? null : picked;
  const ready =
    !!label.trim() &&
    !!slug &&
    (how !== "paste" || !!value.trim()) &&
    (how === "paste" || how === "none" || !!picked) &&
    (kind !== "bedrock" || !!region.trim()) &&
    ((kind !== "azure_openai" && kind !== "openai_compatible") || !!endpoint.trim());
  const choices: { value: CredentialChoice; label: string }[] = [
    ...(canPaste ? [{ value: "paste" as const, label: "Paste a key" }] : []),
    { value: "saved", label: "Use a saved secret" },
    ...(shared.length ? [{ value: "shared" as const, label: "Use a name your operator shares" }] : []),
    ...(kind === "openai_compatible" ? [{ value: "none" as const, label: "No key" }] : []),
  ];
  const save = async () => {
    setBusy(true);
    const saved = await p.onSave(
      providerInput({ kind, label, name: slug, endpoint, region, authHeader, credentialName }),
      how === "paste" ? { name: secretName, value } : null,
    );
    setBusy(false);
    if (!saved) return;
    setLabel("");
    setName("");
    setNamed(false);
    setEndpoint("");
    setRegion("");
    setValue("");
    setPicked("");
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <span className="font-semibold">Add a provider</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kind">
        {PROVIDER_KINDS.map((k) =>
          p.offered.includes(k) ? (
            <Button
              key={k}
              size="sm"
              role="radio"
              aria-checked={kind === k}
              {...(kind === k ? { variant: "primary" as const } : {})}
              onClick={() => {
                setKind(k);
                if (how === "none" && k !== "openai_compatible") setHow(canPaste ? "paste" : "saved");
              }}
            >
              {PROVIDER_KIND_LABELS[k]}
            </Button>
          ) : (
            <Tip key={k} text="Turned off by your operator">
              <span>
                <Button size="sm" role="radio" aria-checked={false} disabled>
                  {PROVIDER_KIND_LABELS[k]}
                </Button>
              </span>
            </Tip>
          ),
        )}
      </div>
      <span className="hint">{KIND_HINTS[kind]}</span>
      <div className="flex flex-wrap gap-3">
        <Field label="Label" hint="What people read, such as Acme Azure (prod)">
          <input
            aria-label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ width: 220 }}
          />
        </Field>
        <Field label="Name" hint="Short, lowercase; teammates' settings use it">
          <input
            aria-label="Name"
            className="mono"
            value={slug}
            onChange={(e) => {
              setNamed(true);
              setName(e.target.value);
            }}
            style={{ width: 180 }}
          />
        </Field>
        {kind === "azure_openai" || kind === "openai_compatible" ? (
          <Field label={kind === "azure_openai" ? "Resource address" : "Base URL"}>
            <input
              aria-label={kind === "azure_openai" ? "Resource address" : "Base URL"}
              className="mono"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={
                kind === "azure_openai" ? "https://acme.openai.azure.com" : "https://llm.example.com/v1"
              }
              style={{ width: 280 }}
            />
          </Field>
        ) : null}
        {kind === "bedrock" ? (
          <Field label="Region">
            <input
              aria-label="Region"
              className="mono"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
              style={{ width: 140 }}
            />
          </Field>
        ) : null}
        {kind === "openai_compatible" && how !== "none" ? (
          <Field label="Key goes in">
            <select
              aria-label="Key goes in"
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value as CompatibleAuthHeader)}
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
        <Field label={kind === "bedrock" ? "Bedrock API key" : "Key"}>
          <select
            aria-label="How the key is given"
            value={how}
            onChange={(e) => setHow(e.target.value as CredentialChoice)}
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
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste the key"
              style={{ width: 260 }}
            />
          </Field>
        ) : how === "saved" ? (
          <Field label="Secret" hint="Set under Settings > Connections > Secrets">
            <select aria-label="Secret" value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Pick one</option>
              {p.secrets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        ) : how === "shared" ? (
          <Field label="Name">
            <select aria-label="Shared name" value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Pick one</option>
              {shared.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Button variant="primary" disabled={!ready || busy} onClick={() => void save()}>
          Add provider
        </Button>
      </div>
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
                  {p.canEdit ? (
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
  const [secrets, setSecrets] = useState<CompanySecret[]>(p.initialSecrets ?? []);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => setInfo(await p.load());
  useEffect(() => {
    if (!p.initial) void reload().catch((err: unknown) => setError((err as Error).message));
    if (p.canEdit && !p.initialSecrets) void p.loadSecrets().then(setSecrets, () => setSecrets([]));
    // Loaded once; every change below loads again.
  }, []);
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
              <Pill key={k} tone="info">
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
          onSave={async (input, paste) => {
            const saved = await change(() => saveProvider(input, paste, p));
            if (paste) setSecrets(await p.loadSecrets().catch(() => secrets));
            return saved;
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
