// Record what one kind of model provider answers to the board's Check, as test/fixtures/providers: the list of
// models for a key that works (<kind>-models.json), and the answer to a wrong key (<kind>-refused.json). The
// requests are the board's own (listModels, src/providers/check.ts), sent from your machine with your account.
// The key comes from your own shell, or is asked for here without echo; it goes only to the provider, and never
// into a file: a request header that carries a key is written as <key>, and each file is scrubbed and searched
// for any part of the key before it is written. Of your account the files keep the models' ids and names only:
// Bedrock's ARNs with the account number zeroed, OpenAI's fine-tuned models with the organisation renamed, an
// Azure resource or a compatible server under a stand-in host.
//
// Usage, from apps/board, one kind at a time (a variable left unset is asked for):
//   node --import tsx scripts/record-provider-checks.mts anthropic           ANTHROPIC_API_KEY
//   node --import tsx scripts/record-provider-checks.mts openai              OPENAI_API_KEY
//   node --import tsx scripts/record-provider-checks.mts azure_openai        AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY
//   node --import tsx scripts/record-provider-checks.mts bedrock             AWS_REGION, AWS_BEARER_TOKEN_BEDROCK
//   node --import tsx scripts/record-provider-checks.mts openai_compatible   OPENAI_COMPATIBLE_BASE_URL (http://localhost:11434/v1
//                                                                              for Ollama), OPENAI_COMPATIBLE_API_KEY (empty: none)
// A compatible server that takes no key cannot refuse one: give a server that takes a key for the refusal, as
// `--refused=<base URL>` or OPENAI_COMPATIBLE_REFUSED_BASE_URL (vLLM started with --api-key, LiteLLM with a
// master key, or OpenAI's own API, https://api.openai.com/v1, which refuses a wrong key without an account).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  azureEndpoint,
  BEDROCK_REGION_RE,
  compatibleEndpoint,
  PROVIDER_KINDS,
  type ProviderKind,
} from "@rosterdock/shared";
import { listModels, type ListTarget } from "../src/providers/check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "test", "fixtures", "providers");

/** Wrong keys shaped like each kind's, never one anyone was issued. */
const WRONG_KEYS: Record<ProviderKind, string> = {
  anthropic: `sk-ant-api03-rosterdock-recorder-not-a-key-${"0".repeat(52)}`,
  openai: `sk-proj-rosterdock-recorder-not-a-key-${"0".repeat(48)}`,
  azure_openai: "0".repeat(32),
  bedrock: `bedrock-api-key-${Buffer.from("rosterdock-recorder-not-a-key-0000000000").toString("base64")}`,
  openai_compatible: "rosterdock-recorder-not-a-key-0000000000",
};
/** Where a stand-in host replaces the one you gave. */
const STAND_IN_AZURE = "acme";
const STAND_IN_COMPATIBLE = "llm.internal.test";

const kind = process.argv[2] as ProviderKind;
if (!PROVIDER_KINDS.includes(kind)) {
  console.error(`usage: node --import tsx scripts/record-provider-checks.mts <${PROVIDER_KINDS.join("|")}>`);
  process.exit(2);
}

/** A value from the shell, or asked for: plainly, or without echo for a key. */
async function given(name: string, question: string, opts: { hidden?: boolean; fallback?: string } = {}) {
  const set = process.env[name];
  if (set !== undefined) return set.trim();
  if (!process.stdin.isTTY)
    throw new Error(
      opts.hidden
        ? `${name} is not set, and this window cannot ask for it without showing it: set ${name} in this shell, or run this in PowerShell or Windows Terminal (or a macOS or Linux terminal), where it is asked for`
        : `${name} is not set, and this window cannot ask for it: set ${name} in this shell first`,
    );
  if (!opts.hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question}${opts.fallback ? ` [${opts.fallback}]` : ""}: `)).trim();
    rl.close();
    return answer || opts.fallback || "";
  }
  return new Promise<string>((resolve) => {
    process.stdout.write(`${question} (not shown, not saved): `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

interface Exchange {
  request: { method: string; url: string; headers: Record<string, string> };
  response: { status: number; contentType: string | null; body: unknown };
}

/** The headers a key travels in; written as <key>. */
const KEY_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

/** A transport that sends for real and keeps every exchange: the request without its key, the answer whole. */
function recorder(): { fetch: typeof fetch; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const recording: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const text = await res.text();
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers).entries())
      if (!name.startsWith("x-stainless-")) headers[name] = KEY_HEADERS.has(name) ? "<key>" : value;
    const contentType = res.headers.get("content-type");
    let body: unknown = text;
    if (contentType?.includes("json"))
      try {
        body = JSON.parse(text);
      } catch {
        // kept as text
      }
    exchanges.push({
      request: {
        method: (init?.method ?? "GET").toUpperCase(),
        url,
        headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1))),
      },
      response: { status: res.status, contentType, body },
    });
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { fetch: recording, exchanges };
}

/** Every way a JSON file could hold the text: as it is, and as JSON escapes it. */
function forms(text: string): string[] {
  return [...new Set([text, JSON.stringify(text).slice(1, -1)])];
}

/**
 * The file's text with every key, and what identifies your account, replaced; null if any part of the key
 * (twelve characters in a row, or the whole of a shorter one) is still in it. `standIns` are replaced in order:
 * a compatible server's base URL whole, path and all, then any host left.
 */
function scrubbed(
  text: string,
  keys: { real: string | null; wrong: string },
  standIns: [string, string][],
): string | null {
  let t = text;
  for (const [from, to] of standIns) t = t.split(from).join(to);
  if (keys.real) for (const f of forms(keys.real)) t = t.split(f).join("<key>");
  for (const f of forms(keys.wrong)) t = t.split(f).join("<a wrong key>");
  // A key named back in part, as OpenAI's refusal does (sk-proj-****…abcd).
  t = t.replace(/\b(?:sk|bedrock)-[A-Za-z0-9_-]{0,12}\*{3,}[A-Za-z0-9_-]{0,8}/g, "<part of a key>");
  // An AWS account number in an ARN.
  t = t.replace(/(arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:)\d{12}(?=:)/g, "$1000000000000");
  // An OpenAI organisation, or a person, that owns a fine-tuned model.
  t = t.replace(/"owned_by":\s*"(?:org|user)-[A-Za-z0-9_-]+"/g, '"owned_by": "org-recorded"');
  t = t.replace(/\bft:([A-Za-z0-9._-]+):[A-Za-z0-9_-]+:/g, "ft:$1:org-recorded:");
  // What follows a key's published prefix (sk-ant-api03-, sk-proj-, bedrock-api-key-) is the secret part.
  const secret = keys.real?.replace(/^(?:sk-ant-[a-z]+\d*-|sk-proj-|sk-|bedrock-api-key-)/, "") ?? "";
  if (secret.length >= 6 && secret.length < 12 && t.includes(secret)) return null;
  for (let i = 0; i + 12 <= secret.length; i++) if (t.includes(secret.slice(i, i + 12))) return null;
  return t;
}

function write(
  name: string,
  record: unknown,
  keys: { real: string | null; wrong: string },
  standIns: [string, string][],
) {
  const text = scrubbed(`${JSON.stringify(record, null, 2)}\n`, keys, standIns);
  if (text === null) {
    console.error(`${name}: part of your key is still in it after the scrub; nothing was written`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, name), text);
  console.log(`wrote test/fixtures/providers/${name}`);
}

async function main() {
  let target: ListTarget = { kind, endpoint: null, region: null, auth_header: null };
  let key: string | null;
  let refusedTarget = target;
  // What is written under a stand-in, so the files say nothing of where your account lives.
  const standIns: [string, string][] = [];
  switch (kind) {
    case "anthropic":
      key = await given("ANTHROPIC_API_KEY", "Anthropic API key", { hidden: true });
      break;
    case "openai":
      key = await given("OPENAI_API_KEY", "OpenAI API key", { hidden: true });
      break;
    case "azure_openai": {
      const endpoint = azureEndpoint(await given("AZURE_OPENAI_ENDPOINT", "Azure OpenAI resource address"));
      if (!endpoint) throw new Error("the resource's address is https://<resource>.openai.azure.com");
      target = { ...target, endpoint };
      refusedTarget = target;
      const host = new URL(endpoint).hostname;
      standIns.push([host, host.replace(/^[^.]+/, STAND_IN_AZURE)]);
      key = await given("AZURE_OPENAI_API_KEY", "Azure OpenAI key", { hidden: true });
      break;
    }
    case "bedrock": {
      const region = await given("AWS_REGION", "AWS region", { fallback: "us-east-1" });
      if (!BEDROCK_REGION_RE.test(region)) throw new Error("an AWS region, such as us-east-1");
      target = { ...target, region };
      refusedTarget = target;
      key = await given("AWS_BEARER_TOKEN_BEDROCK", "Bedrock API key", { hidden: true });
      break;
    }
    case "openai_compatible": {
      const endpoint = compatibleEndpoint(
        await given("OPENAI_COMPATIBLE_BASE_URL", "The server's base URL", {
          fallback: "http://localhost:11434/v1",
        }),
      );
      if (!endpoint) throw new Error("the server's base URL, such as http://localhost:11434/v1");
      key =
        (await given("OPENAI_COMPATIBLE_API_KEY", "Its key (empty: it takes none)", { hidden: true })) ||
        null;
      target = { ...target, endpoint, auth_header: key ? "authorization" : null };
      const refusedBase = (
        process.argv.find((a) => a.startsWith("--refused="))?.slice("--refused=".length) ??
        process.env.OPENAI_COMPATIBLE_REFUSED_BASE_URL
      )?.trim();
      const refusedEndpoint = refusedBase ? compatibleEndpoint(refusedBase) : endpoint;
      if (!refusedEndpoint)
        throw new Error("the refusal's server is not a base URL, such as https://api.openai.com/v1");
      refusedTarget = { ...target, endpoint: refusedEndpoint, auth_header: "authorization" };
      // The base URL whole (a gateway's path can name an account), then its host wherever else it is.
      for (const e of new Set([endpoint, refusedEndpoint]))
        standIns.unshift([e, `${new URL(e).protocol}//${STAND_IN_COMPATIBLE}/v1`]);
      for (const e of new Set([endpoint, refusedEndpoint])) {
        const host = new URL(e).hostname;
        if (!standIns.some(([from]) => from === host)) standIns.push([host, STAND_IN_COMPATIBLE]);
      }
      break;
    }
  }
  if (kind !== "openai_compatible" && !key) throw new Error("no key given");
  // As the board takes one (check.ts): anything else cannot go in a header, and a header's error quotes it.
  if (key && !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(key))
    throw new Error("a key is one line of printable text, and what was given is not; nothing was sent");
  const keys = { real: key, wrong: WRONG_KEYS[kind] };
  const recorded = new Date().toISOString().slice(0, 10);
  const stand = (t: ListTarget) => ({
    endpoint: t.endpoint ? standIns.reduce((e, [from, to]) => e.split(from).join(to), t.endpoint) : null,
    region: t.region,
    authHeader: t.auth_header,
  });

  const works = recorder();
  try {
    const listing = await listModels(target, key, works.fetch);
    console.log(`the key works: ${listing.total} models (${listing.models.length} kept for people to add)`);
  } catch (err) {
    console.error(`the key did not list models: ${(err as Error).message}`);
    console.error("nothing was written; fix the key, the address or the region and run it again");
    process.exit(1);
  }
  write(
    `${kind}-models.json`,
    { recorded, kind, provider: stand(target), exchanges: works.exchanges },
    keys,
    standIns,
  );

  const refused = recorder();
  try {
    await listModels(refusedTarget, WRONG_KEYS[kind], refused.fetch);
    console.error(
      "the server took a wrong key: it takes none, so it cannot refuse one. Run it again with --refused=<base URL> of a server that takes a key (https://api.openai.com/v1 does)",
    );
    process.exit(1);
  } catch (err) {
    console.log(`a wrong key: ${(err as Error).message}`);
  }
  // A refusal is an answer: a key refused, 401 or 403, never a connection that failed.
  const last = refused.exchanges.at(-1)?.response.status;
  if (last !== 401 && last !== 403) {
    console.error(
      `a wrong key was not refused with 401 or 403 (${last ?? "no answer"}); nothing more was written`,
    );
    process.exit(1);
  }
  write(
    `${kind}-refused.json`,
    { recorded, kind, provider: stand(refusedTarget), exchanges: refused.exchanges },
    keys,
    standIns,
  );
  console.log(
    "check both files for anything that looks like a secret or names your account before committing",
  );
}

try {
  await main();
} catch (err) {
  // What went wrong, in words and without a stack; the key is checked before anything quotes it.
  console.error((err as Error).message);
  process.exit(1);
}
