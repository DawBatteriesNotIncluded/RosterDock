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
