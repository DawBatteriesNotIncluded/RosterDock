// What the operator lets the companies on this board reach (packages/shared
// operator.ts), checked where a company writes something the board will act on
// later: an env var name on a connection or in its settings, the command a
// stdio connection runs. Resolution and the spawn are the guards
// (secrets/company.ts: a company's names resolve from its own secrets and the
// names the operator shares, nothing else; mcp/client.ts starts only a listed
// command line); the checks here refuse at the write what could never run, so
// a person learns it at once. And who may found a company at all.

import {
  isCompanyCreator,
  stdioCommandAllowed,
  stdioCommandLine,
  type CompanyCreators,
  type StdioCommand,
} from "@rosterdock/shared";
import type { Queryable } from "./db/pool.js";
import { HttpError } from "./http-error.js";
import { companySecretName } from "./secrets/company.js";
import type { SecretStore } from "./secrets/store.js";

export interface OperatorPolicy {
  /** The board's whole environment: a name set here that the operator does not share is the board's own. */
  boardEnv: NodeJS.ProcessEnv;
  /** ROSTERDOCK_SHARED_ENV_NAMES: the names every company may use besides its own secrets. */
  sharedEnvNames: readonly string[];
  /** Where a company's own secrets live; a name it set there is its own, whatever the board holds. */
  store: SecretStore | null;
  /** ROSTERDOCK_STDIO_COMMANDS: the command lines a stdio connection may run inside the board. */
  stdioCommands: readonly StdioCommand[];
  /** Whether anyone may sign in as anyone (ROSTERDOCK_DEV_LOGIN); then anyone may found a company too. */
  devLogin: boolean;
  /** ROSTERDOCK_COMPANY_CREATORS: who may create a company. Null: the first company on an empty board only. */
  companyCreators: CompanyCreators | null;
}

/**
 * Why these names cannot be a company's, or null when they can: a name that is set where the board runs,
 * that the operator does not share, and that the company has not set for itself is the board's own.
 */
export async function companyEnvNameRefusal(
  policy: OperatorPolicy,
  companyId: string,
  names: Iterable<string | null | undefined>,
): Promise<string | null> {
  const shared = new Set(policy.sharedEnvNames);
  const boards = [...new Set(names)].filter(
    (n): n is string => !!n && !shared.has(n) && policy.boardEnv[n] !== undefined,
  );
  if (!boards.length) return null;
  // A store that cannot be read leaves the names the board's: refused, never resolved from the board.
  const own = policy.store
    ? ((await policy.store.get(companySecretName(companyId)).catch(() => null)) ?? {})
    : {};
  const refused = boards.filter((n) => !own[n]);
  if (!refused.length) return null;
  return `${refused.join(", ")} ${refused.length === 1 ? "is the board's own and never reaches" : "are the board's own and never reach"} a company; name one of this company's secrets (Settings > Connections > Secrets) or a name the operator shares (ROSTERDOCK_SHARED_ENV_NAMES)`;
}

/** The same as a 403 at the API. */
export async function assertCompanyEnvNames(
  policy: OperatorPolicy,
  companyId: string,
  names: Iterable<string | null | undefined>,
): Promise<void> {
  const refusal = await companyEnvNameRefusal(policy, companyId, names);
  if (refusal) throw new HttpError(403, refusal);
}

/** Why the board will not run this stdio command line for a connection, or null when it will. */
export function stdioRefusal(
  allowed: readonly StdioCommand[],
  command: string | null | undefined,
  args: readonly string[] | null | undefined,
): string | null {
  if (stdioCommandAllowed(allowed, command, args)) return null;
  if (!allowed.length)
    return "this board runs no commands for connections; the operator lists each command line it may run (ROSTERDOCK_STDIO_COMMANDS)";
  const line = command ? stdioCommandLine({ command, args }) : "";
  const shown = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return `this board does not run ${shown || "a stdio connection without a command"} for connections; the operator lists each command line it runs (ROSTERDOCK_STDIO_COMMANDS)`;
}

/** The same as a 403 at the API. */
export function assertStdioCommand(
  allowed: readonly StdioCommand[],
  command: string | null | undefined,
  args: readonly string[] | null | undefined,
): void {
  const refusal = stdioRefusal(allowed, command, args);
  if (refusal) throw new HttpError(403, refusal);
}

/** Held while the first company on an empty board is made, so two people do not both found one. */
const FIRST_COMPANY_LOCK = 7_248_107_002; // arbitrary, stable; the migration lock's neighbour

/**
 * Why this person may not create a company, or null when they may: the operator's list when there is one;
 * else anyone, with the dev login on (it lets anyone sign in as anyone); else whoever creates the first
 * company on an empty board, and nobody after. With `lock`, inside a transaction, the first-company case
 * holds a lock until the transaction ends.
 */
export async function companyCreationRefusal(
  db: Queryable,
  rule: { devLogin: boolean; companyCreators: CompanyCreators | null },
  email: string,
  lock = false,
): Promise<string | null> {
  if (rule.companyCreators)
    return isCompanyCreator(rule.companyCreators, email)
      ? null
      : "the operator lists who may create a company on this board (ROSTERDOCK_COMPANY_CREATORS), and you are not on the list; an owner can invite you to theirs";
  if (rule.devLogin) return null;
  if (lock) await db.query("SELECT pg_advisory_xact_lock($1)", [FIRST_COMPANY_LOCK]);
  const res = await db.query<{ any: boolean }>("SELECT EXISTS (SELECT 1 FROM companies) AS any");
  return res.rows[0]?.any
    ? "this board has its first company, and only the people the operator lists may create another (ROSTERDOCK_COMPANY_CREATORS); an owner can invite you to theirs"
    : null;
}
