// Company secrets: a value set from Settings goes write-only into the secret
// store (files in a temporary directory here); the row, the list, the event
// and every response carry the name only; a connection naming that env var
// resolves it before a name the board shares; removing it falls back to the
// shared value, or to a refusal by name. The MCP server is the fake behind an
// injected fetch; no network.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyEnv, setCompanySecret, sharedEnv } from "../src/secrets/company.js";
import { fileSecretStore } from "../src/secrets/file.js";
import type { SecretStore } from "../src/secrets/store.js";
import { fakeMcp } from "./mcp-fake.js";
import { seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

const MCP_URL = "https://mcp.hubspot.test/mcp";
const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-company-secrets-"));
let board: TestBoard;
let bare: TestBoard;
const mcp = fakeMcp();
const FROM_ENV = "from-the-environment-000000";
const FROM_SETTINGS = "set-from-settings-000000";

beforeAll(async () => {
  board = await startTestBoard(
    { secretStore: { kind: "file", dir }, sharedEnvNames: ["HUBSPOT_MCP_TOKEN"] },
    { mcpFetch: mcp.fetch, env: { HUBSPOT_MCP_TOKEN: FROM_ENV } },
  );
  bare = await startTestBoard({}, { mcpFetch: mcp.fetch });
});
afterAll(async () => {
  await board.destroy();
  await bare.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const lastListBearer = () =>
  mcp.requests.filter((r) => r.body?.method === "tools/list").at(-1)?.headers.authorization ?? null;

describe("company secrets", () => {
  it("sets a value: the store keeps it, the row and the event keep the name, no response carries it", async () => {
    const { api, base } = await seedCompany(board, "cs1@example.com");
    const companyId = base.split("/").pop()!;
    const set = await api.put(`${base}/secrets/HUBSPOT_MCP_TOKEN`, { value: FROM_SETTINGS });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ name: "HUBSPOT_MCP_TOKEN", updatedBy: { kind: "user" } });
    expect(JSON.stringify(set.body)).not.toContain(FROM_SETTINGS);

    const list = await api.get(`${base}/secrets`);
    expect(list.status).toBe(200);
    expect(list.body.map((s: { name: string }) => s.name)).toEqual(["HUBSPOT_MCP_TOKEN"]);
    expect(JSON.stringify(list.body)).not.toContain(FROM_SETTINGS);

    const file = `rosterdock-company-${companyId}.json`;
    expect(readdirSync(dir)).toContain(file);
    expect(JSON.parse(readFileSync(path.join(dir, file), "utf8"))).toEqual({
      HUBSPOT_MCP_TOKEN: FROM_SETTINGS,
    });

    const events = (await api.get(`${base}/events?limit=10`)).body as { type: string; payload: any }[];
    const ev = events.find((e) => e.type === "secret.set");
    expect(ev?.payload).toEqual({ name: "HUBSPOT_MCP_TOKEN", replaced: false });
    expect(JSON.stringify(events)).not.toContain(FROM_SETTINGS);

    // Replacing says so; the store holds the new value only.
    const again = await api.put(`${base}/secrets/HUBSPOT_MCP_TOKEN`, { value: `${FROM_SETTINGS}-2` });
    expect(again.status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(dir, file), "utf8"))).toEqual({
      HUBSPOT_MCP_TOKEN: `${FROM_SETTINGS}-2`,
    });
    const replaced = (await api.get(`${base}/events?limit=10`)).body.find(
      (e: { type: string; payload: any }) => e.type === "secret.set" && e.payload.replaced,
    );
    expect(replaced).toBeTruthy();
  });

  it("a connection resolves the name from the store before the environment, and falls back when it goes", async () => {
    const { api, base } = await seedCompany(board, "cs2@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "hubspot",
      catalogId: "hubspot",
      url: MCP_URL,
      authEnvName: "HUBSPOT_MCP_TOKEN",
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // Nothing set for the company: the board's environment answers.
    let checked = await api.post(`${base}/connections/${id}/check`, {});
    expect(checked.status).toBe(200);
    expect(checked.body.lastCheck.ok).toBe(true);
    expect(lastListBearer()).toBe(`Bearer ${FROM_ENV}`);

    // Set in Settings: the company's value wins.
    expect((await api.put(`${base}/secrets/HUBSPOT_MCP_TOKEN`, { value: FROM_SETTINGS })).status).toBe(200);
    checked = await api.post(`${base}/connections/${id}/check`, {});
    expect(checked.body.lastCheck.ok).toBe(true);
    expect(lastListBearer()).toBe(`Bearer ${FROM_SETTINGS}`);

    // Removed: back to the environment.
    expect((await api.del(`${base}/secrets/HUBSPOT_MCP_TOKEN`)).status).toBe(200);
    checked = await api.post(`${base}/connections/${id}/check`, {});
    expect(checked.body.lastCheck.ok).toBe(true);
    expect(lastListBearer()).toBe(`Bearer ${FROM_ENV}`);
    expect((await api.get(`${base}/secrets`)).body).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.includes(base.split("/").pop()!))).toEqual([]);

    // A name the environment does not have: set, it works; removed, the refusal names it and nothing is called.
    const other = await api.post(`${base}/connections`, {
      name: "other",
      url: "https://other.test/mcp",
      authEnvName: "OTHER_MCP_TOKEN",
    });
    expect(other.status).toBe(201);
    expect((await api.put(`${base}/secrets/OTHER_MCP_TOKEN`, { value: "other-value-000000" })).status).toBe(
      200,
    );
    checked = await api.post(`${base}/connections/${other.body.id}/check`, {});
    expect(checked.body.lastCheck.ok).toBe(true);
    expect(lastListBearer()).toBe("Bearer other-value-000000");
    const before = mcp.requests.length;
    expect((await api.del(`${base}/secrets/OTHER_MCP_TOKEN`)).status).toBe(200);
    checked = await api.post(`${base}/connections/${other.body.id}/check`, {});
    expect(checked.body.lastCheck.ok).toBe(false);
    expect(checked.body.lastCheck.error).toContain("OTHER_MCP_TOKEN is not set");
    expect(checked.body.lastCheck.error).not.toContain("other-value");
    expect(mcp.requests.length).toBe(before);
  });

  it("is per company: another company's connection never sees the value", async () => {
    const a = await seedCompany(board, "cs3a@example.com");
    const b = await seedCompany(board, "cs3b@example.com");
    expect((await a.api.put(`${a.base}/secrets/ONLY_A_TOKEN`, { value: "a-only-000000" })).status).toBe(200);
    expect((await b.api.get(`${b.base}/secrets`)).body).toEqual([]);
    const conn = await b.api.post(`${b.base}/connections`, {
      name: "shared",
      url: "https://shared.test/mcp",
      authEnvName: "ONLY_A_TOKEN",
    });
    const checked = await b.api.post(`${b.base}/connections/${conn.body.id}/check`, {});
    expect(checked.body.lastCheck.ok).toBe(false);
    expect(checked.body.lastCheck.error).toContain("ONLY_A_TOKEN is not set");
  });

  it("refuses what it must: a bad name, an empty value, an unknown name, and a board without a store", async () => {
    const { api, base } = await seedCompany(board, "cs4@example.com");
    expect((await api.put(`${base}/secrets/not-a-name`, { value: "x-000000" })).status).toBe(400);
    // A key given as a new name (a 32-character Azure key starts with a letter as often as not) is not kept
    // as one; a long name of letters alone is a name.
    const keyAsName = "a3f9c2e1b4d5f60718293a4b5c6d7e8f";
    const asName = await api.put(`${base}/secrets/${keyAsName}`, { value: "x-000000" });
    expect(asName.status).toBe(400);
    expect(JSON.stringify(asName.body)).not.toContain(keyAsName);
    expect((await api.get(`${base}/secrets`)).body).toEqual([]);
    expect((await api.put(`${base}/secrets/githubPersonalAccessToken`, { value: "x-000000" })).status).toBe(
      200,
    );
    expect((await api.del(`${base}/secrets/githubPersonalAccessToken`)).status).toBe(200);
    expect((await api.put(`${base}/secrets/A_TOKEN`, { value: "" })).status).toBe(400);
    expect((await api.put(`${base}/secrets/A_TOKEN`, {})).status).toBe(400);
    expect((await api.del(`${base}/secrets/A_TOKEN`)).status).toBe(404);

    const none = await seedCompany(bare, "cs4-bare@example.com");
    const refused = await none.api.put(`${none.base}/secrets/A_TOKEN`, { value: "x-000000" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("secret store");
    expect((await none.api.get(`${none.base}/secrets`)).body).toEqual([]);
  });

  it("a name set before this rule can still be replaced and removed; a new one set only if new stays unset", async () => {
    const { api, base, owner } = await seedCompany(board, "cs6@example.com");
    const companyId = base.split("/").pop()!;
    // Set before names that look like keys were refused: it can be rotated and, above all, removed.
    const old = "a3f9c2e1b4d5f60718293a4b5c6d7e8f";
    await board.db.query(
      "INSERT INTO company_secrets (company_id, name, updated_by_kind, updated_by_id) SELECT $1, $2, 'user', user_id FROM memberships WHERE company_id = $1",
      [companyId, old],
    );
    expect((await api.put(`${base}/secrets/${old}`, { value: "rotated-000000" })).status).toBe(200);
    expect((await api.del(`${base}/secrets/${old}`)).status).toBe(200);
    expect((await api.get(`${base}/secrets`)).body).toEqual([]);

    // If-None-Match: * sets a new name, and never one already set: the value stays as it was.
    const put = (value: string) =>
      board.app.inject({
        method: "PUT",
        url: `${base}/secrets/MODELS_ACME_KEY`,
        headers: { authorization: `Bearer ${owner.token}`, "if-none-match": "*" },
        payload: { value },
      });
    expect((await put("first-value-000000")).statusCode).toBe(200);
    const again = await put("second-value-000000");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe(
      "MODELS_ACME_KEY is already set for this company; use it as it is, or give the key another name",
    );
    expect(JSON.parse(readFileSync(path.join(dir, `rosterdock-company-${companyId}.json`), "utf8"))).toEqual({
      MODELS_ACME_KEY: "first-value-000000",
    });
    const events = (await api.get(`${base}/events?limit=10`)).body as { type: string }[];
    expect(events.filter((e) => e.type === "secret.set")).toHaveLength(2);

    // Set only if new, a name the operator shares is refused: the company's value would hide the shared one
    // from every connection. Set as a person means to, from Connections, it stays the company's to set.
    const shared = await board.app.inject({
      method: "PUT",
      url: `${base}/secrets/HUBSPOT_MCP_TOKEN`,
      headers: { authorization: `Bearer ${owner.token}`, "if-none-match": "*" },
      payload: { value: "x-000000" },
    });
    expect(shared.statusCode).toBe(409);
    expect(shared.json().error).toContain("a name the operator shares");

    // Two keys set at once, through a store slow to read, as a cluster's can be: the store keeps both, as
    // the rows and the events say. Without the company's lock the second write would drop the first key.
    const files = fileSecretStore(dir);
    const slow: SecretStore = {
      kind: "file",
      get: async (n) => {
        const data = await files.get(n);
        await new Promise((r) => setTimeout(r, 50));
        return data;
      },
      put: (n, d) => files.put(n, d),
      delete: (n) => files.delete(n),
    };
    const actor = { kind: "user" as const, id: owner.userId };
    await Promise.all([
      setCompanySecret(board.db, slow, companyId, actor, "MODELS_ONE_KEY", "one-000000"),
      setCompanySecret(board.db, slow, companyId, actor, "MODELS_TWO_KEY", "two-000000"),
    ]);
    expect(
      JSON.parse(readFileSync(path.join(dir, `rosterdock-company-${companyId}.json`), "utf8")),
    ).toMatchObject({ MODELS_ONE_KEY: "one-000000", MODELS_TWO_KEY: "two-000000" });
  });

  it("companyEnv: the store entry over the shared names, empty values ignored, the shared names alone without a store", async () => {
    const store = fileSecretStore(path.join(dir, "unit"));
    const board = { A: "base-a", B: "base-b", DATABASE_URL: "postgres://board:pw@db/rosterdock" };
    // Only the names the operator shares are keys; the rest of the board's environment is not there.
    const base = sharedEnv(board, ["A", "B", "UNSET"]);
    expect(Object.keys(base)).not.toContain("DATABASE_URL");
    expect(await companyEnv(base, null, "c1")).toEqual({ A: "base-a", B: "base-b" });
    expect(await companyEnv(base, store, "c1")).toEqual({ A: "base-a", B: "base-b" });
    await store.put("rosterdock-company-c1", { A: "store-a", C: "store-c", D: "" });
    expect(await companyEnv(base, store, "c1")).toEqual({ A: "store-a", B: "base-b", C: "store-c" });
    expect(board.A).toBe("base-a");
    // The view reads the board's value when it is used.
    board.B = "rotated-b";
    expect(await companyEnv(base, null, "c1")).toEqual({ A: "base-a", B: "rotated-b" });
  });
});
