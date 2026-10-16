// Secret hygiene. RosterDock stores env-var NAMES and secret REFS, never values.
// Ported from agent-board `src/gtm/models.ts` (looksLikeRawSecret) and widened
// into a write-boundary guard that walks any JSON payload.

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Values that look like actual secret material rather than a reference.
// Defence in depth: the store must never hold raw keys, even by accident.
const RAW_SECRET_RES: RegExp[] = [
  /^sk-/i, // OpenAI/Anthropic-style keys
  /^eyJ[A-Za-z0-9_-]{10,}/, // JWTs
  /^ghp_|^github_pat_/i, // GitHub tokens
  /^xox[a-z]-/i, // Slack tokens
  /^AKIA[0-9A-Z]{12,}/, // AWS access key ids
  /^Bearer\s+[A-Za-z0-9._~+/=-]{16,}$/i, // an Authorization header value, not prose that starts with Bearer
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
];

// The same shapes anywhere in free text (a diff line, a log line): after a word boundary instead of at the
// start, with enough key behind the prefix that prose naming it ("sk-", "Bearer tokens") is not a hit.
const TEXT_SECRET_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI/Anthropic-style keys
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, // JWTs: a header and a payload
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/i, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, // an Authorization header value
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  // A value assigned to a secret-named variable the way a shell, an .env file or `env` writes it: NAME=value
  // with no spaces and no quotes, where the value is not itself a reference ($NAME, ${…}, <placeholder>).
  /(?:^|\s)[A-Za-z0-9_]*(?:api[_-]?key|secret(?:[_-]?key)?|private[_-]?key|password|passwd|token)=[A-Za-z0-9._~+/:@%^*!#-]{8,}/i,
];

export function isEnvVarName(value: string): boolean {
  return ENV_VAR_NAME_RE.test(value);
}

/**
 * True when a string looks like key material rather than a reference.
 * A reference is a short name or path (ENV_STYLE_NAME, vault://path, kv/slashes).
 */
export function looksLikeRawSecret(value: string): boolean {
  if (RAW_SECRET_RES.some((re) => re.test(value))) return true;
  // A reference should be a short name/path, not a long opaque blob.
  if (value.length > 128) return true;
  // Prefix-less keys (Azure/AWS-style): a long unbroken base64-ish blob is
  // key material, not a reference. Real refs have structure or are short.
  if (/^[A-Za-z0-9+/=]{40,}$/.test(value)) return true;
  return false;
}

/**
 * True when free text carries key material anywhere in it, not only at the start: a key after `NAME=`, in
 * a string literal or behind `Bearer`, or a value given to a secret-named variable. For text that is read,
 * such as a diff; the write-boundary guard below keeps to the start-anchored shapes so prose is not refused.
 */
export function containsRawSecret(text: string): boolean {
  return TEXT_SECRET_RES.some((re) => re.test(text));
}

export interface SecretFinding {
  /** JSON path of the offending string, e.g. `settings.apiKey` or `tools[2].credential`. */
  path: string;
  /** Why it was flagged; never contains the value. */
  reason: string;
}

// Field names that are meant to carry secret REFERENCES. Values under these
// keys are checked with looksLikeRawSecret. Everything else is checked only for
// unmistakable key shapes (the prefix regexes) so prose is not rejected.
const REF_KEY_RE = /(secret|credential|token|api[_-]?key|password|passwd|private[_-]?key)/i;

function scan(value: unknown, path: string, key: string | null, out: SecretFinding[]): void {
  if (typeof value === "string") {
    const refField = key !== null && REF_KEY_RE.test(key);
    if (refField ? looksLikeRawSecret(value) : RAW_SECRET_RES.some((re) => re.test(value))) {
      out.push({
        path,
        reason: refField ? "secret-shaped value in a reference field" : "secret-shaped string",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scan(item, `${path}[${i}]`, key, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scan(v, path ? `${path}.${k}` : k, k, out);
    }
  }
}

/** Walk a payload and report every string that looks like raw secret material. */
export function findRawSecrets(payload: unknown): SecretFinding[] {
  const out: SecretFinding[] = [];
  scan(payload, "", null, out);
  return out;
}

export class RawSecretError extends Error {
  readonly findings: SecretFinding[];
  constructor(findings: SecretFinding[]) {
    const where = findings.map((f) => f.path || "<root>").join(", ");
    super(
      `payload contains what looks like raw secret material at ${where}; store env-var names or secret refs instead`,
    );
    this.name = "RawSecretError";
    this.findings = findings;
  }
}

/** Write-boundary guard. Throws RawSecretError; never logs or echoes the value. */
export function assertNoRawSecrets(payload: unknown): void {
  const findings = findRawSecrets(payload);
  if (findings.length > 0) throw new RawSecretError(findings);
}
