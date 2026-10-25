// Check, for each kind of model provider whose answers are recorded (CHECKABLE_KINDS): the board lists the
// models a company's key reaches with one call that spends nothing, replayed from what the service answered
// when the owner recorded it with their own account (scripts/record-provider-checks.mts, fixtures/providers): a
// key that works, and a wrong one. The key is resolved from the company's secrets and goes only in its kind's
// header; a refusal is said in the board's words, never the provider's; an address that turned private since
// the provider was saved is refused before anything is sent; the operator's own Anthropic settings never reach
// a company's request; and a kind not recorded yet is not called at all. No network.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECKABLE_KINDS,
  parseModelProviders,
  PROVIDER_KIND_LABELS,
  PROVIDER_KINDS,
  type ProviderKind,
} from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyAnthropic } from "../src/providers/anthropic.js";
import { MAX_LISTED, statusWords } from "../src/providers/check.js";
import { parsePrivateDestinations } from "../src/web/address.js";
import { PUBLIC_TEST_ADDRESS, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";
import { recording, replay, type Recording } from "./provider-replay.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-provider-checks-"));
/** What a company set under its key's name; the replay answers whatever key it is sent. */
const KEY = "company-model-key-0000000000000000";
/**
 * The operator's own, where the board runs: none of it may reach a company's request. The SDK applies custom
 * headers after the key, so these would put the operator's key in place of the company's.
 */
const OPERATOR_VALUES = {
  key: "operator-anthropic-key-000000000000",
  token: "operator-anthropic-token-0000000000",
  beta: "operator-beta-2099-01-01",
  tenant: "operator-tenant-0000000000",
};
const OPERATOR: Record<string, string> = {
  ANTHROPIC_API_KEY: OPERATOR_VALUES.key,
  ANTHROPIC_AUTH_TOKEN: OPERATOR_VALUES.token,
  ANTHROPIC_BASE_URL: "https://models-gateway.operator.test",
  ANTHROPIC_CUSTOM_HEADERS: [
    `x-api-key: ${OPERATOR_VALUES.key}`,
    `anthropic-beta: ${OPERATOR_VALUES.beta}`,
    "anthropic-version: 2099-01-01",
    `x-stainless-tenant: ${OPERATOR_VALUES.tenant}`,
    `x-operator-tenant: ${OPERATOR_VALUES.tenant}`,
  ].join("\n"),
  ANTHROPIC_LOG: "debug",
};
const saved: Record<string, string | undefined> = {};

// A name under internal.test is an in-cluster server at a private address the operator lists; a name in
// nowPrivate has moved to a private address since its provider was saved.
const nowPrivate = new Set<string>();
const resolve = async (host: string) =>
  host.endsWith(".internal.test") || nowPrivate.has(host) ? ["10.0.0.5"] : [PUBLIC_TEST_ADDRESS];
let current = replay();
let board: TestBoard;

beforeAll(async () => {
  // The SDK reads these from the process itself: set as an operator would set them, they must change nothing.
  for (const [name, value] of Object.entries(OPERATOR)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  board = await startTestBoard(
    {
      secretStore: { kind: "file", dir },
      privateDestinations: parsePrivateDestinations("llm.internal.test"),
    },
    {
      env: { ...OPERATOR },
      egressResolve: resolve,
      providerFetch: (input, init) => current.fetch(input, init),
    },
  );
});
afterAll(async () => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await board.destroy();
  rmSync(dir, { recursive: true, force: true });
});

/** The provider a recording was made against, with its key under `secret` (null: a server that takes none). */
function providerBody(r: Recording, name: string, secret: string | null): Record<string, unknown> {
  const base = { kind: r.kind, name, label: `Recorded ${name}` };
  switch (r.kind) {
    case "anthropic":
    case "openai":
      return { ...base, credentials: { apiKey: secret } };
    case "azure_openai":
      return { ...base, endpoint: r.provider.endpoint, credentials: { apiKey: secret } };
    case "bedrock":
      return { ...base, region: r.provider.region, credentials: { bearerToken: secret } };
    case "openai_compatible":
      return secret
        ? {
            ...base,
            endpoint: r.provider.endpoint,
            authHeader: r.provider.authHeader ?? "authorization",
            credentials: { apiKey: secret },
          }
        : { ...base, endpoint: r.provider.endpoint, credentials: {} };
  }
}

/** The header a kind's key goes in, and what it holds. */
function keyHeader(kind: ProviderKind, authHeader: string | null): [string, string] {
  if (kind === "anthropic") return ["x-api-key", KEY];
  if (kind === "azure_openai") return ["api-key", KEY];
  if (kind === "openai_compatible" && authHeader && authHeader !== "authorization") return [authHeader, KEY];
  return ["authorization", `Bearer ${KEY}`];
}

/**
 * The models a recording says the key reaches, read as each service documents its list: Anthropic's models
 * that are not retired; Bedrock's active system inference profiles, then the foundation models it runs on
 * demand that answer in text; anyone else's list, whole.
 */
function reachedIds(r: Recording): string[] {
  const bodies = r.exchanges.map((e) => e.response.body as any);
  const ids =
    r.kind === "anthropic"
      ? bodies.flatMap((b) => b.data).filter((m) => m.lifecycle !== "retired")
      : r.kind === "bedrock"
        ? [
            ...bodies
              .flatMap((b) => b.inferenceProfileSummaries ?? [])
              .filter((p) => (p.status ?? "ACTIVE") === "ACTIVE")
              .map((p) => ({ id: p.inferenceProfileId })),
            ...bodies
              .flatMap((b) => b.modelSummaries ?? [])
              .filter((m) => m.outputModalities?.includes("TEXT"))
              .map((m) => ({ id: m.modelId })),
          ]
        : bodies.flatMap((b) => b.data);
  return [...new Set(ids.map((m: { id: string }) => m.id))];
}

/** Every phrase in what a provider answered, so a test can say none of it was kept. */
function phrases(body: unknown): string[] {
  if (typeof body === "string") return body.length >= 12 ? [body] : [];
  if (Array.isArray(body)) return body.flatMap(phrases);
  if (body && typeof body === "object") return Object.values(body).flatMap(phrases);
  return [];
}

type Ev = { type: string; subject: { id: string } | null; payload: Record<string, unknown> };
const checks = async (api: { get(url: string): Promise<{ body: unknown }> }, base: string, id: string) =>
  ((await api.get(`${base}/events?limit=100`)).body as Ev[]).filter(
    (e) => e.type === "model_provider.checked" && e.subject?.id === id,
  );

describe("checking a model provider", () => {
  it.each([...CHECKABLE_KINDS])(
    "%s: a key that works lists the models it reaches; a wrong one is refused in the board's words",
    async (kind) => {
      const works = recording(`${kind}-models.json`);
      const refused = recording(`${kind}-refused.json`);
      const { api, base } = await seedCompany(board, `check-${kind}@example.com`);
      const secret = `MODELS_RECORDED_${kind.toUpperCase()}_KEY`;
      expect((await api.put(`${base}/secrets/${secret}`, { value: KEY })).status).toBe(200);
      const keyless = kind === "openai_compatible" && !works.provider.authHeader;
      const name = `recorded-${kind.replace("_", "-")}`;
      const created = await api.post(
        `${base}/model-providers`,
        providerBody(works, name, keyless ? null : secret),
      );
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      current = replay(works);
      const checked = await api.post(`${base}/model-providers/${id}/check`, {});
      expect(checked.status).toBe(200);
      // Every request was the one recorded: its method, its URL, and its headers as recorded.
      expect(current.misses).toEqual([]);
      const ids = reachedIds(works);
      expect(ids.length).toBeGreaterThan(0);
      expect(checked.body.lastCheck).toMatchObject({ ok: true, detail: null, listed: ids.length });
      expect(checked.body.lastCheck.models.map((m: { id: string }) => m.id)).toEqual(
        ids.slice(0, MAX_LISTED),
      );
      // Every request recorded was sent as it was recorded, and nothing more.
      expect(current.sent.map((s) => `${s.method} ${s.url}`)).toEqual(
        works.exchanges.map((e) => `${e.request.method} ${e.request.url}`),
      );
      // The key went in its kind's header and nowhere else, and nothing of the operator's went at all.
      const [header, value] = keyHeader(kind, created.body.authHeader);
      for (const sent of current.sent) {
        if (keyless) expect(Object.values(sent.headers).join("\n")).not.toContain(KEY);
        else expect(sent.headers[header]).toBe(value);
        for (const [h, v] of Object.entries(sent.headers)) {
          if (h !== header) expect(v, h).not.toContain(KEY);
          for (const own of Object.values(OPERATOR_VALUES)) expect(v, h).not.toContain(own);
        }
        for (const h of ["x-operator-tenant", "x-stainless-tenant", "anthropic-beta"])
          expect(sent.headers[h], h).toBeUndefined();
      }
      // Check adds nothing to the provider's list of models: a person adds what they want from it.
      expect(checked.body.models).toEqual([]);

      // The refusal of a compatible server came from one that takes a key.
      if (kind === "openai_compatible") {
        const moved = await api.patch(`${base}/model-providers/${id}`, {
          endpoint: refused.provider.endpoint,
          authHeader: "authorization",
          credentials: { apiKey: secret },
        });
        expect(moved.status).toBe(200);
      }
      current = replay(refused);
      const no = await api.post(`${base}/model-providers/${id}/check`, {});
      expect(no.status).toBe(200);
      expect(current.misses).toEqual([]);
      const status = refused.exchanges.at(-1)!.response.status;
      expect(no.body.lastCheck).toMatchObject({ ok: false, listed: 0, detail: statusWords(kind, status) });
      expect(no.body.lastCheck.models).toBeUndefined();

      // One event a check, names and counts only; nothing the provider said, and no key, is kept anywhere.
      const events = await checks(api, base, id);
      expect(events.map((e) => e.payload.ok)).toEqual([false, true]);
      expect(events[1]!.payload).toMatchObject({ name, kind, ok: true, detail: null, listed: ids.length });
      expect(events[0]!.payload).toMatchObject({ ok: false, listed: 0, detail: statusWords(kind, status) });
      const everything = JSON.stringify([events, checked.body, no.body]);
      expect(everything).not.toContain(KEY);
      for (const said of phrases(refused.exchanges.at(-1)!.response.body))
        expect(everything).not.toContain(said);
    },
  );

  it("marks the models on the list the key reaches, and a change keeps the mark", async () => {
    const works = recording("anthropic-models.json");
    const [first, second] = reachedIds(works);
    const { api, base } = await seedCompany(board, "check-marks@example.com");
    await api.put(`${base}/secrets/MODELS_MARKS_KEY`, { value: KEY });
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "marks",
      label: "Marks",
      credentials: { apiKey: "MODELS_MARKS_KEY" },
      models: [
        { id: first, family: "claude" },
        { id: "claude-nobody-lists-this-0", family: "claude" },
      ],
    });
    expect(created.body.models.map((m: { source: string }) => m.source)).toEqual(["typed", "typed"]);
    current = replay(works);
    const checked = await api.post(`${base}/model-providers/${created.body.id}/check`, {});
    expect(checked.body.models).toMatchObject([
      { id: first, source: "listed" },
      { id: "claude-nobody-lists-this-0", source: "typed" },
    ]);
    // A model added from the key's list is marked as it is added; one typed stays typed.
    const added = await api.patch(`${base}/model-providers/${created.body.id}`, {
      models: [
        ...checked.body.models.map(({ id, family }: { id: string; family: string }) => ({ id, family })),
        {
          id: second,
          family: "claude",
        },
      ],
    });
    expect(added.body.models.map((m: { source: string }) => m.source)).toEqual(["listed", "typed", "listed"]);
    // Another key: what the old one reached says nothing of it, so the check and its marks go.
    await api.put(`${base}/secrets/MODELS_MARKS_OTHER_KEY`, { value: KEY });
    const rekeyed = await api.patch(`${base}/model-providers/${created.body.id}`, {
      credentials: { apiKey: "MODELS_MARKS_OTHER_KEY" },
    });
    expect(rekeyed.body.lastCheck).toBeNull();
    expect(rekeyed.body.models.map((m: { source: string }) => m.source)).toEqual(["typed", "typed", "typed"]);
  });

  it("sends no key that is not one line of printable text, and never says it back", async () => {
    const { api, base } = await seedCompany(board, "check-lines@example.com");
    const pem = "-----BEGIN DATA-----\r\nline-one-of-a-secret-0000\r\nline-two-of-a-secret-0000";
    expect((await api.put(`${base}/secrets/MODELS_PEM_KEY`, { value: pem })).status).toBe(200);
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "pem",
      label: "Pem",
      credentials: { apiKey: "MODELS_PEM_KEY" },
    });
    expect(created.status).toBe(201);
    current = replay();
    const checked = await api.post(`${base}/model-providers/${created.body.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({
      ok: false,
      detail:
        "MODELS_PEM_KEY holds something that is not a key: a key is one line of printable text, with no line break in it",
    });
    expect(current.sent).toEqual([]);
    const events = await checks(api, base, created.body.id);
    expect(events).toHaveLength(1);
    const everything = JSON.stringify([events, (await api.get(`${base}/model-providers`)).body]);
    expect(everything).not.toContain("line-one-of-a-secret");
    expect(everything).not.toContain("line-two-of-a-secret");
  });

  it("says a call that got no answer in the board's words, and nothing an error quoted", async () => {
    const { api, base } = await seedCompany(board, "check-errors@example.com");
    await api.put(`${base}/secrets/MODELS_ERRORS_KEY`, { value: KEY });
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "errors",
      label: "Errors",
      credentials: { apiKey: "MODELS_ERRORS_KEY" },
    });
    const id = created.body.id as string;
    // No answer is made up: each transport fails as a connection does, before any answer.
    const failing = (err: Error) => ({ fetch: async () => Promise.reject(err), sent: [], misses: [] });
    current = failing(
      Object.assign(new Error("connect ECONNREFUSED 93.184.215.14:443"), { code: "ECONNREFUSED" }),
    );
    expect((await api.post(`${base}/model-providers/${id}/check`, {})).body.lastCheck.detail).toBe(
      "the provider's address refused the connection",
    );
    current = failing(new TypeError(`Headers.append: "${KEY}" is an invalid header value.`));
    const quoted = await api.post(`${base}/model-providers/${id}/check`, {});
    expect(quoted.body.lastCheck.detail).toBe("the call to the provider failed before it answered");
    expect(JSON.stringify([quoted.body, await checks(api, base, id)])).not.toContain(KEY);
  });

  it("keeps no check made with settings that changed while it was made", async () => {
    const { api, base } = await seedCompany(board, "check-moved@example.com");
    await api.put(`${base}/secrets/MODELS_MOVED_KEY`, { value: KEY });
    await api.put(`${base}/secrets/MODELS_MOVED_OTHER_KEY`, { value: KEY });
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "moved",
      label: "Moved",
      credentials: { apiKey: "MODELS_MOVED_KEY" },
    });
    const id = created.body.id as string;
    // A check made with an unset key leaves a check behind; a change of label keeps it.
    const unset = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "stale",
      label: "Stale",
      credentials: { apiKey: "MODELS_STALE_KEY" },
    });
    current = replay();
    expect((await api.post(`${base}/model-providers/${unset.body.id}/check`, {})).body.lastCheck.ok).toBe(
      false,
    );
    const relabelled = await api.patch(`${base}/model-providers/${unset.body.id}`, { label: "Stale (old)" });
    expect(relabelled.body.lastCheck).not.toBeNull();
    // Moved to another key's name: the check is gone, since it spoke for the one before.
    const rekeyed = await api.patch(`${base}/model-providers/${unset.body.id}`, {
      credentials: { apiKey: "MODELS_MOVED_KEY" },
    });
    expect(rekeyed.body.lastCheck).toBeNull();

    // The provider moves to another key while its check is under way: that check is not kept.
    current = {
      fetch: async () => {
        await api.patch(`${base}/model-providers/${id}`, {
          credentials: { apiKey: "MODELS_MOVED_OTHER_KEY" },
        });
        throw Object.assign(new Error("connect ECONNREFUSED 93.184.215.14:443"), { code: "ECONNREFUSED" });
      },
      sent: [],
      misses: [],
    };
    const raced = await api.post(`${base}/model-providers/${id}/check`, {});
    expect(raced.status).toBe(409);
    expect(raced.body.error).toBe("Moved changed while it was being checked: check it again");
    const after = await api.get(`${base}/model-providers/${id}`);
    expect(after.body).toMatchObject({ credentials: { apiKey: "MODELS_MOVED_OTHER_KEY" }, lastCheck: null });
    expect(await checks(api, base, id)).toEqual([]);
  });

  it("asks Anthropic with the company's key alone, whatever the board's environment says", async () => {
    // What the SDK sends, caught before it leaves: nothing answers, so nothing is made up.
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const client = companyAnthropic({
      apiKey: KEY,
      timeoutMs: 5_000,
      fetch: async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
        seen.push({ url: String(input), headers });
        throw Object.assign(new Error("not sent"), { code: "ECONNREFUSED" });
      },
    });
    await expect(client.models.list({ limit: 1000 })).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(Object.keys(seen[0]!.headers).sort()).toEqual([
      "accept",
      "anthropic-version",
      "user-agent",
      "x-api-key",
    ]);
    expect(seen[0]!.headers).toMatchObject({
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": KEY,
    });
    expect(seen[0]!.headers["user-agent"]).toMatch(/^Anthropic\/JS /);
  });

  it("sends nothing for a key the company has not set, and says which name", async () => {
    const { api, base } = await seedCompany(board, "check-unset@example.com");
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "unset",
      label: "Unset key",
      credentials: { apiKey: "MODELS_UNSET_KEY" },
    });
    current = replay();
    const checked = await api.post(`${base}/model-providers/${created.body.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({
      ok: false,
      listed: 0,
      detail: "MODELS_UNSET_KEY is not set for this company (its secrets, or a name the board shares)",
    });
    expect(current.sent).toEqual([]);
  });

  it("refuses an address that turned private after the provider was saved, before anything is sent", async () => {
    const { api, base } = await seedCompany(board, "check-private@example.com");
    await api.put(`${base}/secrets/MODELS_PRIVATE_KEY`, { value: KEY });
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "private",
      label: "Private",
      credentials: { apiKey: "MODELS_PRIVATE_KEY" },
    });
    expect(created.status).toBe(201);
    // Even Anthropic's own host is checked at the call: one that answers with a private address is not reached.
    nowPrivate.add("api.anthropic.com");
    try {
      current = replay();
      const checked = await api.post(`${base}/model-providers/${created.body.id}/check`, {});
      expect(checked.body.lastCheck.ok).toBe(false);
      expect(checked.body.lastCheck.detail).toMatch(/^refused: api\.anthropic\.com resolves to /);
      expect(current.sent).toEqual([]);
    } finally {
      nowPrivate.delete("api.anthropic.com");
    }
  });

  it("calls no kind whose answers are not recorded yet: it says so, sends nothing and keeps nothing", async () => {
    const { api, base } = await seedCompany(board, "check-unrecorded@example.com");
    await api.put(`${base}/secrets/MODELS_UNRECORDED_KEY`, { value: KEY });
    const bodies: Record<ProviderKind, Record<string, unknown>> = {
      anthropic: { credentials: { apiKey: "MODELS_UNRECORDED_KEY" } },
      openai: { credentials: { apiKey: "MODELS_UNRECORDED_KEY" } },
      azure_openai: {
        endpoint: "https://acme.openai.azure.com",
        credentials: { apiKey: "MODELS_UNRECORDED_KEY" },
      },
      bedrock: { region: "us-east-1", credentials: { bearerToken: "MODELS_UNRECORDED_KEY" } },
      openai_compatible: {
        endpoint: "https://llm.example.test/v1",
        credentials: { apiKey: "MODELS_UNRECORDED_KEY" },
      },
    };
    const unrecorded = PROVIDER_KINDS.filter((k) => !CHECKABLE_KINDS.includes(k));
    expect(unrecorded.length).toBeGreaterThan(0);
    current = replay();
    for (const kind of unrecorded) {
      const name = `unrecorded-${kind.replace("_", "-")}`;
      const created = await api.post(`${base}/model-providers`, { kind, name, label: name, ...bodies[kind] });
      expect(created.status, kind).toBe(201);
      const refused = await api.post(`${base}/model-providers/${created.body.id}/check`, {});
      expect(refused.status, kind).toBe(409);
      expect(refused.body.error).toBe(
        `Check isn't available for ${PROVIDER_KIND_LABELS[kind]} providers yet`,
      );
      expect((await api.get(`${base}/model-providers/${created.body.id}`)).body.lastCheck).toBeNull();
      expect(await checks(api, base, created.body.id)).toEqual([]);
    }
    expect(current.sent).toEqual([]);
  });

  it("is for owners and admins, on a provider in use, of a kind the operator offers", async () => {
    const { api, base } = await seedCompany(board, "check-who@example.com");
    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "who",
      label: "Who",
      credentials: { apiKey: "MODELS_WHO_KEY" },
    });
    const id = created.body.id as string;
    await api.post(`${base}/members`, { email: "check-viewer@example.com", role: "viewer" });
    const viewer = board.api((await board.login("check-viewer@example.com")).token);
    expect((await viewer.post(`${base}/model-providers/${id}/check`, {})).status).toBe(403);
    await api.patch(`${base}/model-providers/${id}`, { archived: true });
    expect((await api.post(`${base}/model-providers/${id}/check`, {})).status).toBe(409);
    expect((await checks(api, base, id)).length).toBe(0);

    // A provider kept from before the operator stopped offering its kind is not called.
    const narrow = await startTestBoard(
      { modelProviders: parseModelProviders("openai,board") },
      { providerFetch: (input, init) => current.fetch(input, init) },
    );
    try {
      const n = await seedCompany(narrow, "check-narrow@example.com");
      const kept = await narrow.db.query<{ id: string }>(
        `INSERT INTO model_providers (company_id, name, label, kind, credentials, created_by_kind, created_by_id)
         VALUES ($1, 'kept', 'Kept', 'anthropic', '{"apiKey":"MODELS_KEPT_KEY"}', 'user', $2) RETURNING id`,
        [n.companyId, n.owner.userId],
      );
      current = replay();
      const refused = await n.api.post(`${n.base}/model-providers/${kept.rows[0]!.id}/check`, {});
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("does not offer Anthropic providers");
      expect(current.sent).toEqual([]);
    } finally {
      await narrow.destroy();
    }
  });
});
