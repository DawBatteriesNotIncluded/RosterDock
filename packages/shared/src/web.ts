// Which sites the board's web connection may read for a teammate. A list names
// domains, and each covers the sites under it: `example.com` takes
// `docs.example.com` too. No list says nothing, so any public site. The company's
// list is the ceiling; a department and a project's client may each name a list,
// and a list only ever narrows: a site must be on every list there is. Pure,
// shared by the board (which checks every hop of a fetch) and the web (which
// edits and explains the lists). Addresses are not here: the board refuses any
// address that is not public whatever a list says (apps/board/src/web/address.ts).

/** One label of a host name: letters, digits and inner dashes, at most 63 characters. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A domain as a list keeps it, from what a person typed: lower case, without a scheme, a path, a port, a
 * leading `*.` or `.` or a trailing dot, an international name in its ASCII form. Null for anything that is
 * not a domain: an address, a single label (`localhost`), a name with credentials or a bad label.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || s.length > 300 || s.includes("@")) return null;
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  for (const stop of ["/", "?", "#"]) {
    const at = s.indexOf(stop);
    if (at >= 0) s = s.slice(0, at);
  }
  if (s.startsWith("*.")) s = s.slice(2);
  else if (s.startsWith(".")) s = s.slice(1);
  let host: string;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253 || host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  // Every label numeric is an IPv4 address, written however: not a domain.
  if (labels.every((l) => /^\d+$/.test(l))) return null;
  return host;
}

/**
 * A stored list as policy reads it: its domains, once each, or null when it names none. An empty list in a
 * row says nothing (the field was left empty), so it narrows nothing.
 */
export function domainList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    const d = typeof item === "string" ? normalizeDomain(item) : null;
    if (d && !out.includes(d)) out.push(d);
  }
  return out.length ? out : null;
}

/** Whether a host is one of the domains or a site under one. Null: there is no list, so any host. */
export function hostOnList(host: string, domains: readonly string[] | null): boolean {
  if (domains === null) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * The sites both lists allow, as a list: where one list's domain is under the other's, the narrower of the
 * two. Null for either says nothing, so the result is the other one. An empty result allows nothing.
 */
export function narrowDomains(a: readonly string[] | null, b: readonly string[] | null): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const out: string[] = [];
  for (const x of a)
    for (const y of b) {
      const narrower = hostOnList(y, [x]) ? y : hostOnList(x, [y]) ? x : null;
      if (narrower && !out.includes(narrower)) out.push(narrower);
    }
  // A domain under another one already kept adds nothing.
  return out.filter((d) => !out.some((o) => o !== d && hostOnList(d, [o])));
}

/** Two lists allow the same sites. */
function sameSites(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((d) => b.includes(d));
}

export interface WebDomainsInput {
  /** The company's list, on its web connection. */
  company: unknown;
  /** The task's department's list (its sandbox's `webDomains`). */
  department?: unknown;
  /** The task's project's client's list (its client policy's `webDomains`). */
  client?: unknown;
}

export interface WebDomainsDecision {
  /** The sites the web connection may read on this task; null for any public site, empty for none. */
  domains: string[] | null;
  /** Which lists made it narrower than the company's, for the brief and refusals. */
  narrowedBy: ("department" | "client")[];
}

/** The sites one task may read: the company's list, narrowed by the department's, then by the client's. */
export function effectiveWebDomains(input: WebDomainsInput): WebDomainsDecision {
  let domains = domainList(input.company);
  const narrowedBy: WebDomainsDecision["narrowedBy"] = [];
  for (const [level, raw] of [
    ["department", input.department],
    ["client", input.client],
  ] as const) {
    const next = narrowDomains(domains, domainList(raw));
    if (!sameSites(next, domains)) narrowedBy.push(level);
    domains = next;
  }
  return { domains, narrowedBy };
}

/** The sites a list allows, in a phrase: "any public site", "no site", or the domains. */
export function domainsPhrase(domains: readonly string[] | null): string {
  if (domains === null) return "any public site";
  if (!domains.length) return "no site";
  return `only ${domains.join(", ")} and the sites under ${domains.length === 1 ? "it" : "them"}`;
}
