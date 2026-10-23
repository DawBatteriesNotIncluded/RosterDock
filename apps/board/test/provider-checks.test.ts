// Check, for every kind of model provider: the board lists the models a company's key reaches with one call
// that spends nothing, replayed from what each service answered when the owner recorded it with their own
// accounts (scripts/record-provider-checks.mts, fixtures/providers): a key that works, and a wrong one. The key
// is resolved from the company's secrets and goes only in its kind's header; a refusal is said in the board's
// words, never the provider's; an address that turned private since the provider was saved is refused before
// anything is sent; and the operator's own Anthropic settings never reach a company's request. No network.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseModelProviders, PROVIDER_KINDS, type ProviderKind } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_LISTED, statusWords } from "../src/providers/check.js";
import { parsePrivateDestinations } from "../src/web/address.js";
import { PUBLIC_TEST_ADDRESS, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";
import { recording, replay, type Recording } from "./provider-replay.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-provider-checks-"));
/** What a company set under its key's name; the replay answers whatever key it is sent. */
const KEY = "company-model-key-0000000000000000";
/** The operator's own, where the board runs: none of it may reach a company's request. */
const OPERATOR: Record<string, string> = {
  ANTHROPIC_API_KEY: "operator-anthropic-key-000000000000",
  ANTHROPIC_AUTH_TOKEN: "operator-anthropic-token-0000000000",
  ANTHROPIC_BASE_URL: "https://models-gateway.operator.test",
  ANTHROPIC_CUSTOM_HEADERS: "x-operator-tenant: operator-header-0000000000",
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
  it.each(PROVIDER_KINDS)(
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
          for (const own of Object.values(OPERATOR)) expect(v, h).not.toContain(own);
        }
        expect(sent.headers["x-operator-tenant"]).toBeUndefined();
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
  });

  it("sends nothing for a key the company has not set, and says which name", async () => {
    const { api, base } = await seedCompany(board, "check-unset@example.com");
    const created = await api.post(`${base}/model-providers`, {
      kind: "openai",
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
    await api.put(`${base}/secrets/MODELS_ROUTER_KEY`, { value: KEY });
    const router = await api.post(`${base}/model-providers`, {
      kind: "openai_compatible",
      name: "router",
      label: "Router",
      endpoint: "https://router.rebind.test/v1",
      credentials: { apiKey: "MODELS_ROUTER_KEY" },
    });
    const azure = await api.post(`${base}/model-providers`, {
      kind: "azure_openai",
      name: "acme-azure",
      label: "Acme Azure",
      endpoint: "https://rebind.openai.azure.com",
      credentials: { apiKey: "MODELS_ROUTER_KEY" },
    });
    expect([router.status, azure.status]).toEqual([201, 201]);
    nowPrivate.add("router.rebind.test");
    nowPrivate.add("rebind.openai.azure.com");
    current = replay();
    for (const id of [router.body.id, azure.body.id]) {
      const checked = await api.post(`${base}/model-providers/${id}/check`, {});
      expect(checked.body.lastCheck.ok).toBe(false);
      expect(checked.body.lastCheck.detail).toMatch(/^refused: /);
    }
    expect(current.sent).toEqual([]);
  });

  it("is for owners and admins, on a provider in use, of a kind the operator offers", async () => {
    const { api, base } = await seedCompany(board, "check-who@example.com");
    const created = await api.post(`${base}/model-providers`, {
      kind: "openai",
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
      { modelProviders: parseModelProviders("anthropic,board") },
      { providerFetch: (input, init) => current.fetch(input, init) },
    );
    try {
      const n = await seedCompany(narrow, "check-narrow@example.com");
      const kept = await narrow.db.query<{ id: string }>(
        `INSERT INTO model_providers (company_id, name, label, kind, credentials, created_by_kind, created_by_id)
         VALUES ($1, 'kept', 'Kept', 'openai', '{"apiKey":"MODELS_KEPT_KEY"}', 'user', $2) RETURNING id`,
        [n.companyId, n.owner.userId],
      );
      current = replay();
      const refused = await n.api.post(`${n.base}/model-providers/${kept.rows[0]!.id}/check`, {});
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("does not offer OpenAI providers");
      expect(current.sent).toEqual([]);
    } finally {
      await narrow.destroy();
    }
  });
});
