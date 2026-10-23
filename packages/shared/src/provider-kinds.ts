// What a company's model providers are, without the schemas: the kinds, which engine runs which model, what
// the operator offers (ROSTERDOCK_MODEL_PROVIDERS) and the endpoints each kind takes. No zod, so the web
// imports it as @rosterdock/shared/providers; the schemas are in providers.ts.

import type { Engine } from "./schemas.js";

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

/**
 * A model a provider's Check found the key reaches, kept on the row for a person to add from: Check itself adds
 * none. The family is the board's guess from the kind and the id, for the person to confirm.
 */
export interface ListedModel {
  id: string;
  family: ModelFamily;
  /** What the provider calls it (Claude Opus 5.5, US Anthropic Claude Opus 4.5), when it says. */
  label?: string;
  contextWindow?: number;
}

/**
 * Whose model a listed id most likely is: an Anthropic provider's are Claude's and OpenAI's its own; Bedrock
 * says whose in the id (us.anthropic.…, global.openai.…); a compatible server's or an Azure resource's id by
 * its name (claude-…, gpt-…), else another family. A guess a person confirms when they add the model.
 */
export function listedFamily(kind: ProviderKind, id: string): ModelFamily {
  if (kind === "anthropic") return "claude";
  if (kind === "openai") return "openai";
  if (kind === "bedrock") {
    if (/^(?:[a-z-]{2,8}\.)?anthropic\./.test(id)) return "claude";
    // A bare openai.* id is Mantle's, which the board does not reach: not one an engine here runs.
    return BEDROCK_OPENAI_ID_RE.test(id) && id.includes("openai") ? "openai" : "other";
  }
  const guess: ModelFamily = /^claude-/i.test(id)
    ? "claude"
    : /^(?:gpt-|o\d|codex-)/i.test(id)
      ? "openai"
      : "other";
  return KIND_FAMILIES[kind].includes(guess) ? guess : "other";
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
  if (KEY_SHAPES.some((re) => re.test(url.pathname))) return null;
  // Built from its parts, so an empty "?" or "#" left at the end is gone: a path added later stays a path.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// --- Keys typed where a name or a label goes ---------------------------------------------------------------
// The shapes are kept here, not taken from secrets.ts: the browser loads this module, and a module the browser
// loads takes no value from another shared module. secrets.ts, the raw-secret guard, knows the same shapes
// and more, for every write; these are the ones a key pasted into the wrong field of a provider takes.

/** Keys by their prefix: what a model provider, or anything else a person might paste, issues. */
const KEY_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI, Anthropic, OpenRouter
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, // a JWT
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/i, // Slack
  /\bAKIA[0-9A-Z]{12,}/, // an AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, // an Authorization header's value
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bhf_[A-Za-z0-9]{30,}/, // Hugging Face
  /\bapi_org_[A-Za-z0-9]{30,}/, // Hugging Face, an organisation's
  /\bAIza[0-9A-Za-z_-]{35}/, // Google
  /\bgsk_[A-Za-z0-9]{20,}/, // Groq
  /\bpplx-[A-Za-z0-9]{20,}/, // Perplexity
  /\bcsk-[A-Za-z0-9]{20,}/, // Cerebras
  /\bnvapi-[A-Za-z0-9_-]{20,}/, // NVIDIA
  /\bfw_[A-Za-z0-9]{20,}/, // Fireworks
  /\btgp_v1_[A-Za-z0-9_-]{20,}/, // Together
  /\bbedrock-api-key-[A-Za-z0-9+/=]{20,}/, // an Amazon Bedrock API key, short-term
  // A value given to a secret-named variable as a shell or an .env file writes it: OPENAI_API_KEY=… (secrets.ts).
  /(?:^|\s)[A-Za-z0-9_]*(?:api[_-]?key|secret(?:[_-]?key)?|private[_-]?key|password|passwd|token)=[A-Za-z0-9._~+/:@%^*!#-]{8,}/i,
];

/** A run of hex, dashes aside: an Azure key is 32 characters, and a key written as a UUID is one too. */
function hexRun(text: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(text.replace(/-/g, ""));
}

/** Base64 of 40 characters or more with a digit in it: an AWS secret access key, slashes and all. */
function base64Run(text: string): boolean {
  return /^[A-Za-z0-9+/=]{40,}$/.test(text) && /[0-9]/.test(text);
}

/**
 * Whether a run of letters and digits is random, as a key is, rather than words run together: long, in both
 * cases, and with most of it not in words (a capital and two lower-case letters or more). Identifiers and
 * model names read as words (notionIntegrationV2Secret 0.92, DeepSeekR1DistillQwen32B 0.79,
 * Mixtral8x7BInstructV01 0.68); a random 32-character key reads about 0.35, and 0.65 or more about one time
 * in fifty. An identifier in one case (ACMEPRODUCTIONOPENAI) is not random.
 */
function randomRun(run: string): boolean {
  if (run.length < 20 || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  let inWords = 0;
  for (const word of run.matchAll(/[A-Z]?[a-z]{2,}/g)) inWords += word[0].length;
  return inWords / run.length < 0.65;
}

/**
 * A run of 32 characters or more in a base64url key's alphabet that reads as random. Such a key (Together's,
 * Voyage's, many bare ones) has dashes and underscores in it, which break it into pieces too short to read
 * alone, so the run is read whole, by randomRun's measure, with one more kind of word: a piece in capitals and
 * digits, 8 long at most (API, KEY, FP8, 480B, A35B), as names and model ids are made of. A run a key's dashes
 * break has few such pieces; one made of words joined by dashes or underscores reads as words.
 */
function longRandomRun(text: string): boolean {
  for (const [run] of text.matchAll(/[A-Za-z0-9_-]{32,}/g)) {
    if (!/[A-Z]/.test(run) || !/[a-z]/.test(run)) continue;
    let length = 0;
    let inWords = 0;
    for (const piece of run.split(/[-_]+/)) {
      length += piece.length;
      if (/^[A-Z0-9]{1,8}$/.test(piece)) inWords += piece.length;
      else for (const word of piece.matchAll(/[A-Z]?[a-z]{2,}/g)) inWords += word[0].length;
    }
    if (inWords / length < 0.65) return true;
  }
  return false;
}

/** Whether a word, between spaces or punctuation, looks like a key. */
function wordLooksLikeKey(word: string): boolean {
  return hexRun(word) || word.split(/[^A-Za-z0-9]+/).some(randomRun);
}

/**
 * Whether what was given as an env var NAME looks like a key pasted in its place: a key's known shape, a run
 * too long for a name, of base64 or long and random, or a word between its underscores that is a run of hex or
 * random.
 */
export function nameLooksLikeKey(name: string): boolean {
  if (name.length > 128 || base64Run(name) || longRandomRun(name) || KEY_SHAPES.some((re) => re.test(name)))
    return true;
  return name.split("_").some(wordLooksLikeKey);
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
 * Whether a label people read has a key in it: a key's known shape anywhere, a long random run dashes and all,
 * or a word that is base64 (an AWS secret access key), a run of hex (an Azure key, a key written as a UUID) or
 * random (a Mistral key). Words split on spaces and the punctuation labels use; a model's name in a label reads
 * as words.
 */
export function labelLooksLikeKey(label: string): boolean {
  if (longRandomRun(label) || KEY_SHAPES.some((re) => re.test(label))) return true;
  return label
    .split(/\s+/)
    .filter(Boolean)
    .some((word) => base64Run(word) || word.split(/[/().,@:;_]+/).some(wordLooksLikeKey));
}

/** A Bedrock OpenAI model Runtime takes: a cross-Region inference profile id, or an inference profile's ARN. */
export const BEDROCK_OPENAI_ID_RE = /^(?:(?:global|[a-z]{2,4})\.openai\.|arn:aws[a-z-]*:bedrock:)/;

/** A model id as an Anthropic provider keeps it: written the way people say it (claude-opus-5.5), put Claude Code's way. */
export function anthropicModelId(id: string): string {
  return id.startsWith("claude-") ? id.replace(/(\d)\.(?=\d)/g, "$1-") : id;
}

/**
 * Why a model id will not do on this provider's list, or null; the board's schema says the same. For a form, to
 * say it before anything is sent.
 */
export function modelIdProblem(
  kind: ProviderKind,
  family: ModelFamily,
  raw: string,
  listed: readonly string[],
): string | null {
  const id = kind === "anthropic" ? anthropicModelId(raw.trim()) : raw.trim();
  if (!id) return "Give the model's id.";
  if (/\s/.test(id)) return "A model id has no spaces.";
  if (id.length > 120) return "A model id is 120 characters at most.";
  if (!familiesFor(kind).includes(family))
    return `${PROVIDER_KIND_LABELS[kind]} serves ${familiesFor(kind)
      .map((f) => FAMILY_LABELS[f])
      .join(" and ")} models here.`;
  if (kind === "bedrock" && family === "openai" && !BEDROCK_OPENAI_ID_RE.test(id))
    return "A Bedrock OpenAI model is a cross-Region inference profile id (global.openai.… or us.openai.…) or its ARN.";
  if (listed.includes(id)) return "This model is on the list already.";
  return null;
}

/** The headers an OpenAI-compatible server may take its key in. */
export const COMPATIBLE_AUTH_HEADERS = ["authorization", "api-key", "x-api-key"] as const;
export type CompatibleAuthHeader = (typeof COMPATIBLE_AUTH_HEADERS)[number];

/** The most models one provider lists. */
export const MAX_PROVIDER_MODELS = 200;
