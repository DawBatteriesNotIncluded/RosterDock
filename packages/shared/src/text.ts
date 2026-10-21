// Small parsers for input anyone can send: an Authorization header before
// sign-in, a URL from a provider's metadata. Each one scans its input once.
// The regular expressions they replace (/^Bearer\s+(.+)$/i, /\/+$/) backtrack
// on a long run of spaces or slashes and take time quadratic in its length.

/** The token in an `Authorization: Bearer <token>` header, trimmed; null for anything else. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header || header.length < 7 || header.slice(0, 6).toLowerCase() !== "bearer") return null;
  const rest = header.slice(6);
  if (!/^\s/.test(rest)) return null;
  return rest.trim() || null;
}

/** The string without its trailing slashes. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}
