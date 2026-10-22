// Needs-you notifications. The events that need a person (a proposed write, a
// goal that turned amber or asks questions, a pull request to merge, a failed
// send, a budget alert, one of Peter's drafts) are pushed to a webhook as one
// short sentence each, so the owner can come to the board from Slack or mail
// instead of watching it. Carried over from the v1 prototype without its file
// store: the event stream is the source and the dedupe key is the event seq.
//
// The target is a URL that may carry a token (Slack-style), so it is
// deployment config, never stored on the board: the board's own
// ROSTERDOCK_NOTIFY_WEBHOOK_URL, or per company an env var NAME in the company
// settings (settings.notify.webhookEnvName) the board resolves at send time,
// like a connection's: the company's secrets, then the names the operator
// shares (secrets/company.ts), never the rest of the board's environment.
// The URL is never logged and never appears in an event. Email is the same
// shape: an SMTP URL (credentials inside) by env var NAME, the recipients and
// the sender, per company in settings.notify.email or board-wide. A company's
// own webhook and SMTP server are destinations it chose, reached through the
// board's egress (web/egress.ts): a public address, or a private one the
// operator lists, and no redirect followed. The board's own are the operator's
// and are reached as they are.

import { type ActorRef, type EventRecord, type EventType } from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import type { EventBus } from "../events/bus.js";
import { mutate } from "../mutate.js";
import { companyEnv, notSetForCompany } from "../secrets/company.js";
import type { SecretStore } from "../secrets/store.js";
import { defaultEgress, egressFetch, egressSocket, type Egress } from "../web/egress.js";
import { sendMail, type SmtpOptions } from "./smtp.js";

export const NEEDS_YOU_EVENTS: readonly EventType[] = [
  "approval.proposed",
  "approval.failed",
  "goal.questions",
  "goal.escalated",
  "pr.opened",
  "pr.failed",
  "budget.alert",
  "draft.proposed",
  "teammate.drift",
];

export interface NotifyDeps {
  db: Db;
  /** What the board's own webhook (ROSTERDOCK_NOTIFY_WEBHOOK_URL) is posted with; injected in tests. Default: global fetch. */
  fetch?: typeof fetch;
  /**
   * How a company's own webhook and SMTP server are reached (web/egress.ts); tests inject its transport and
   * resolver. Default: the board's own, with nothing private allowed.
   */
  egress?: Egress;
  /** The names the board shares with every company (secrets/company.ts sharedEnv). Default: none. */
  env?: NodeJS.ProcessEnv;
  /** Where each company's own secrets live; they resolve before the shared names. */
  secrets?: SecretStore | null;
  /** The board's own target for every company, when set (ROSTERDOCK_NOTIFY_WEBHOOK_URL). */
  defaultWebhookUrl: string | null;
  /** The board's own email target for every company, when set. */
  defaultEmail?: { smtpUrl: string; to: string[]; from: string } | null;
  /** For the SMTP client: a private CA in tests; never the network's business otherwise. */
  smtp?: SmtpOptions;
  log: { warn(m: string): void };
  timeoutMs?: number;
}

export interface NotifySettings {
  /** Env var NAME holding this company's webhook URL. */
  webhookEnvName?: string | null;
  /** Email: env var NAME holding the SMTP URL, the recipients, the sender. */
  email?: { smtpUrlEnvName: string; to: string[]; from?: string } | null;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYSTEM_ACTOR: ActorRef = { kind: "user", id: "00000000-0000-4000-8000-000000000000" };

/** The company's notification settings, when they are well formed. */
export function notifySettings(settings: Record<string, unknown> | null | undefined): NotifySettings {
  const n = settings?.notify;
  if (!n || typeof n !== "object") return {};
  const name = (n as { webhookEnvName?: unknown }).webhookEnvName;
  const out: NotifySettings = {
    webhookEnvName: typeof name === "string" && ENV_NAME_RE.test(name) ? name : null,
  };
  const email = (n as { email?: unknown }).email;
  if (email && typeof email === "object") {
    const e = email as { smtpUrlEnvName?: unknown; to?: unknown; from?: unknown };
    const to = Array.isArray(e.to)
      ? e.to.filter((a): a is string => typeof a === "string" && a.includes("@"))
      : [];
    if (typeof e.smtpUrlEnvName === "string" && ENV_NAME_RE.test(e.smtpUrlEnvName) && to.length)
      out.email = {
        smtpUrlEnvName: e.smtpUrlEnvName,
        to,
        ...(typeof e.from === "string" && e.from.includes("@") ? { from: e.from } : {}),
      };
  }
  return out;
}

/** One sentence per event, in manager language. Null: not something a person must act on. */
export function needsYouText(ev: EventRecord, companyName: string): string | null {
  const p = ev.payload as Record<string, unknown>;
  const n = p.number !== undefined ? `#${p.number}` : "a task";
  const who = (p.teammateName as string | undefined) ?? (p.managerName as string | undefined) ?? "A teammate";
  switch (ev.type) {
    case "approval.proposed":
      return `${who} asks approval to ${lowerFirst(String(p.title ?? "write to a live system"))} (${p.connection} · ${p.tool}) for ${n}. Decide it in Approvals.`;
    case "approval.failed":
      return `The approved write on ${n} could not be sent: ${p.error ?? "unknown error"}.`;
    case "goal.questions": {
      const qs = (p.questions as string[] | undefined)?.length ?? 0;
      return `${who} has ${qs} question${qs === 1 ? "" : "s"} before planning ${p.title}.`;
    }
    case "goal.escalated":
      return `${who} needs you on ${p.title}: ${p.reason ?? ""}`;
    case "pr.opened":
      return `Pull request #${p.prNumber} opened for ${n} on ${p.repo}; merging needs you.`;
    case "pr.failed":
      return `The pull request for ${n} could not be opened: ${p.error ?? "unknown error"}.`;
    case "budget.alert":
      return `Budget alert: ${p.scopeKind} ${p.scopeName ?? ""} is at ${p.percent}% of its tokens.`;
    case "teammate.drift":
      return driftSentence(p);
    case "review.reassigned": {
      const r = p.reviewer as { kind: string; name: string | null } | null;
      return r?.kind === "user" ? `${n} ${p.title ?? ""} is ${r.name ?? "someone"}'s to review.` : null;
    }
    case "draft.proposed":
      return p.kind === "audit"
        ? `${who} audited ${companyName}: ${p.summary ?? ""}`
        : `${who} proposes ${((p.departments as { name: string }[] | undefined) ?? []).map((d) => d.name).join(", ") || "an org change"}; accept it on the Company page.`;
    default:
      return null;
  }
}

/** "Cody's runs cost 3.2× their usual (410k tokens against 128k on #12)." */
export function driftSentence(p: Record<string, unknown>): string {
  const who = String(p.teammateName ?? "A teammate");
  const n = p.number !== undefined && p.number !== null ? ` on #${p.number}` : "";
  const ratio = Number(p.ratio);
  const times = Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : "well above";
  const tokens = (v: unknown) => `${Math.round(Number(v) / 1000)}k tokens`;
  const minutes = (v: unknown) => `${Math.round(Number(v) / 60_000)} min`;
  const pct = (v: unknown) => `${Math.round(Number(v) * 100)}%`;
  switch (p.metric) {
    case "cost":
      return `${who}'s runs cost ${times} their usual (${tokens(p.value)} against ${tokens(p.baseline)}${n}).`;
    case "duration":
      return `${who}'s runs take ${times} their usual (${minutes(p.value)} against ${minutes(p.baseline)}${n}).`;
    case "rejection":
      return `${who}'s work is coming back: ${pct(p.value)} of recent reviews sent it back, against ${pct(p.baseline)} before${n}.`;
    default:
      return `${who} departed from their baseline.`;
  }
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

export interface NotifyTarget {
  url: string;
  /** Where the URL came from, by name only. */
  source: string;
  /** The board's own, the operator's: reached as it is. A company's goes through the egress. */
  operator: boolean;
}

/** Where the company's names resolve: its secrets over the names the board shares. */
function envFor(deps: NotifyDeps, companyId: string): Promise<NodeJS.ProcessEnv> {
  return companyEnv(deps.env ?? {}, deps.secrets, companyId);
}

/** The webhook for a company: its own env var NAME when set (and set for the company), else the board's. */
export async function webhookFor(deps: NotifyDeps, companyId: string): Promise<NotifyTarget | null> {
  const row = (
    await deps.db.query<{ name: string; settings: Record<string, unknown> }>(
      "SELECT name, settings FROM companies WHERE id = $1",
      [companyId],
    )
  ).rows[0];
  const settings = notifySettings(row?.settings);
  if (settings.webhookEnvName) {
    const url = (await envFor(deps, companyId))[settings.webhookEnvName]?.trim();
    if (url) return { url, source: settings.webhookEnvName, operator: false };
    deps.log.warn(
      `${notSetForCompany(settings.webhookEnvName)}; ${row?.name ?? companyId} gets no notifications`,
    );
    return null;
  }
  return deps.defaultWebhookUrl
    ? { url: deps.defaultWebhookUrl, source: "ROSTERDOCK_NOTIFY_WEBHOOK_URL", operator: true }
    : null;
}

export interface EmailTarget {
  smtpUrl: string;
  to: string[];
  from: string;
  /** Where the URL came from, by name only. */
  source: string;
  /** The board's own, the operator's: reached as it is. A company's goes through the egress. */
  operator: boolean;
}

/** The email target for a company: its own SMTP URL env var NAME when set (and set for the company), else the board's. */
export async function emailFor(deps: NotifyDeps, companyId: string): Promise<EmailTarget | null> {
  const row = (
    await deps.db.query<{ name: string; settings: Record<string, unknown> }>(
      "SELECT name, settings FROM companies WHERE id = $1",
      [companyId],
    )
  ).rows[0];
  const settings = notifySettings(row?.settings);
  if (settings.email) {
    const smtpUrl = (await envFor(deps, companyId))[settings.email.smtpUrlEnvName]?.trim();
    if (smtpUrl) {
      const host = (() => {
        try {
          return new URL(smtpUrl).hostname || "rosterdock.local";
        } catch {
          return "rosterdock.local";
        }
      })();
      return {
        smtpUrl,
        to: settings.email.to,
        from: settings.email.from ?? `rosterdock@${host}`,
        source: settings.email.smtpUrlEnvName,
        operator: false,
      };
    }
    deps.log.warn(
      `${notSetForCompany(settings.email.smtpUrlEnvName)}; ${row?.name ?? companyId} gets no email`,
    );
    return null;
  }
  return deps.defaultEmail
    ? { ...deps.defaultEmail, source: "ROSTERDOCK_NOTIFY_SMTP_URL", operator: true }
    : null;
}

export interface SendOutcome {
  /** True when at least one target took it. */
  sent: boolean;
  /** The names the targets came from, comma-separated. */
  target: string | null;
  error: string | null;
}

async function mail(
  deps: NotifyDeps,
  target: EmailTarget,
  subject: string,
  text: string,
): Promise<SendOutcome> {
  try {
    await sendMail(
      target.smtpUrl,
      { from: target.from, to: target.to, subject, text },
      {
        timeoutMs: deps.timeoutMs ?? 15_000,
        ...deps.smtp,
        ...(target.operator ? {} : { guard: egressSocket(deps.egress ?? defaultEgress()) }),
      },
    );
    return { sent: true, target: target.source, error: null };
  } catch (err) {
    // The URL carries the credentials: an error never repeats it, nor the password on its own.
    let raw = (err as Error).message ?? String(err);
    raw = raw.split(target.smtpUrl).join("[smtp]");
    try {
      const pw = new URL(target.smtpUrl).password;
      if (pw) raw = raw.split(decodeURIComponent(pw)).join("[password]");
    } catch {
      // not a URL: nothing more to hide
    }
    return { sent: false, target: target.source, error: `email: ${raw.slice(0, 200)}` };
  }
}

/** Both channels, when configured; sent when either took it. */
function merge(outcomes: SendOutcome[]): SendOutcome {
  const sent = outcomes.filter((o) => o.sent);
  const errors = outcomes.filter((o) => !o.sent && o.error).map((o) => o.error!);
  if (!outcomes.length) return { sent: false, target: null, error: "no webhook or email is configured" };
  return {
    sent: sent.length > 0,
    target:
      (sent.length ? sent : outcomes)
        .map((o) => o.target)
        .filter(Boolean)
        .join(", ") || null,
    error: errors.length ? errors.join("; ") : null,
  };
}

async function post(
  deps: NotifyDeps,
  target: NotifyTarget,
  body: Record<string, unknown>,
): Promise<SendOutcome> {
  try {
    new URL(target.url);
  } catch {
    // A malformed URL would put its (token-bearing) value into fetch's error message; say only where it came from.
    return { sent: false, target: target.source, error: `the webhook URL in ${target.source} is not a URL` };
  }
  const timeoutMs = deps.timeoutMs ?? 15_000;
  // A company's webhook follows no redirect: its URL may carry a token, and the post goes there or nowhere.
  const doFetch = target.operator
    ? (deps.fetch ?? fetch)
    : egressFetch(deps.egress ?? defaultEgress(), { redirect: "error", timeoutMs });
  try {
    const res = await doFetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
      return { sent: false, target: target.source, error: `the webhook answered HTTP ${res.status}` };
    return { sent: true, target: target.source, error: null };
  } catch (err) {
    const raw = (err as Error).message ?? String(err);
    return {
      sent: false,
      target: target.source,
      error: raw.split(target.url).join("[webhook]").slice(0, 200),
    };
  }
}

/**
 * Claim an event for sending. Every replica's notifier sees every event; the
 * one whose insert lands sends, the others see the claim and stop. True when
 * this call took it.
 */
export async function claimNeedsYou(db: Db, companyId: string, seq: number): Promise<boolean> {
  const res = await db.query(
    "INSERT INTO notify_claims (company_id, seq) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [companyId, seq],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Push one event to the company's webhook and record that it went. */
export async function sendNeedsYou(deps: NotifyDeps, ev: EventRecord): Promise<SendOutcome> {
  if (!NEEDS_YOU_EVENTS.includes(ev.type))
    return { sent: false, target: null, error: "not a needs-you event" };
  const company = (
    await deps.db.query<{ name: string }>("SELECT name FROM companies WHERE id = $1", [ev.companyId])
  ).rows[0];
  if (!company) return { sent: false, target: null, error: "no such company" };
  const text = needsYouText(ev, company.name);
  if (!text) return { sent: false, target: null, error: "not a needs-you event" };
  if (!(await claimNeedsYou(deps.db, ev.companyId, ev.seq)))
    return { sent: false, target: null, error: "another replica is sending it" };
  const [webhook, email] = await Promise.all([webhookFor(deps, ev.companyId), emailFor(deps, ev.companyId)]);
  const outcomes: { channel: "webhook" | "email"; outcome: SendOutcome }[] = [];
  if (webhook)
    outcomes.push({
      channel: "webhook",
      outcome: await post(deps, webhook, {
        text: `${company.name} · ${text}`,
        company: company.name,
        companyId: ev.companyId,
        type: ev.type,
        seq: ev.seq,
        subject: ev.subject,
      }),
    });
  if (email)
    outcomes.push({
      channel: "email",
      outcome: await mail(deps, email, `${company.name} · needs you`, `${text}\n\n(${ev.type})`),
    });
  for (const { channel, outcome } of outcomes) {
    if (outcome.sent) {
      await mutate(deps.db, ev.companyId, ev.actor ?? SYSTEM_ACTOR, async (ctx) => {
        await ctx.emit("notify.sent", ev.subject, {
          type: ev.type,
          seq: ev.seq,
          target: outcome.target,
          channel,
        });
      }).catch((err) => deps.log.warn(`could not record the notification: ${(err as Error).message}`));
    } else {
      deps.log.warn(`notification for ${ev.type} (seq ${ev.seq}) not sent: ${outcome.error}`);
    }
  }
  return merge(outcomes.map((o) => o.outcome));
}

/** "Send a test": one message to the company's webhook, so the owner knows the name resolves. */
export async function sendTest(deps: NotifyDeps, companyId: string, actor: ActorRef): Promise<SendOutcome> {
  const company = (
    await deps.db.query<{ name: string }>("SELECT name FROM companies WHERE id = $1", [companyId])
  ).rows[0];
  const [webhook, email] = await Promise.all([webhookFor(deps, companyId), emailFor(deps, companyId)]);
  const name = company?.name ?? "RosterDock";
  const outcomes: { channel: "webhook" | "email"; outcome: SendOutcome }[] = [];
  if (webhook)
    outcomes.push({
      channel: "webhook",
      outcome: await post(deps, webhook, {
        text: `${name} · Needs-you notifications reach you here.`,
        company: company?.name,
        companyId,
        type: "notify.test",
      }),
    });
  if (email)
    outcomes.push({
      channel: "email",
      outcome: await mail(
        deps,
        email,
        `${name} · a test from RosterDock`,
        "Needs-you notifications reach you here.",
      ),
    });
  for (const { channel, outcome } of outcomes) {
    if (!outcome.sent) continue;
    await mutate(deps.db, companyId, actor, async (ctx) => {
      await ctx.emit("notify.sent", null, { type: "notify.test", target: outcome.target, channel });
    });
  }
  return merge(outcomes.map((o) => o.outcome));
}

/**
 * Subscribe to the bus: every needs-you event is pushed once, whatever the
 * number of replicas. Each replica's notifier sees the event and claims it in
 * `notify_claims` before sending; one insert lands, so one message goes.
 * Returns the unsubscribe.
 */
export function startNotifier(deps: NotifyDeps, bus: EventBus): () => void {
  return bus.fanout.subscribe((ev) => {
    if (!NEEDS_YOU_EVENTS.includes(ev.type)) return;
    void sendNeedsYou(deps, ev).catch((err) => deps.log.warn(`notifier failed: ${(err as Error).message}`));
  });
}
