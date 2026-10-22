// Company model providers: a company's own model account (Anthropic, OpenAI, Azure OpenAI, Amazon Bedrock, or
// a server that speaks OpenAI's API), with its credentials by env var NAME and the models it serves. A
// teammate picks a provider and one of its models, and the engine follows from the model (engineFor). The
// operator says which kinds a company may add, and whether the board lends its own models
// (ROSTERDOCK_MODEL_PROVIDERS). Pure: the schemas and the rules, shared by the board and the web.

import { z } from "zod";
import {
  azureEndpoint,
  BEDROCK_REGION_RE,
  COMPATIBLE_AUTH_HEADERS,
  compatibleEndpoint,
  familiesFor,
  FAMILY_LABELS,
  MAX_PROVIDER_MODELS,
  MODEL_FAMILIES,
  labelLooksLikeKey,
  MAX_PROVIDER_LABEL,
  nameLooksLikeKey,
  providerNameRefusal,
  PROVIDER_KIND_LABELS,
} from "./provider-kinds.js";
import { modelId, SecretNameSchema } from "./schemas.js";

export * from "./provider-kinds.js";

/** A provider's name: short, lowercase, unique in the company. */
const providerName = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const why = providerNameRefusal(v);
    if (why) ctx.addIssue({ code: "custom", message: why });
  });
const label = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROVIDER_LABEL)
  .refine((v) => !labelLooksLikeKey(v), "what people read, such as Acme Azure (prod); this looks like a key");

/** A credential's env var NAME, never the value: a pasted key is refused without being said back. */
const credentialName = SecretNameSchema.refine(
  (v) => !nameLooksLikeKey(v),
  "an env var NAME, such as MODELS_ACME_KEY; this looks like the key itself",
);

/** A model id exactly as the provider takes it: an OpenAI id, an Azure deployment name, a Bedrock profile id or ARN. */
const providerModelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !/\s/.test(v), "a model id has no spaces");

/** One model a provider serves. Where it came from (`listed` by Check, or `typed`) is the board's to say. */
export const ProviderModelSchema = z.object({
  id: providerModelId,
  label: label.optional(),
  family: z.enum(MODEL_FAMILIES),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
});
export type ProviderModelInput = z.infer<typeof ProviderModelSchema>;

/** A model as a provider row keeps it. */
export interface ProviderModel extends ProviderModelInput {
  source: "listed" | "typed";
}

const models = z.array(ProviderModelSchema).max(MAX_PROVIDER_MODELS).default([]);
/** Anthropic's own ids, written the way people say them (claude-opus-5.5), are put the way Claude Code takes them. */
const anthropicModels = z
  .array(ProviderModelSchema.extend({ id: modelId.refine((v) => !/\s/.test(v), "a model id has no spaces") }))
  .max(MAX_PROVIDER_MODELS)
  .default([]);

const common = {
  name: providerName,
  label,
  models,
  enabled: z.boolean().default(true),
};
const apiKeyOnly = z.strictObject({ apiKey: credentialName });

/**
 * A provider, by kind. Every credential is an env var NAME, never a value: the company's own secret (set
 * once from Settings, write-only) or a name the operator shares. Fields another kind takes are refused.
 */
export const ModelProviderSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("anthropic"),
      ...common,
      models: anthropicModels,
      credentials: apiKeyOnly,
    }),
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
      credentials: z.strictObject({ bearerToken: credentialName }),
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
      credentials: z.strictObject({ apiKey: credentialName.optional() }).default({}),
    }),
  ])
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.models.forEach((m, i) => {
      if (seen.has(m.id))
        ctx.addIssue({ code: "custom", path: ["models", i, "id"], message: "this model is listed twice" });
      seen.add(m.id);
      if (!familiesFor(p.kind).includes(m.family))
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "family"],
          message: `${PROVIDER_KIND_LABELS[p.kind]} serves ${familiesFor(p.kind)
            .map((f) => FAMILY_LABELS[f])
            .join(" and ")} models here, not ${FAMILY_LABELS[m.family]} ones`,
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
  /** The whole set of credential names, replacing the row's: apiKey, or bearerToken for Bedrock. */
  credentials: z.partialRecord(z.enum(["apiKey", "bearerToken"]), credentialName).optional(),
  /** The whole list, replacing the row's. */
  models: z.array(ProviderModelSchema).max(MAX_PROVIDER_MODELS).optional(),
  enabled: z.boolean().optional(),
  /** Archive (true) or bring back (false). An archived provider stays, with its prices and history, unused. */
  archived: z.boolean().optional(),
});
export type UpdateModelProviderInput = z.input<typeof UpdateModelProviderSchema>;
