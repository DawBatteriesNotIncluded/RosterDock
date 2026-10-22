// Needs-you notifications: a proposed write, an amber goal, a pull request to
// merge reach a webhook as one sentence each; the target is the board's own URL
// or a per-company env var NAME resolved at send time; nothing about the URL
// lands on the board. The webhook is a fake fetch that records what it got.
import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import type { EventRecord } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposeApproval } from "../src/approvals/service.js";
import { emailFor, needsYouText, notifySettings, sendNeedsYou, startNotifier } from "../src/notify/notify.js";
import { parseSmtpUrl, sendMail } from "../src/notify/smtp.js";
import { parsePrivateDestinations } from "../src/web/address.js";
import { SMTP_CERT, startFakeSmtp, type FakeSmtp } from "./smtp-fake.js";
import {
  addProject,
  addTeammate,
  PUBLIC_TEST_ADDRESS,
  seedCompany,
  startTestBoard,
  workerClaim,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
const posts: { url: string; body: Record<string, unknown> }[] = [];
let answer = 200;
const webhook: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  return new Response(answer === 200 ? "ok" : "no", { status: answer });
}) as typeof fetch;
const env: NodeJS.ProcessEnv = {
  GTM_SLACK_WEBHOOK: "https://hooks.slack.test/services/T000/B000/secret-token-000",
};

// Three fake SMTP servers on localhost: in the clear, in the clear with STARTTLS, and TLS from the start. A
// company's SMTP server is a destination it chose, so the board reaches them because the operator allows
// loopback here (ROSTERDOCK_PRIVATE_DESTINATIONS), as a dev board does.
let plain: FakeSmtp;
let upgrade: FakeSmtp;
let tlsServer: FakeSmtp;

beforeAll(async () => {
  [plain, upgrade, tlsServer] = await Promise.all([
    startFakeSmtp({ user: "owner", pass: "pw" }),
    startFakeSmtp({ starttls: true, user: "owner", pass: "pw" }),
    startFakeSmtp({ tls: true, user: "owner", pass: "pw", reject: ["nobody@example.test"] }),
  ]);
  board = await startTestBoard(
    {
      notifyWebhookUrl: "https://hooks.example.test/board-default",
      sharedEnvNames: ["GTM_SLACK_WEBHOOK", "GTM_SMTP_URL", "GTM_SMTP_STARTTLS", "GTM_SMTPS"],
      privateDestinations: parsePrivateDestinations("127.0.0.1,localhost"),
    },
    {
      notifyFetch: webhook,
      env,
      smtp: { tls: { ca: SMTP_CERT } },
      egressResolve: async (host) => (host === "localhost" ? ["127.0.0.1"] : [PUBLIC_TEST_ADDRESS]),
    },
  );
});
afterAll(async () => {
  await board.destroy();
  await Promise.all([plain.close(), upgrade.close(), tlsServer.close()]);
});

/** The Subject header of a captured message, decoded when it is an encoded word. */
function subjectOf(message: string | null): string {
  const raw = /^Subject: (.*)$/m.exec(message ?? "")?.[1] ?? "";
  const word = /^=\?UTF-8\?B\?(.*)\?=$/.exec(raw);
  return word ? Buffer.from(word[1]!, "base64").toString("utf8") : raw;
}

async function proposed(api: ReturnType<TestBoard["api"]>, base: string, companyId: string) {
  const cody = await addTeammate(api, base, "Cody");
  const project = await addProject(api, base);
  const task = (
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Warm accounts list",
      assignee: { kind: "teammate", id: cody.id },
    })
  ).body;
  const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
  await workerClaim(board, run.id);
  return proposeApproval(board.db, companyId, {
    taskId: task.id,
    runId: run.id,
    teammateId: cody.id,
    connection: "hubspot",
    tool: "create_list",
    title: "Create the HubSpot list Q3 warm accounts",
    why: "The summary needs it.",
    payload: { name: "Q3 warm accounts" },
  });
}

describe("needs-you notifications", () => {
  it("pushes a proposed write to the board's webhook as one sentence and records that it went", async () => {
    const { api, base, companyId } = await seedCompany(board, "nt1@example.com");
    posts.length = 0;
    await proposed(api, base, companyId);
    // The bus delivers the event to the notifier; wait for the push to land.
    for (let i = 0; i < 50 && posts.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://hooks.example.test/board-default");
    expect(posts[0]!.body.text).toBe(
      "GTM Studio · Cody asks approval to create the HubSpot list Q3 warm accounts (hubspot · create_list) for #1. Decide it in Approvals.",
    );
    expect(posts[0]!.body.type).toBe("approval.proposed");
    for (let i = 0; i < 50; i++) {
      const events = (await api.get(`${base}/events?limit=20`)).body as { type: string; payload: any }[];
      const sent = events.find((e) => e.type === "notify.sent");
      if (sent) {
        expect(sent.payload).toMatchObject({
          type: "approval.proposed",
          target: "ROSTERDOCK_NOTIFY_WEBHOOK_URL",
        });
        expect(JSON.stringify(events)).not.toContain("hooks.example.test");
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Only needs-you events go: the run start and the task move stayed on the board.
    expect(posts).toHaveLength(1);
  });

  it("one message per event whatever the number of replicas: a second notifier on the same database sees the claim and stands down", async () => {
    const { api, base, companyId } = await seedCompany(board, "nt4@example.com");
    // A second replica: its own notifier on the same database, with its own webhook recorder.
    const other: Record<string, unknown>[] = [];
    const otherFetch: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      other.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const replica = {
      db: board.db,
      fetch: otherFetch,
      defaultWebhookUrl: "https://hooks.example.test/replica-2",
      log: { warn: () => {} },
    };
    const stop = startNotifier(replica, board.bus);
    posts.length = 0;
    try {
      await proposed(api, base, companyId);
      for (let i = 0; i < 50 && posts.length + other.length === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      // Let the one that lost the claim finish too.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      stop();
    }
    expect(posts.length + other.length).toBe(1);
    const claims = await board.db.query<{ seq: string }>(
      "SELECT seq FROM notify_claims WHERE company_id = $1",
      [companyId],
    );
    expect(claims.rowCount).toBe(1);
    // A replica that comes to the event later (a restart, a re-delivery) sees the claim as well.
    let events: EventRecord[] = [];
    for (let i = 0; i < 50 && !events.some((e) => e.type === "notify.sent"); i++) {
      events = (await api.get(`${base}/events?limit=20`)).body as EventRecord[];
      if (!events.some((e) => e.type === "notify.sent")) await new Promise((r) => setTimeout(r, 50));
    }
    const ev = events.find((e) => e.type === "approval.proposed")!;
    expect(Number(claims.rows[0]!.seq)).toBe(ev.seq);
    expect(await sendNeedsYou(replica, ev)).toMatchObject({
      sent: false,
      error: "another replica is sending it",
    });
    expect(posts.length + other.length).toBe(1);
    // The record of what went is still the event stream: one notify.sent for the one message.
    const sent = events.filter((e) => e.type === "notify.sent");
    expect(sent).toHaveLength(1);
  });

  it("a company names its own webhook by env var NAME; a name that is not set means no push and a warning, never a guess", async () => {
    const { api, base, companyId } = await seedCompany(board, "nt2@example.com");
    expect(
      (await api.patch(base, { settings: { notify: { webhookEnvName: "GTM_SLACK_WEBHOOK" } } })).status,
    ).toBe(200);
    // The URL itself is refused where a name belongs.
    expect(notifySettings({ notify: { webhookEnvName: "https://hooks.slack.test/x" } })).toEqual({
      webhookEnvName: null,
    });
    posts.length = 0;
    const test = await api.post(`${base}/notify/test`, {});
    expect(test.status).toBe(200);
    expect(test.body).toEqual({ sent: true, target: "GTM_SLACK_WEBHOOK", error: null });
    expect(posts[0]!.url).toContain("hooks.slack.test");
    expect(posts[0]!.body.text).toContain("Needs-you notifications reach you here");
    expect(JSON.stringify(test.body)).not.toContain("secret-token");

    await api.patch(base, { settings: { notify: { webhookEnvName: "NOT_SET_ANYWHERE" } } });
    const none = await api.post(`${base}/notify/test`, {});
    expect(none.body).toEqual({ sent: false, target: null, error: "no webhook or email is configured" });
    posts.length = 0;
    await proposed(api, base, companyId);
    await new Promise((r) => setTimeout(r, 300));
    expect(posts).toHaveLength(0);
  });

  it("a webhook that refuses is reported and nothing is recorded; sentences exist for every needs-you event", async () => {
    const { api, base } = await seedCompany(board, "nt3@example.com");
    answer = 500;
    const test = await api.post(`${base}/notify/test`, {});
    answer = 200;
    expect(test.body.sent).toBe(false);
    expect(test.body.error).toBe("the webhook answered HTTP 500");
    const ev = (type: string, payload: Record<string, unknown>) =>
      ({
        id: "e",
        companyId: "c",
        seq: 1,
        type,
        actor: null,
        subject: null,
        payload,
        createdAt: "2026-09-12T04:00:00.000Z",
      }) as never;
    expect(
      needsYouText(
        ev("goal.escalated", { title: "Digest", reason: "#3 failed 3 times", managerName: "Peter" }),
        "GTM",
      ),
    ).toBe("Peter needs you on Digest: #3 failed 3 times");
    expect(needsYouText(ev("pr.opened", { number: 4, prNumber: 12, repo: "acme/x" }), "GTM")).toContain(
      "merging needs you",
    );
    expect(
      needsYouText(
        ev("goal.questions", { title: "Xero", questions: ["a", "b"], managerName: "Peter" }),
        "GTM",
      ),
    ).toBe("Peter has 2 questions before planning Xero.");
    expect(needsYouText(ev("run.completed", {}), "GTM")).toBeNull();
    // Not a needs-you event: nothing is sent.
    expect(
      await sendNeedsYou(
        { db: board.db, defaultWebhookUrl: null, log: { warn: () => {} } },
        ev("run.completed", {}),
      ),
    ).toMatchObject({ sent: false });
  });
});

describe("needs-you by email", () => {
  it("gives up at the deadline in a TLS handshake or after STARTTLS, and closes its side", async () => {
    // One server takes the connection and says nothing; the other agrees to STARTTLS, then says nothing.
    const held: Socket[] = [];
    const take = (s: Socket) => {
      held.push(s);
      // Read and drop what arrives, so the close is seen.
      s.on("error", () => {}).resume();
    };
    const silent = createServer(take);
    const stalls = createServer((s) => {
      take(s);
      s.write("220 stall ESMTP\r\n");
      s.on("data", (d: Buffer) => {
        const line = d.toString("latin1");
        if (line.startsWith("EHLO")) s.write("250-stall\r\n250 STARTTLS\r\n");
        else if (line.startsWith("STARTTLS")) s.write("220 go ahead\r\n");
      });
    });
    await Promise.all([silent, stalls].map((srv) => new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))));
    const port = (srv: typeof silent) => (srv.address() as AddressInfo).port;
    const message = { from: "board@example.test", to: ["ops@example.test"], subject: "s", text: "t" };
    const opts = { timeoutMs: 1000, tls: { ca: SMTP_CERT, servername: "localhost" } };
    try {
      const started = Date.now();
      const outcomes = await Promise.allSettled([
        sendMail(`smtps://owner:pw@127.0.0.1:${port(silent)}/`, message, opts),
        sendMail(`smtp://owner:pw@127.0.0.1:${port(stalls)}/`, message, opts),
      ]);
      expect(outcomes.map((o) => (o.status === "rejected" ? (o.reason as Error).message : "sent"))).toEqual([
        "the server gave no answer in 1s",
        "the server gave no answer in 1s",
      ]);
      expect(Date.now() - started).toBeLessThan(3000);
      // The board closed its side of both.
      await Promise.all(held.map((s) => (s.readableEnded || s.destroyed ? null : once(s, "close"))));
    } finally {
      for (const s of held) s.destroy();
      await Promise.all([silent, stalls].map((srv) => new Promise((r) => srv.close(r))));
    }
  });

  it("sends the sentence through the company's SMTP URL by NAME, alongside the webhook, and records each channel", async () => {
    const { api, base, companyId } = await seedCompany(board, "nt4@example.com");
    env.GTM_SMTP_URL = `smtp://owner:pw@127.0.0.1:${plain.port}/?plainAuth=1`;
    const email = {
      smtpUrlEnvName: "GTM_SMTP_URL",
      to: ["ops@example.test"],
      from: "rosterdock@example.test",
    };
    expect((await api.patch(base, { settings: { notify: { email } } })).status).toBe(200);
    // A URL where a NAME belongs, or a recipient that is not an address, is refused on the way in.
    expect(
      (await api.patch(base, { settings: { notify: { email: { ...email, smtpUrlEnvName: "smtp://x" } } } }))
        .status,
    ).toBe(400);
    expect(
      (await api.patch(base, { settings: { notify: { email: { ...email, to: ["ops"] } } } })).status,
    ).toBe(400);
    posts.length = 0;
    plain.sessions.length = 0;
    const test = await api.post(`${base}/notify/test`, {});
    expect(test.body).toEqual({
      sent: true,
      target: "ROSTERDOCK_NOTIFY_WEBHOOK_URL, GTM_SMTP_URL",
      error: null,
    });
    expect(posts).toHaveLength(1);
    const session = plain.sessions.at(-1)!;
    expect(session.authed).toBe("owner");
    expect(session.secure).toBe(false);
    expect(session.from).toBe("rosterdock@example.test");
    expect(session.to).toEqual(["ops@example.test"]);
    expect(subjectOf(session.message)).toBe("GTM Studio · a test from RosterDock");
    expect(session.message).toContain("Needs-you notifications reach you here.");
    expect(session.message).toContain("Content-Type: text/plain; charset=utf-8");
    // A proposed write goes by both channels; each is its own notify.sent with the channel.
    posts.length = 0;
    plain.sessions.length = 0;
    await proposed(api, base, companyId);
    for (let i = 0; i < 60 && !plain.sessions.some((s) => s.message); i++)
      await new Promise((r) => setTimeout(r, 50));
    const pushed = plain.sessions.find((s) => s.message)!;
    expect(subjectOf(pushed.message)).toBe("GTM Studio · needs you");
    expect(pushed.message).toContain("Cody asks approval to create the HubSpot list Q3 warm accounts");
    expect(pushed.message).toContain("(approval.proposed)");
    let recorded: { payload: any }[] = [];
    for (let i = 0; i < 60 && recorded.length < 2; i++) {
      const events = (await api.get(`${base}/events?limit=30`)).body as { type: string; payload: any }[];
      recorded = events.filter((e) => e.type === "notify.sent" && e.payload.type === "approval.proposed");
      if (recorded.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(recorded.map((e) => [e.payload.channel, e.payload.target]).sort()).toEqual([
      ["email", "GTM_SMTP_URL"],
      ["webhook", "ROSTERDOCK_NOTIFY_WEBHOOK_URL"],
    ]);
    // Credentials never go in the clear unless the URL allows it; the error names neither URL nor password.
    env.GTM_SMTP_URL = `smtp://owner:pw@127.0.0.1:${plain.port}/`;
    const refused = await api.post(`${base}/notify/test`, {});
    expect(refused.body.sent).toBe(true);
    expect(refused.body.target).toBe("ROSTERDOCK_NOTIFY_WEBHOOK_URL");
    expect(refused.body.error).toMatch(/credentials in the clear/);
    expect(JSON.stringify(refused.body)).not.toContain("owner:pw");
  });

  it("upgrades with STARTTLS when the server offers it, speaks TLS from the start for smtps://, and names what the server refused", async () => {
    const { api, base } = await seedCompany(board, "nt5@example.com");
    env.GTM_SMTP_STARTTLS = `smtp://owner:pw@localhost:${upgrade.port}/`;
    const notify = (smtpUrlEnvName: string, to: string[]) => ({
      webhookEnvName: "NOT_SET_ANYWHERE",
      email: { smtpUrlEnvName, to },
    });
    await api.patch(base, { settings: { notify: notify("GTM_SMTP_STARTTLS", ["ops@example.test"]) } });
    upgrade.sessions.length = 0;
    const viaStarttls = await api.post(`${base}/notify/test`, {});
    expect(viaStarttls.body).toEqual({ sent: true, target: "GTM_SMTP_STARTTLS", error: null });
    const up = upgrade.sessions.at(-1)!;
    expect(up.commands).toContain("STARTTLS");
    expect(up.secure).toBe(true);
    expect(up.authed).toBe("owner");
    expect(up.from).toBe("rosterdock@localhost");
    // TLS from the first byte; a recipient the server refuses fails the send and says which.
    env.GTM_SMTPS = `smtps://owner:pw@localhost:${tlsServer.port}/`;
    await api.patch(base, {
      settings: { notify: notify("GTM_SMTPS", ["ops@example.test", "nobody@example.test"]) },
    });
    const refused = await api.post(`${base}/notify/test`, {});
    expect(refused.body).toEqual({
      sent: false,
      target: "GTM_SMTPS",
      error: "email: RCPT TO nobody@example.test answered 550 No such user nobody@example.test",
    });
    await api.patch(base, { settings: { notify: notify("GTM_SMTPS", ["ops@example.test"]) } });
    tlsServer.sessions.length = 0;
    const secure = await api.post(`${base}/notify/test`, {});
    expect(secure.body).toEqual({ sent: true, target: "GTM_SMTPS", error: null });
    expect(tlsServer.sessions.at(-1)!).toMatchObject({
      secure: true,
      authed: "owner",
      to: ["ops@example.test"],
    });
    // A wrong password: the step and the server's answer, never the password.
    env.GTM_SMTPS = `smtps://owner:wrong-secret@localhost:${tlsServer.port}/`;
    const denied = await api.post(`${base}/notify/test`, {});
    expect(denied.body.sent).toBe(false);
    expect(denied.body.error).toBe("email: AUTH PLAIN answered 535 Authentication credentials invalid");
    expect(JSON.stringify(denied.body)).not.toContain("wrong-secret");
  });

  it("the board's own email target serves every company that names none; SMTP URLs parse with their defaults", async () => {
    const { companyId } = await seedCompany(board, "nt6@example.com");
    const target = await emailFor(
      {
        db: board.db,
        env,
        defaultWebhookUrl: null,
        defaultEmail: { smtpUrl: "smtp://relay.test", to: ["a@x.test"], from: "p@x.test" },
        log: { warn() {} },
      },
      companyId,
    );
    expect(target).toEqual({
      smtpUrl: "smtp://relay.test",
      to: ["a@x.test"],
      from: "p@x.test",
      source: "ROSTERDOCK_NOTIFY_SMTP_URL",
      operator: true,
    });
    expect(parseSmtpUrl("smtps://u:p%40ss@mail.test/")).toEqual({
      secure: true,
      host: "mail.test",
      port: 465,
      user: "u",
      pass: "p@ss",
      plainAuth: false,
    });
    expect(parseSmtpUrl("smtp://relay.test/?plainAuth=1")).toMatchObject({
      secure: false,
      port: 587,
      user: null,
      plainAuth: true,
    });
    expect(() => parseSmtpUrl("https://x")).toThrow(/smtp:\/\/ or smtps:\/\//);
    expect(
      notifySettings({
        notify: { email: { smtpUrlEnvName: "X", to: ["a@x.test"], from: "not-an-address" } },
      }),
    ).toEqual({
      webhookEnvName: null,
      email: { smtpUrlEnvName: "X", to: ["a@x.test"] },
    });
  });
});
