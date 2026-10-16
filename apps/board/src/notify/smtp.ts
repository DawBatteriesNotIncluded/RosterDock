// A small SMTP client over node:net and node:tls: EHLO, STARTTLS when the
// server offers it, AUTH PLAIN or LOGIN, one message, QUIT. No library: the
// dialogue is a dozen lines, and every error names the step and the server's
// answer, never the URL or the password. The target is an SMTP URL held in an
// env var whose NAME is configuration: smtp://user:pass@host:587 (plain, then
// STARTTLS when the server offers it) or smtps://user:pass@host:465 (TLS from
// the start). Credentials travel only over TLS unless the URL says
// ?plainAuth=1 (a relay on localhost).

import { randomUUID } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export interface SmtpOptions {
  timeoutMs?: number;
  /** For the TLS handshake: a private CA, or a servername that differs from the host. */
  tls?: Pick<ConnectionOptions, "ca" | "rejectUnauthorized" | "servername">;
}

export class SmtpError extends Error {}

export interface SmtpTarget {
  secure: boolean;
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  plainAuth: boolean;
}

const ADDRESS_RE = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

export function parseSmtpUrl(raw: string): SmtpTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SmtpError("the SMTP URL is not a URL");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:")
    throw new SmtpError("the SMTP URL must start with smtp:// or smtps://");
  const secure = url.protocol === "smtps:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SmtpError("the SMTP URL has no host");
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  return {
    secure,
    host,
    port,
    user: url.username ? decodeURIComponent(url.username) : null,
    pass: url.password ? decodeURIComponent(url.password) : null,
    plainAuth: url.searchParams.get("plainAuth") === "1",
  };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** A header value: ASCII as it is, anything else as an encoded word; never a line break. */
function headerValue(s: string): string {
  const flat = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${b64(flat)}?=`;
}

/** The message as the bytes after DATA, without the terminating line. */
export function renderMessage(message: SmtpMessage): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${headerValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@rosterdock>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Mailer: rosterdock-board",
  ];
  const body = message.text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

class Session {
  private socket: Socket | null = null;
  private buffer = "";
  private queue: string[] = [];
  private waiter: { resolve(line: string): void; reject(err: Error): void } | null = null;
  private failure: Error | null = null;
  private readonly timer: NodeJS.Timeout;
  private extensions = new Set<string>();
  private auth = new Set<string>();
  secure: boolean;

  constructor(
    private readonly target: SmtpTarget,
    private readonly tls: SmtpOptions["tls"],
    timeoutMs: number,
  ) {
    this.secure = target.secure;
    this.timer = setTimeout(
      () => this.fail(new SmtpError(`the server gave no answer in ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  }

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\r\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(line);
      } else {
        this.queue.push(line);
      }
    }
  };
  private readonly onError = (err: Error): void => this.fail(err);
  private readonly onClose = (): void => this.fail(new SmtpError("the server closed the connection"));

  private fail(err: Error): void {
    this.failure ??= err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private detach(): Socket {
    const socket = this.socket!;
    socket.removeListener("data", this.onData);
    socket.removeListener("error", this.onError);
    socket.removeListener("close", this.onClose);
    return socket;
  }

  private line(): Promise<string> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** One reply: "250-..." lines continue, "250 ..." (or "250") ends it. */
  private async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.line();
      const m = /^(\d{3})([ -]?)(.*)$/.exec(l);
      if (!m) throw new SmtpError(`the server sent something that is not a reply: ${l.slice(0, 80)}`);
      lines.push(m[3]!);
      if (m[2] !== "-") return { code: Number(m[1]), lines };
    }
  }

  private async command(cmd: string, ok: number[], step: string): Promise<{ code: number; lines: string[] }> {
    if (this.failure) throw this.failure;
    this.socket!.write(`${cmd}\r\n`);
    const r = await this.reply();
    if (!ok.includes(r.code))
      throw new SmtpError(`${step} answered ${r.code} ${r.lines.join(" ").slice(0, 200)}`);
    return r;
  }

  private async ehlo(): Promise<void> {
    const r = await this.command("EHLO rosterdock-board", [250], "EHLO");
    this.extensions = new Set(r.lines.slice(1).map((l) => l.trim().toUpperCase()));
    this.auth = new Set(
      [...this.extensions]
        .filter((l) => l.startsWith("AUTH ") || l.startsWith("AUTH="))
        .flatMap((l) => l.slice(5).split(/[\s=]+/))
        .filter(Boolean),
    );
  }

  private upgrade(): Promise<void> {
    const plain = this.detach();
    return new Promise((resolve, reject) => {
      const secured = tlsConnect({ socket: plain, servername: this.target.host, ...this.tls }, () => {
        this.attach(secured);
        this.secure = true;
        resolve();
      });
      secured.once("error", reject);
    });
  }

  async open(): Promise<void> {
    const { host, port } = this.target;
    await new Promise<void>((resolve, reject) => {
      const socket = this.target.secure
        ? tlsConnect({ host, port, servername: host, ...this.tls }, resolve)
        : netConnect({ host, port }, resolve);
      socket.once("error", reject);
      this.attach(socket);
    });
    const greeting = await this.reply();
    if (greeting.code !== 220) throw new SmtpError(`the server greeted with ${greeting.code}`);
    await this.ehlo();
    if (!this.secure && this.extensions.has("STARTTLS")) {
      await this.command("STARTTLS", [220], "STARTTLS");
      await this.upgrade();
      await this.ehlo();
    }
    if (this.target.user !== null) {
      if (!this.secure && !this.target.plainAuth)
        throw new SmtpError(
          "the server offers no TLS and the URL does not allow credentials in the clear (add ?plainAuth=1 for a relay on localhost)",
        );
      const { user, pass } = this.target;
      if (this.auth.has("PLAIN")) {
        await this.command(`AUTH PLAIN ${b64(`\0${user}\0${pass ?? ""}`)}`, [235], "AUTH PLAIN");
      } else if (this.auth.has("LOGIN")) {
        await this.command("AUTH LOGIN", [334], "AUTH LOGIN");
        await this.command(b64(user), [334], "AUTH LOGIN");
        await this.command(b64(pass ?? ""), [235], "AUTH LOGIN");
      } else {
        throw new SmtpError("the server offers no AUTH method the board speaks (PLAIN or LOGIN)");
      }
    }
  }

  async send(message: SmtpMessage): Promise<void> {
    const eightBit = this.extensions.has("8BITMIME") ? " BODY=8BITMIME" : "";
    await this.command(`MAIL FROM:<${message.from}>${eightBit}`, [250], "MAIL FROM");
    for (const to of message.to) await this.command(`RCPT TO:<${to}>`, [250, 251], `RCPT TO ${to}`);
    await this.command("DATA", [354], "DATA");
    this.socket!.write(`${renderMessage(message)}\r\n.\r\n`);
    const r = await this.reply();
    if (r.code !== 250)
      throw new SmtpError(`the message answered ${r.code} ${r.lines.join(" ").slice(0, 200)}`);
    // Some servers close on QUIT before answering; the message is already accepted.
    await this.command("QUIT", [221], "QUIT").catch(() => {});
  }

  close(): void {
    clearTimeout(this.timer);
    this.socket?.destroy();
  }
}

/** Send one message; resolves when the server accepted it. Throws an SmtpError that names the step. */
export async function sendMail(
  url: string,
  message: SmtpMessage,
  opts: SmtpOptions = {},
): Promise<{ host: string; secure: boolean }> {
  const target = parseSmtpUrl(url);
  for (const a of [message.from, ...message.to])
    if (!ADDRESS_RE.test(a)) throw new SmtpError(`${a.slice(0, 80)} is not an email address`);
  if (!message.to.length) throw new SmtpError("no recipient");
  const session = new Session(target, opts.tls, opts.timeoutMs ?? 15_000);
  try {
    await session.open();
    await session.send(message);
    return { host: target.host, secure: session.secure };
  } finally {
    session.close();
  }
}
