// A fake SMTP server on an ephemeral localhost port for the notifier's email
// target: plain, plain with STARTTLS, or TLS from the start (a self-signed
// localhost certificate in fixtures/smtp). It speaks just enough of RFC 5321
// to take one message per session and records every command, the credentials
// presented and the message as received. No network beyond 127.0.0.1.
import { readFileSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SMTP_CERT = readFileSync(path.join(here, "fixtures", "smtp", "cert.pem"), "utf8");
const SMTP_KEY = readFileSync(path.join(here, "fixtures", "smtp", "key.pem"), "utf8");

export interface SmtpSession {
  commands: string[];
  authed: string | null;
  secure: boolean;
  from: string | null;
  to: string[];
  message: string | null;
}

export interface FakeSmtp {
  port: number;
  sessions: SmtpSession[];
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  /** TLS from the first byte (smtps://). */
  tls?: boolean;
  /** Offer STARTTLS on a plain connection. */
  starttls?: boolean;
  user?: string;
  pass?: string;
  /** Recipients this server refuses with 550. */
  reject?: string[];
}

export async function startFakeSmtp(opts: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const sessions: SmtpSession[] = [];
  const handle = (initial: Socket, secure: boolean) => {
    const session: SmtpSession = { commands: [], authed: null, secure, from: null, to: [], message: null };
    sessions.push(session);
    let socket: Socket = initial;
    let buffer = "";
    let data: string[] | null = null;
    let loginStep: "user" | "pass" | null = null;
    let loginUser = "";
    const write = (s: string) => socket.write(`${s}\r\n`);
    const ehlo = () => {
      const lines = ["250-fake.local"];
      if (!session.secure && opts.starttls) lines.push("250-STARTTLS");
      if (opts.user) lines.push("250-AUTH PLAIN LOGIN");
      lines.push("250-8BITMIME", "250 OK");
      for (const l of lines) write(l);
    };
    const authOk = (user: string, pass: string) => {
      if (user === opts.user && pass === opts.pass) {
        session.authed = user;
        write("235 Authentication succeeded");
      } else {
        write("535 Authentication credentials invalid");
      }
    };
    const onLine = (line: string) => {
      if (data) {
        if (line === ".") {
          session.message = data.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
          data = null;
          write("250 OK queued");
        } else {
          data.push(line);
        }
        return;
      }
      if (loginStep === "user") {
        loginUser = Buffer.from(line, "base64").toString("utf8");
        loginStep = "pass";
        write("334 UGFzc3dvcmQ6");
        return;
      }
      if (loginStep === "pass") {
        loginStep = null;
        authOk(loginUser, Buffer.from(line, "base64").toString("utf8"));
        return;
      }
      session.commands.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) return ehlo();
      if (upper === "STARTTLS") {
        if (session.secure || !opts.starttls) return write("454 TLS not available");
        write("220 Ready to start TLS");
        socket.removeListener("data", onData);
        const secured = new TLSSocket(socket, { isServer: true, key: SMTP_KEY, cert: SMTP_CERT });
        socket = secured;
        session.secure = true;
        buffer = "";
        secured.setEncoding("utf8");
        secured.on("data", onData);
        secured.on("error", () => {});
        return;
      }
      if (upper.startsWith("AUTH PLAIN ")) {
        const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
        return authOk(user ?? "", pass ?? "");
      }
      if (upper === "AUTH LOGIN") {
        loginStep = "user";
        return write("334 VXNlcm5hbWU6");
      }
      if (upts(upper, "MAIL FROM:")) {
        session.from = /<([^>]*)>/.exec(line)?.[1] ?? null;
        return write("250 OK");
      }
      if (upts(upper, "RCPT TO:")) {
        const to = /<([^>]*)>/.exec(line)?.[1] ?? "";
        if (opts.reject?.includes(to)) return write(`550 No such user ${to}`);
        session.to.push(to);
        return write("250 OK");
      }
      if (upper === "DATA") {
        data = [];
        return write("354 End data with <CR><LF>.<CR><LF>");
      }
      if (upper === "QUIT") {
        write("221 Bye");
        socket.end();
        return;
      }
      write("500 Unknown command");
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        onLine(line);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("error", () => {});
    write("220 fake.local ESMTP");
  };
  const server: Server = opts.tls
    ? createTlsServer({ key: SMTP_KEY, cert: SMTP_CERT }, (s) => handle(s, true))
    : createNetServer((s) => handle(s, false));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    sessions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function upts(s: string, prefix: string): boolean {
  return s.startsWith(prefix);
}
