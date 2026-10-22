// Company model providers: a company's own model account (Anthropic, OpenAI, Azure OpenAI, Amazon Bedrock, or
// a server that speaks OpenAI's API), with its credentials by env var NAME and the models it serves. A
// teammate picks a provider and one of its models, and the engine follows from the model (engineFor). The
// operator says which kinds a company may add, and whether the board lends its own models
// (ROSTERDOCK_MODEL_PROVIDERS). Pure: the schemas and the rules, shared by the board and the web.

import { z } from "zod";
import { modelId, SecretNameSchema, type Engine } from "./schemas.js";

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "azure_openai",
  "bedrock",
  "openai_compatible",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** What a person calls each kind. */
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
  bedrock: "Amazon Bedrock",
  openai_compatible: "OpenAI-compatible",
};

/** Whose models a model is: an engine runs Claude's or OpenAI's; another family (Llama, Mistral) none here. */
export const MODEL_FAMILIES = ["claude", "openai", "other"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

const FAMILY_LABELS: Record<ModelFamily, string> = { claude: "Claude", openai: "OpenAI", other: "other" };

/** The families each kind serves: Anthropic only Claude, OpenAI only its own, Azure no Claude (that is Foundry's). */
const KIND_FAMILIES: Record<ProviderKind, readonly ModelFamily[]> = {
  anthropic: ["claude"],
  openai: ["openai"],
  azure_openai: ["openai", "other"],
  bedrock: MODEL_FAMILIES,
  openai_compatible: MODEL_FAMILIES,
};

/**
 * The engine a model runs on, or null when none here runs it. Claude Code speaks Anthropic's API (and
 * Bedrock's for Claude); Codex speaks OpenAI's Responses API, which OpenAI, Azure, compatible servers and
 * Bedrock's OpenAI models serve.
 */
export function engineFor(kind: ProviderKind, family: ModelFamily): Engine | null {
  if (!KIND_FAMILIES[kind].includes(family)) return null;
  switch (kind) {
    case "anthropic":
      return "claude_code";
    case "bedrock":
      return family === "claude" ? "claude_code" : family === "openai" ? "codex" : null;
    case "openai":
    case "azure_openai":
    case "openai_compatible":
      return "codex";
  }
}

/** The token in ROSTERDOCK_MODEL_PROVIDERS that lends the board's own models to every company. */
export const BOARD_MODELS = "board";

/** What the operator lets companies use: the kinds a company may add, and whether the board lends its own models. */
export interface ModelProvidersPolicy {
  kinds: ProviderKind[];
  board: boolean;
}

/**
 * ROSTERDOCK_MODEL_PROVIDERS: the kinds a company may add and `board`, comma-separated. Unset or blank: every
 * kind and `board`, so a board behaves as it did before companies could bring their own. An entry that is not
 * one of them stops the board from starting, so a typo never quietly turns a kind off.
 */
export function parseModelProviders(raw: string | undefined): ModelProvidersPolicy {
  const tokens = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return { kinds: [...PROVIDER_KINDS], board: true };
  const kinds: ProviderKind[] = [];
  let board = false;
  for (const token of tokens) {
    if (token === BOARD_MODELS) board = true;
    else if ((PROVIDER_KINDS as readonly string[]).includes(token)) {
      if (!kinds.includes(token as ProviderKind)) kinds.push(token as ProviderKind);
    } else
      throw new Error(
        `ROSTERDOCK_MODEL_PROVIDERS: ${token} is not one of ${[...PROVIDER_KINDS, BOARD_MODELS].join(", ")}`,
      );
  }
  return { kinds, board };
}

/** A provider's name: short, lowercase, unique in the company. */
const providerName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");
const label = z.string().trim().min(1).max(80);

/** An AWS region, as Bedrock is reached in it: us-east-1, eu-central-2, us-gov-west-1. */
export const BEDROCK_REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d+$/;

/** The hosts an Azure OpenAI resource is reached at: <resource>.openai.azure.com, <resource>.services.ai.azure.com. */
const AZURE_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}\.(openai\.azure\.com|services\.ai\.azure\.com)$/;

/**
 * An Azure OpenAI resource's endpoint as the board keeps it, `https://<resource>.openai.azure.com`, or null
 * when this is not one. The board adds `/openai/v1` itself, so a pasted path ending there is dropped.
 */
export function azureEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!AZURE_HOST_RE.test(host)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/openai" && path !== "/openai/v1") return null;
  return `https://${host}`;
}

/**
 * An OpenAI-compatible server's base URL as the board keeps it (`https://llm.example.com/v1`), or null when it
 * cannot be one: http or https, no credentials in it, no query, no fragment, no trailing slash.
 */
export function compatibleEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  return url.toString().replace(/\/+$/, "");
}

/** One model a provider serves. Where it came from (`listed` by Check, or `typed`) is the board's to say. */
export const ProviderModelSchema = z.object({
  /** The id the provider takes: an Anthropic or OpenAI model id, an Azure deployment name, a Bedrock profile id or ARN. */
  id: modelId.refine((v) => !/\s/.test(v), "a model id has no spaces"),
  label: label.optional(),
  family: z.enum(MODEL_FAMILIES),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
});
export type ProviderModelInput = z.infer<typeof ProviderModelSchema>;

/** A model as a provider row keeps it. */
export interface ProviderModel extends ProviderModelInput {
  source: "listed" | "typed";
}

export const MAX_PROVIDER_MODELS = 200;
const models = z.array(ProviderModelSchema).max(MAX_PROVIDER_MODELS).default([]);

/** The headers an OpenAI-compatible server may take its key in. */
export const COMPATIBLE_AUTH_HEADERS = ["authorization", "api-key", "x-api-key"] as const;
export type CompatibleAuthHeader = (typeof COMPATIBLE_AUTH_HEADERS)[number];

const common = {
  name: providerName,
  label,
  models,
  enabled: z.boolean().default(true),
};
const apiKeyOnly = z.strictObject({ apiKey: SecretNameSchema });

/**
 * A provider, by kind. Every credential is an env var NAME, never a value: the company's own secret (set
 * once from Settings, write-only) or a name the operator shares. Fields another kind takes are refused.
 */
export const ModelProviderSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("anthropic"), ...common, credentials: apiKeyOnly }),
    z.strictObject({ kind: z.literal("openai"), ...common, credentials: apiKeyOnly }),
    z.strictObject({
      kind: z.literal("azure_openai"),
      ...common,
      endpoint: z
        .string()
        .max(300)
        .refine(
          (v) => azureEndpoint(v) !== null,
          "the resource's address, such as https://acme.openai.azure.com or https://acme.services.ai.azure.com",
        )
        .transform((v) => azureEndpoint(v)!),
      credentials: apiKeyOnly,
    }),
    z.strictObject({
      kind: z.literal("bedrock"),
      ...common,
      region: z.string().trim().regex(BEDROCK_REGION_RE, "an AWS region, such as us-east-1"),
      credentials: z.strictObject({ bearerToken: SecretNameSchema }),
    }),
    z.strictObject({
      kind: z.literal("openai_compatible"),
      ...common,
      endpoint: z
        .string()
        .max(500)
        .refine(
          (v) => compatibleEndpoint(v) !== null,
          "the server's base URL, http or https, with no credentials or query in it",
        )
        .transform((v) => compatibleEndpoint(v)!),
      /** The header the key goes in; without a key (a keyless Ollama or vLLM) none. Default: authorization. */
      authHeader: z.enum(COMPATIBLE_AUTH_HEADERS).nullable().optional(),
      credentials: z.strictObject({ apiKey: SecretNameSchema.optional() }).default({}),
    }),
  ])
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.models.forEach((m, i) => {
      if (seen.has(m.id))
        ctx.addIssue({ code: "custom", path: ["models", i, "id"], message: `${m.id} is listed twice` });
      seen.add(m.id);
      if (!KIND_FAMILIES[p.kind].includes(m.family))
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "family"],
          message: `${PROVIDER_KIND_LABELS[p.kind]} serves ${KIND_FAMILIES[p.kind].map((f) => FAMILY_LABELS[f]).join(" and ")} models here, not ${FAMILY_LABELS[m.family]} ones`,
        });
      // Bedrock serves OpenAI's models at two endpoints: bare openai.* ids are Mantle's, which the board
      // does not reach yet; Runtime takes cross-Region inference profiles (global.openai.…, us.openai.…).
      if (p.kind === "bedrock" && m.family === "openai" && m.id.startsWith("openai."))
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "id"],
          message:
            "a bare openai.* id is Bedrock's Mantle endpoint, which this board does not reach yet; use a cross-Region inference profile id (global.openai.… or us.openai.…)",
        });
    });
    if (p.kind === "openai_compatible" && p.authHeader && !p.credentials.apiKey)
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "a header goes with a key" });
  });
export type ModelProviderInput = z.input<typeof ModelProviderSchema>;
export type ModelProvider = z.output<typeof ModelProviderSchema>;

/**
 * A change to a provider. Its kind and name stay; the board applies the change to the row and checks the
 * whole against ModelProviderSchema, so a field another kind takes is refused there.
 */
export const UpdateModelProviderSchema = z.strictObject({
  label: label.optional(),
  endpoint: z.string().max(500).optional(),
  region: z.string().trim().optional(),
  authHeader: z.enum(COMPATIBLE_AUTH_HEADERS).nullable().optional(),
  /** The whole set of credential names, replacing the row's. */
  credentials: z.record(z.string(), SecretNameSchema).optional(),
  /** The whole list, replacing the row's. */
  models: z.array(ProviderModelSchema).max(MAX_PROVIDER_MODELS).optional(),
  enabled: z.boolean().optional(),
  /** Archive (true) or bring back (false). An archived provider stays, with its prices and history, unused. */
  archived: z.boolean().optional(),
});
export type UpdateModelProviderInput = z.input<typeof UpdateModelProviderSchema>;
