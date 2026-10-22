// Company model providers: a company's own model accounts, by kind, with their credentials by env var NAME.
// Adding, changing, archiving and removing one goes through the guard (owners and admins), appends one event
// each, and carries names only: no value reaches a row, an event or a response. The operator's list of kinds
// is enforced, a name that is the board's own is refused, and an endpoint must be one the board may reach for
// the company (public, or private where the operator lists it), checked with an injected resolver. Values are
// set into a file secret store in a temporary directory. No network, no model.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseModelProviders } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { endpointRefusal } from "../src/providers/providers.js";
import { parsePrivateDestinations } from "../src/web/address.js";
import { boardEgress, companyEgress } from "../src/web/egress.js";
import { PUBLIC_TEST_ADDRESS, seedCompany, startTestBoard, testEgress, type TestBoard } from "./helpers.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-providers-"));
const BOARD_OWN = "board-own-anthropic-key-000000";
const SHARED = "shared-models-key-000000";
const SET = "set-from-settings-000000";
// Names under internal.test resolve to a private address, as an in-cluster server would; so does the Azure
// resource named private, as one behind a private endpoint does.
const resolve = async (host: string) =>
  host.endsWith(".internal.test") || host === "private.openai.azure.com"
    ? ["10.0.0.5"]
    : [PUBLIC_TEST_ADDRESS];
let board: TestBoard;
let narrow: TestBoard;

beforeAll(async () => {
  board = await startTestBoard(
    { secretStore: { kind: "file", dir }, sharedEnvNames: ["SHARED_MODELS_KEY"] },
    { env: { ANTHROPIC_API_KEY: BOARD_OWN, SHARED_MODELS_KEY: SHARED }, egressResolve: resolve },
  );
  narrow = await startTestBoard(
    {
      modelProviders: parseModelProviders("anthropic,openai_compatible"),
      privateDestinations: parsePrivateDestinations("10.0.0.0/8"),
    },
    { egressResolve: resolve },
  );
});
afterAll(async () => {
  await board.destroy();
  await narrow.destroy();
  rmSync(dir, { recursive: true, force: true });
});

type Ev = { type: string; subject: { kind: string; id: string } | null; payload: Record<string, unknown> };
const providerEvents = async (api: { get(url: string): Promise<{ body: any }> }, base: string) =>
  ((await api.get(`${base}/events?limit=50`)).body as Ev[]).filter((e) =>
    e.type.startsWith("model_provider."),
  );

describe("model providers", () => {
  it("adds, changes, archives and removes a provider, one event each, names only", async () => {
    const { api, base } = await seedCompany(board, "mp1@example.com");
    const empty = await api.get(`${base}/model-providers`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      offered: {
        kinds: ["anthropic", "openai", "azure_openai", "bedrock", "openai_compatible"],
        board: true,
      },
      providers: [],
    });

    const created = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "acme",
      label: "Acme Anthropic",
      credentials: { apiKey: "MODELS_ACME_KEY" },
      models: [{ id: "claude-opus-5.5", family: "claude" }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "acme",
      kind: "anthropic",
      endpoint: null,
      region: null,
      credentials: { apiKey: "MODELS_ACME_KEY" },
      credentialStates: { apiKey: { state: "missing" } },
      models: [{ id: "claude-opus-5-5", family: "claude", source: "typed" }],
      enabled: true,
      offered: true,
      archivedAt: null,
      createdBy: { kind: "user" },
    });
    const id = created.body.id as string;
    // What the board answers is not a body it takes: its fields are the board's to set.
    expect((await api.post(`${base}/model-providers`, created.body)).status).toBe(400);
    expect(
      (
        await api.post(`${base}/model-providers`, {
          kind: "openai",
          name: "acme",
          label: "Same name",
          credentials: { apiKey: "MODELS_OTHER_KEY" },
        })
      ).status,
    ).toBe(409);

    // The value is set once, write-only; the provider then says when and by whom, never what.
    expect((await api.put(`${base}/secrets/MODELS_ACME_KEY`, { value: SET })).status).toBe(200);
    const one = await api.get(`${base}/model-providers/${id}`);
    expect(one.body.credentialStates.apiKey).toMatchObject({ state: "set", setBy: { kind: "user" } });
    expect(typeof one.body.credentialStates.apiKey.setAt).toBe("string");

    const changed = await api.patch(`${base}/model-providers/${id}`, {
      label: "Acme Anthropic (prod)",
      models: [
        { id: "claude-opus-5-5", family: "claude", label: "Opus" },
        { id: "claude-sonnet-5-5", family: "claude" },
      ],
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ label: "Acme Anthropic (prod)", models: [{ label: "Opus" }, {}] });
    const archived = await api.patch(`${base}/model-providers/${id}`, { archived: true, enabled: false });
    expect(archived.body).toMatchObject({ enabled: false });
    expect(typeof archived.body.archivedAt).toBe("string");
    const restored = await api.patch(`${base}/model-providers/${id}`, { archived: false });
    expect(restored.body.archivedAt).toBeNull();

    expect((await api.del(`${base}/model-providers/${id}`)).status).toBe(200);
    expect((await api.get(`${base}/model-providers/${id}`)).status).toBe(404);
    expect((await api.del(`${base}/model-providers/${id}`)).status).toBe(404);

    const events = (await providerEvents(api, base)).reverse();
    expect(events.map((e) => e.type)).toEqual([
      "model_provider.created",
      "model_provider.updated",
      "model_provider.archived",
      "model_provider.updated",
      "model_provider.deleted",
    ]);
    expect(events.every((e) => e.subject?.kind === "model_provider" && e.subject.id === id)).toBe(true);
    expect(events[0]!.payload).toMatchObject({ name: "acme", kind: "anthropic", models: 1 });
    expect(events[1]!.payload.changes).toEqual(["label", "models"]);
    expect(events[2]!.payload).toMatchObject({ changes: ["enabled", "archived"], archived: true });
    expect(events[3]!.payload).toMatchObject({ changes: ["archived"], archived: false });
    expect(events[4]!.payload).toEqual({ name: "acme", kind: "anthropic" });
    // No value anywhere: not the company's, not the board's.
    const everything = JSON.stringify([events, created.body, one.body, changed.body]);
    for (const value of [SET, BOARD_OWN, SHARED]) expect(everything).not.toContain(value);
  });

  it("takes every kind with its own fields, and keeps the kind and name as they are", async () => {
    const { api, base } = await seedCompany(board, "mp2@example.com");
    const azure = await api.post(`${base}/model-providers`, {
      kind: "azure_openai",
      name: "acme-azure",
      label: "Acme Azure",
      endpoint: "https://Acme.openai.azure.com/openai/v1",
      credentials: { apiKey: "MODELS_ACME_AZURE_KEY" },
      models: [{ id: "gpt-x-prod", family: "openai" }],
    });
    expect(azure.status).toBe(201);
    expect(azure.body.endpoint).toBe("https://acme.openai.azure.com");
    const bedrock = await api.post(`${base}/model-providers`, {
      kind: "bedrock",
      name: "acme-bedrock",
      label: "Acme Bedrock",
      region: "eu-central-1",
      credentials: { bearerToken: "MODELS_ACME_BEDROCK_KEY" },
    });
    expect(bedrock.status).toBe(201);
    expect(bedrock.body).toMatchObject({ region: "eu-central-1", endpoint: null, authHeader: null });
    const compatible = await api.post(`${base}/model-providers`, {
      kind: "openai_compatible",
      name: "router",
      label: "Router",
      endpoint: "https://router.example.test/api/v1/",
      credentials: { apiKey: "SHARED_MODELS_KEY" },
    });
    expect(compatible.status).toBe(201);
    // A key without a header named goes in authorization; a name the operator shares says so.
    expect(compatible.body).toMatchObject({
      endpoint: "https://router.example.test/api/v1",
      authHeader: "authorization",
      credentialStates: { apiKey: { state: "shared" } },
    });

    // Fields another kind takes are refused, before and after.
    expect(
      (
        await api.post(`${base}/model-providers`, {
          kind: "openai",
          name: "o",
          label: "O",
          region: "us-east-1",
          credentials: { apiKey: "MODELS_O_KEY" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.patch(`${base}/model-providers/${bedrock.body.id}`, { endpoint: "https://x.test" })).status,
    ).toBe(400);
    expect(
      (await api.patch(`${base}/model-providers/${bedrock.body.id}`, { region: "nowhere" })).status,
    ).toBe(400);
    expect(
      (await api.patch(`${base}/model-providers/${bedrock.body.id}`, { credentials: { apiKey: "K" } }))
        .status,
    ).toBe(400);
    expect((await api.patch(`${base}/model-providers/${azure.body.id}`, { kind: "openai" })).status).toBe(
      400,
    );

    // Taking a compatible server's key away takes its header too; a keyless server has none.
    const keyless = await api.patch(`${base}/model-providers/${compatible.body.id}`, { credentials: {} });
    expect(keyless.status).toBe(200);
    expect(keyless.body).toMatchObject({ credentials: {}, authHeader: null, credentialStates: {} });
    const header = await api.patch(`${base}/model-providers/${compatible.body.id}`, {
      credentials: { apiKey: "MODELS_ROUTER_KEY" },
      authHeader: "x-api-key",
    });
    expect(header.body.authHeader).toBe("x-api-key");

    const list = await api.get(`${base}/model-providers`);
    expect(list.body.providers.map((p: { name: string }) => p.name)).toEqual([
      "acme-azure",
      "acme-bedrock",
      "router",
    ]);
  });

  it("is managed by owners and admins only; everyone in the company reads it", async () => {
    const { api, base } = await seedCompany(board, "mp3@example.com");
    const body = {
      kind: "openai",
      name: "acme-openai",
      label: "Acme OpenAI",
      credentials: { apiKey: "MODELS_ACME_OPENAI_KEY" },
    };
    for (const [email, role] of [
      ["mp3-admin@example.com", "admin"],
      ["mp3-reviewer@example.com", "reviewer"],
      ["mp3-viewer@example.com", "viewer"],
    ] as const)
      expect((await api.post(`${base}/members`, { email, role })).status).toBe(201);
    const as = async (email: string) => board.api((await board.login(email)).token);
    const admin = await as("mp3-admin@example.com");
    const reviewer = await as("mp3-reviewer@example.com");
    const viewer = await as("mp3-viewer@example.com");
    const mates = (await api.get(`${base}/teammates`)).body as { id: string }[];
    const teammate = board.api((await api.post(`${base}/teammates/${mates[0]!.id}/tokens`, {})).body.token);

    for (const who of [reviewer, viewer, teammate]) {
      expect((await who.post(`${base}/model-providers`, body)).status).toBe(403);
      expect((await who.get(`${base}/model-providers`)).status).toBe(200);
    }
    const created = await admin.post(`${base}/model-providers`, body);
    expect(created.status).toBe(201);
    const url = `${base}/model-providers/${created.body.id}`;
    for (const who of [reviewer, viewer, teammate]) {
      expect((await who.patch(url, { enabled: false })).status).toBe(403);
      expect((await who.del(url)).status).toBe(403);
      expect((await who.get(url)).body.credentials).toEqual({ apiKey: "MODELS_ACME_OPENAI_KEY" });
    }
    // Another company's provider is not there at all.
    const other = await seedCompany(board, "mp3-other@example.com");
    expect((await other.api.get(`${other.base}/model-providers/${created.body.id}`)).status).toBe(404);
    expect(
      (await other.api.patch(`${other.base}/model-providers/${created.body.id}`, { enabled: false })).status,
    ).toBe(404);
    expect((await other.api.del(`${other.base}/model-providers/${created.body.id}`)).status).toBe(404);
    expect((await admin.get(url)).body.enabled).toBe(true);
    expect((await admin.del(url)).status).toBe(200);
  });

  it("refuses a value where a name goes, and never says it back", async () => {
    const { api, base } = await seedCompany(board, "mp4@example.com");
    const value = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const refused = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "raw",
      label: "Raw",
      credentials: { apiKey: value },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain(value);
    // Anywhere else in the body, the raw-secret guard refuses it.
    const inLabel = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "raw",
      label: value,
      credentials: { apiKey: "MODELS_RAW_KEY" },
    });
    expect(inLabel.status).toBe(422);
    expect(JSON.stringify(inLabel.body)).not.toContain(value);

    // A key shaped like a name: an Azure key is 32 hex characters, and an AWS key id is all capitals.
    for (const key of ["a3f9c2e1b4d5f60718293a4b5c6d7e8f", "AKIAABCDEFGHIJKLMNOP"]) {
      const named = await api.post(`${base}/model-providers`, {
        kind: "azure_openai",
        name: "az",
        label: "Az",
        endpoint: "https://az.openai.azure.com",
        credentials: { apiKey: key },
      });
      expect(named.status, key).toBe(400);
      expect(JSON.stringify(named.body)).not.toContain(key);
    }
    // Where a field's name goes, and in a server's address.
    const asField = await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "raw",
      label: "Raw",
      credentials: { apiKey: "MODELS_RAW_KEY", [value]: "MODELS_RAW_KEY" },
    });
    expect(asField.status).toBe(400);
    expect(JSON.stringify(asField.body)).not.toContain(value);
    const inPath = await api.post(`${base}/model-providers`, {
      kind: "openai_compatible",
      name: "raw",
      label: "Raw",
      endpoint: `https://llm.example.test/v1/${value}`,
    });
    expect(inPath.status).toBe(400);
    expect(JSON.stringify(inPath.body)).not.toContain(value);
    expect((await providerEvents(api, base)).length).toBe(0);
  });

  it("builds each change on the one before it, and a change that changes nothing says nothing", async () => {
    const { api, base } = await seedCompany(board, "mp8@example.com");
    const created = await api.post(`${base}/model-providers`, {
      kind: "openai",
      name: "o",
      label: "O",
      credentials: { apiKey: "MODELS_O_KEY" },
    });
    const url = `${base}/model-providers/${created.body.id}`;
    // Two people at once: neither change undoes the other, and each event says what its own change did.
    for (let round = 0; round < 5; round++) {
      const label = `O ${round}`;
      const models = [{ id: `gpt-${round}`, family: "openai" }];
      const [a, b] = await Promise.all([api.patch(url, { label }), api.patch(url, { models })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const now = (await api.get(url)).body;
      expect(now.label).toBe(label);
      expect(now.models.map((m: { id: string }) => m.id)).toEqual([`gpt-${round}`]);
    }
    const changes = (await providerEvents(api, base))
      .filter((e) => e.type === "model_provider.updated")
      .map((e) => e.payload.changes);
    expect(changes).toHaveLength(10);
    expect(
      changes.every((c) => JSON.stringify(c) === '["label"]' || JSON.stringify(c) === '["models"]'),
    ).toBe(true);
    // Nothing to change: the provider as it is, and no event.
    const before = (await providerEvents(api, base)).length;
    const same = await api.patch(url, { label: "O 4", enabled: true });
    expect(same.status).toBe(200);
    expect(same.body.label).toBe("O 4");
    expect((await api.patch(url, {})).status).toBe(200);
    expect((await providerEvents(api, base)).length).toBe(before);
  });

  it("refuses a name that is the board's own, unless the company set it or the operator shares it", async () => {
    const { api, base } = await seedCompany(board, "mp5@example.com");
    const body = {
      kind: "anthropic",
      name: "own",
      label: "Own",
      credentials: { apiKey: "ANTHROPIC_API_KEY" },
    };
    const refused = await api.post(`${base}/model-providers`, body);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("ANTHROPIC_API_KEY is the board's own");
    expect(JSON.stringify(refused.body)).not.toContain(BOARD_OWN);

    const ok = await api.post(`${base}/model-providers`, {
      ...body,
      credentials: { apiKey: "MODELS_OWN_KEY" },
    });
    expect(ok.status).toBe(201);
    // A change to the board's name is refused too.
    const url = `${base}/model-providers/${ok.body.id}`;
    expect((await api.patch(url, { credentials: { apiKey: "ANTHROPIC_API_KEY" } })).status).toBe(403);
    // Once the company sets that name for itself, it is the company's.
    expect((await api.put(`${base}/secrets/ANTHROPIC_API_KEY`, { value: SET })).status).toBe(200);
    const mine = await api.patch(url, { credentials: { apiKey: "ANTHROPIC_API_KEY" } });
    expect(mine.status).toBe(200);
    expect(mine.body.credentialStates.apiKey.state).toBe("set");
  });

  it("refuses an endpoint the board may not reach for the company, and takes it once the operator lists it", async () => {
    const { api, base } = await seedCompany(board, "mp6@example.com");
    const compatible = (endpoint: string, name = "local") => ({
      kind: "openai_compatible",
      name,
      label: "Local",
      endpoint,
    });
    const privateName = await api.post(
      `${base}/model-providers`,
      compatible("https://vllm.internal.test/v1"),
    );
    expect(privateName.status).toBe(422);
    // The kind of address, never the address itself.
    expect(privateName.body.error).toMatch(/^refused: vllm\.internal\.test resolves to a private address/);
    expect(privateName.body.error).not.toContain("10.0.0.5");
    expect((await api.post(`${base}/model-providers`, compatible("https://10.0.0.5/v1"))).status).toBe(422);
    expect(
      (await api.post(`${base}/model-providers`, compatible("http://llm.example.test/v1"))).body.error,
    ).toMatch(/plain http/);
    // An Azure private endpoint is a name that resolves privately: the same rule.
    const azure = (resource: string) => ({
      kind: "azure_openai",
      name: resource,
      label: "Az",
      endpoint: `https://${resource}.openai.azure.com`,
      credentials: { apiKey: "MODELS_AZ_KEY" },
    });
    expect((await api.post(`${base}/model-providers`, azure("private"))).status).toBe(422);
    expect((await api.post(`${base}/model-providers`, azure("acme"))).status).toBe(201);
    const ok = await api.post(`${base}/model-providers`, compatible("https://llm.example.test/v1"));
    expect(ok.status).toBe(201);
    expect(
      (
        await api.patch(`${base}/model-providers/${ok.body.id}`, {
          endpoint: "https://vllm.internal.test/v1",
        })
      ).status,
    ).toBe(422);
    expect((await providerEvents(api, base)).length).toBe(2);

    // On a board whose operator lists 10.0.0.0/8, the same server is reachable, over plain http too.
    const n = await seedCompany(narrow, "mp6-narrow@example.com");
    const listed = await n.api.post(
      `${n.base}/model-providers`,
      compatible("http://vllm.internal.test:8000/v1"),
    );
    expect(listed.status).toBe(201);
    expect(listed.body.endpoint).toBe("http://vllm.internal.test:8000/v1");
  });

  it("checks endpoints against the company's own private destinations, and no other company's", async () => {
    const mine = "6f9c1a4e-2b7d-4c3a-9e1f-0a1b2c3d4e5f";
    const theirs = "0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
    const egress = testEgress(async () => new Response(null), {
      resolve,
      allow: `${mine}=vllm.internal.test`,
    });
    expect(await endpointRefusal(companyEgress(egress, mine), "http://vllm.internal.test/v1")).toBeNull();
    expect(await endpointRefusal(companyEgress(egress, theirs), "https://vllm.internal.test/v1")).toMatch(
      /^refused: vllm\.internal\.test resolves to a private address/,
    );
    // Never narrowed, the list ignores every company's own entries.
    expect(await endpointRefusal(egress, "https://vllm.internal.test/v1")).not.toBeNull();
    // The board's own egress, as a running board narrows it: the same answers.
    const own = boardEgress(parsePrivateDestinations(`${mine}=vllm.internal.test`), resolve);
    expect(await endpointRefusal(companyEgress(own, mine), "http://vllm.internal.test/v1")).toBeNull();
    expect(await endpointRefusal(companyEgress(own, theirs), "https://vllm.internal.test/v1")).not.toBeNull();
  });

  it("refuses an endpoint whose name does not answer in time, instead of holding the write", async () => {
    vi.useFakeTimers();
    try {
      const silent = testEgress(async () => new Response(null), { resolve: () => new Promise(() => {}) });
      const refusal = endpointRefusal(silent, "https://slow.example.test/v1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await refusal).toBe("slow.example.test does not resolve (ETIMEOUT)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers only the kinds the operator lists, and says whether the board lends its own models", async () => {
    const { api, base } = await seedCompany(narrow, "mp7@example.com");
    expect((await api.get(`${base}/model-providers`)).body.offered).toEqual({
      kinds: ["anthropic", "openai_compatible"],
      board: false,
    });
    const refused = await api.post(`${base}/model-providers`, {
      kind: "bedrock",
      name: "b",
      label: "B",
      region: "us-east-1",
      credentials: { bearerToken: "MODELS_B_KEY" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(
      "this board's operator does not offer Amazon Bedrock providers (ROSTERDOCK_MODEL_PROVIDERS)",
    );

    // A provider of a kind the operator has since stopped offering is kept, and says so.
    const owner = (
      await narrow.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", ["mp7@example.com"])
    ).rows[0]!.id;
    await narrow.db.query(
      `INSERT INTO model_providers (company_id, name, label, kind, region, credentials, created_by_kind, created_by_id)
       VALUES ($1, 'old', 'Old Bedrock', 'bedrock', 'us-east-1', '{"bearerToken": "MODELS_OLD_KEY"}', 'user', $2)`,
      [base.split("/").pop(), owner],
    );
    const kept = (await api.get(`${base}/model-providers`)).body.providers;
    expect(kept).toMatchObject([{ name: "old", kind: "bedrock", offered: false }]);
    // Changing it is not using it: it can still be switched off, archived or removed.
    expect((await api.patch(`${base}/model-providers/${kept[0].id}`, { enabled: false })).status).toBe(200);
    expect((await api.del(`${base}/model-providers/${kept[0].id}`)).status).toBe(200);
  });

  it("reads ROSTERDOCK_MODEL_PROVIDERS at start, and will not start on an entry it does not know", () => {
    const env = { DATABASE_URL: "postgres://x" };
    expect(loadConfig(env).modelProviders).toEqual(parseModelProviders(undefined));
    expect(loadConfig({ ...env, ROSTERDOCK_MODEL_PROVIDERS: "board" }).modelProviders).toEqual({
      kinds: [],
      board: true,
    });
    expect(() => loadConfig({ ...env, ROSTERDOCK_MODEL_PROVIDERS: "anthropic,vertex" })).toThrow(
      /ROSTERDOCK_MODEL_PROVIDERS: vertex is not one of/,
    );
  });
});
