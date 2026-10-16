// What the operator lets the companies on a board reach, read from the board's
// environment. Every company is a tenant: its owners and admins manage its
// connections and settings, never the board. So a name a company writes on a
// connection or in its settings resolves from that company's own secrets and
// from the names the operator shares with every company
// (ROSTERDOCK_SHARED_ENV_NAMES), never from the rest of the board's environment;
// a stdio connection runs only a command line the operator lists
// (ROSTERDOCK_STDIO_COMMANDS), since it runs inside the board; and a company is
// created by someone the operator lists (ROSTERDOCK_COMPANY_CREATORS). Each list
// is empty by default, and empty means none. Pure functions, shared by the
// board (it enforces them) and its tests.

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the board keeps for itself, whatever the operator lists: its database, its object store and
 * collector credentials, its own settings and the model credentials Peter's CLIs read.
 */
export const BOARD_OWN_ENV_NAME =
  /^(DATABASE_URL|S3_ACCESS_KEY|S3_SECRET_KEY|OTEL_EXPORTER_OTLP_HEADERS|(ROSTERDOCK|ANTHROPIC|CLAUDE|CODEX|OPENAI)_[A-Za-z0-9_]*)$/;

/** A comma-separated setting as its trimmed, non-empty entries. */
function entries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ROSTERDOCK_SHARED_ENV_NAMES: env var names on the board that every company may name, comma-separated.
 * A value under one of them reaches whoever manages a connection in any company (they choose where it
 * is sent), so the board refuses to start with one of its own names here.
 */
export function parseSharedEnvNames(raw: string | undefined): string[] {
  const names = entries(raw);
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new Error(`ROSTERDOCK_SHARED_ENV_NAMES: ${name} is not an env var name`);
    if (BOARD_OWN_ENV_NAME.test(name))
      throw new Error(
        `ROSTERDOCK_SHARED_ENV_NAMES: ${name} is the board's own and is never shared with a company`,
      );
  }
  return [...new Set(names)];
}

/** One command line a stdio connection may run: the command, its arguments, and whether more may follow. */
export interface StdioCommand {
  command: string;
  args: string[];
  /** The line ended in `*`: any further arguments may follow these. */
  more: boolean;
}

/**
 * ROSTERDOCK_STDIO_COMMANDS: the command lines a stdio connection may run inside the board, comma-separated.
 * Each is a command and its arguments separated by spaces, matched exactly; a final `*` lets any further
 * arguments follow (`npx -y @modelcontextprotocol/server-filesystem@2026.8.31 *` lets a company pick the
 * folders). A command or an argument with a space or a comma in it cannot be listed.
 */
export function parseStdioCommands(raw: string | undefined): StdioCommand[] {
  return entries(raw).map((line) => {
    const tokens = line.split(/\s+/);
    const more = tokens.at(-1) === "*";
    if (more) tokens.pop();
    const [command, ...args] = tokens;
    if (!command || command === "*") throw new Error(`ROSTERDOCK_STDIO_COMMANDS: ${line} names no command`);
    return { command, args, more };
  });
}

/** A command line as the operator writes it. */
export function stdioCommandLine(c: {
  command: string;
  args?: readonly string[] | null;
  more?: boolean;
}): string {
  return [c.command, ...(c.args ?? []), ...(c.more ? ["*"] : [])].join(" ");
}

/** Whether the board runs this command with these arguments: a line names the command and the same arguments, or their start before a `*`. */
export function stdioCommandAllowed(
  allowed: readonly StdioCommand[],
  command: string | null | undefined,
  args: readonly string[] | null | undefined,
): boolean {
  if (!command) return false;
  const given = args ?? [];
  return allowed.some(
    (a) =>
      a.command === command &&
      (a.more ? given.length >= a.args.length : given.length === a.args.length) &&
      a.args.every((arg, i) => given[i] === arg),
  );
}

/** Who may create a company on the board. Unset: the first company on an empty board only, or anyone with the dev login on. */
export interface CompanyCreators {
  /** `*`: anyone who signs in. */
  anyone: boolean;
  /** Lowercased email addresses. */
  emails: string[];
  /** Lowercased email domains, from `@domain` entries. */
  domains: string[];
}

/**
 * ROSTERDOCK_COMPANY_CREATORS: emails and `@domain`s, comma-separated, or `*` for anyone who signs in. Null
 * when unset or empty.
 */
export function parseCompanyCreators(raw: string | undefined): CompanyCreators | null {
  const list = entries(raw).map((e) => e.toLowerCase());
  if (!list.length) return null;
  const out: CompanyCreators = { anyone: false, emails: [], domains: [] };
  for (const entry of list) {
    if (entry === "*") out.anyone = true;
    else if (/^@[a-z0-9.-]+\.[a-z0-9-]+$/.test(entry)) out.domains.push(entry.slice(1));
    else if (/^[^@\s]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(entry)) out.emails.push(entry);
    else throw new Error(`ROSTERDOCK_COMPANY_CREATORS: ${entry} is not an email, an @domain or *`);
  }
  return out;
}

/** Whether this email may create a company under the operator's list. */
export function isCompanyCreator(creators: CompanyCreators, email: string): boolean {
  const e = email.trim().toLowerCase();
  if (creators.anyone) return true;
  if (creators.emails.includes(e)) return true;
  const domain = e.split("@")[1] ?? "";
  return !!domain && creators.domains.includes(domain);
}

/**
 * Identity providers where anyone can hold an account. Signing in through one with no email domains
 * listed lets the whole world in, so the board refuses to start that way unless the operator says `*`.
 */
export const PUBLIC_OIDC_ISSUERS: readonly string[] = [
  "https://accounts.google.com",
  "https://login.microsoftonline.com/common/v2.0",
  "https://login.microsoftonline.com/consumers/v2.0",
  "https://login.microsoftonline.com/organizations/v2.0",
  "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
  "https://gitlab.com",
  "https://appleid.apple.com",
];

export function isPublicOidcIssuer(issuer: string): boolean {
  const i = issuer.trim().replace(/\/+$/, "").toLowerCase();
  return PUBLIC_OIDC_ISSUERS.includes(i);
}
