// What a company's model providers are, without the schemas: the kinds, which engine runs which model, what
// the operator offers (ROSTERDOCK_MODEL_PROVIDERS) and the endpoints each kind takes. No zod, so the web
// imports it as @rosterdock/shared/providers; the schemas are in providers.ts.

import type { Engine } from "./schemas.js";
import { containsRawSecret, looksLikeRawSecret } from "./secrets.js";

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

/** What a person calls each family. */
export const FAMILY_LABELS: Record<ModelFamily, string> = {
  claude: "Claude",
  openai: "OpenAI",
  other: "other",
};

/** The families each kind serves: Anthropic only Claude, OpenAI only its own, Azure no Claude (that is Foundry's). */
const KIND_FAMILIES: Record<ProviderKind, readonly ModelFamily[]> = {
  anthropic: ["claude"],
  openai: ["openai"],
  azure_openai: ["openai", "other"],
  bedrock: MODEL_FAMILIES,
  openai_compatible: MODEL_FAMILIES,
};

/** The families a kind serves, as a provider of it may list them. */
export function familiesFor(kind: ProviderKind): readonly ModelFamily[] {
  return KIND_FAMILIES[kind];
}

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
  // A key in the path would be kept, sent in events and shown: refused like one anywhere else.
  if (containsRawSecret(url.pathname)) return null;
  // Built from its parts, so an empty "?" or "#" left at the end is gone: a path added later stays a path.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Keys whose shape says what they are, besides the ones the raw-secret guard knows: Hugging Face's user and
 * organisation tokens, and Google's API keys (which Gemini's OpenAI-compatible endpoint takes).
 */
const KEY_SHAPES: readonly RegExp[] = [
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bapi_org_[A-Za-z0-9]{30,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
];

/** A run of hex, dashes aside: an Azure key is 32 characters, and a key written as a UUID is one too. */
function hexRun(text: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(text.replace(/-/g, ""));
}

/**
 * Whether a run of letters and digits in a name is random, as a key is: long, in both cases, and with digits
 * or with its case flipping as often as a key's does. A word, or an identifier in one case
 * (DEEPSEEKR1DISTILL, githubPersonalAccessToken), is not.
 */
function randomRun(run: string): boolean {
  if (run.length < 20 || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  if (/[0-9]/.test(run)) return true;
  let flips = 0;
  for (let i = 1; i < run.length; i++) if (run[i]! < "a" !== run[i - 1]! < "a") flips++;
  return flips / (run.length - 1) >= 1 / 3;
}

/**
 * Whether what was given as an env var NAME looks like a key pasted in its place: a shape the raw-secret guard
 * or KEY_SHAPES knows, or a word between its underscores that is a run of hex or a random run.
 */
export function nameLooksLikeKey(name: string): boolean {
  if (looksLikeRawSecret(name) || KEY_SHAPES.some((re) => re.test(name))) return true;
  return name.split("_").some((word) => hexRun(word) || word.split(/[^A-Za-z0-9]+/).some(randomRun));
}

/** A provider's name: short, lowercase, unique in the company, and never a key typed where the name goes. */
export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function providerNameRefusal(name: string): string | null {
  if (!PROVIDER_NAME_RE.test(name)) return "a short name: lowercase letters, digits and dashes, 40 at most";
  if (hexRun(name) || nameLooksLikeKey(name.replace(/-/g, "_"))) return "a short name; this looks like a key";
  return null;
}

/** The most a provider's label holds. */
export const MAX_PROVIDER_LABEL = 80;
/**
 * Whether a label people read has a key in it: a shape the raw-secret guard or KEY_SHAPES knows, anywhere; a
 * word that is base64 of 40 characters or more with a digit in it (an AWS secret access key); or a run of hex
 * between the punctuation labels use (an Azure key, a key written as a UUID). A model's name in a label
 * (DeepSeekR1DistillQwen32B) is a word: a key with no known shape, in a label, is the board-wide guard's to
 * miss, as in any text a person writes.
 */
export function labelLooksLikeKey(label: string): boolean {
  if (containsRawSecret(label) || KEY_SHAPES.some((re) => re.test(label))) return true;
  return label
    .split(/\s+/)
    .filter(Boolean)
    .some(
      (word) =>
        (/^[A-Za-z0-9+/=]{40,}$/.test(word) && /[0-9]/.test(word)) || word.split(/[/().,@:;_]+/).some(hexRun),
    );
}

/** The headers an OpenAI-compatible server may take its key in. */
export const COMPATIBLE_AUTH_HEADERS = ["authorization", "api-key", "x-api-key"] as const;
export type CompatibleAuthHeader = (typeof COMPATIBLE_AUTH_HEADERS)[number];

/** The most models one provider lists. */
export const MAX_PROVIDER_MODELS = 200;
