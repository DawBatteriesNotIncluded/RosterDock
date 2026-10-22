// Which addresses the board connects to: the rules, pure, so the board (which
// resolves names and checks every address, apps/board/src/web/address.ts) and
// the web (which says before a check what the board will refuse) read them the
// same way. Public addresses only: IPv4 refuses the special-purpose ranges (RFC
// 6890 and its updates); IPv6 allows only global unicast (2000::/3), less its
// documentation, benchmarking and tunnel ranges, and reads the IPv4 inside a
// mapped, NAT64 or 6to4 address as that IPv4. A company's destinations may also
// be the private ones the operator lists (ROSTERDOCK_PRIVATE_DESTINATIONS).

/** An address range: its leading bytes, its prefix length, and what it is called (or the entry that named it). */
export type Range = [prefix: number[], bits: number, why: string];

const PRIVATE = "a private address";
const RESERVED = "a reserved address";
const DOCUMENTATION = "a documentation address";

const V4_RANGES: Range[] = [
  [[0, 0, 0, 0], 8, "an unspecified address"],
  [[10, 0, 0, 0], 8, PRIVATE],
  [[100, 64, 0, 0], 10, "a shared (carrier-grade NAT) address, where some clouds keep their metadata"],
  [[127, 0, 0, 0], 8, "a loopback address"],
  [[169, 254, 0, 0], 16, "a link-local address, where cloud metadata lives"],
  [[172, 16, 0, 0], 12, PRIVATE],
  [[192, 0, 0, 0], 24, RESERVED],
  [[192, 0, 2, 0], 24, DOCUMENTATION],
  [[192, 88, 99, 0], 24, RESERVED],
  [[192, 168, 0, 0], 16, PRIVATE],
  [[198, 18, 0, 0], 15, RESERVED],
  [[198, 51, 100, 0], 24, DOCUMENTATION],
  [[203, 0, 113, 0], 24, DOCUMENTATION],
  [[224, 0, 0, 0], 4, "a multicast address"],
  [[240, 0, 0, 0], 4, RESERVED],
];

// Inside global unicast (2000::/3), what is still not a public host.
const V6_GLOBAL_EXCEPTIONS: Range[] = [
  [[0x20, 0x01, 0x00, 0x00], 32, "a tunnel (Teredo) address"],
  [[0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48, RESERVED],
  [[0x20, 0x01, 0x00, 0x10], 28, RESERVED],
  [[0x20, 0x01, 0x00, 0x20], 28, RESERVED],
  [[0x20, 0x01, 0x0d, 0xb8], 32, DOCUMENTATION],
  [[0x3f, 0xff, 0x00, 0x00], 20, DOCUMENTATION],
];

// Outside global unicast, the names for what a teammate might be sent to.
const V6_OTHER: Range[] = [
  [[0xfc], 7, "a unique-local (private) address"],
  [[0xfe, 0x80], 10, "a link-local address"],
  [[0xff], 8, "a multicast address"],
];

export function inRange(bytes: number[], [prefix, bits]: Range): boolean {
  for (let i = 0; i < bits; i += 8) {
    const take = Math.min(8, bits - i);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((bytes[i / 8]! & mask) !== (prefix[i / 8] ?? 0)) return false;
  }
  return true;
}

const V4_PART = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4_RE = new RegExp(`^${V4_PART}(?:\\.${V4_PART}){3}$`);

/** An IPv4 address in dotted decimal, as the URL parser writes one (no leading zeros), as its four bytes. */
function v4Bytes(address: string): number[] | null {
  return V4_RE.test(address) ? address.split(".").map(Number) : null;
}

/** An IPv6 address as its 16 bytes (a zone and an IPv4 tail allowed), or null when it is not one. */
function v6Bytes(address: string): number[] | null {
  let s = address.split("%")[0]!;
  if (!/^[\da-f:.]+$/i.test(s) || !s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4Bytes(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  // "::" stands for one group of zeros or more, never none.
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const groups =
    halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest] : head;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(g) || Number.isNaN(v)) return null;
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

function refuseV4(bytes: number[]): string | null {
  return V4_RANGES.find((r) => inRange(bytes, r))?.[2] ?? null;
}

/** Why the board does not read the web at this address, or null for a public one. Anything not an address is refused. */
export function refuseAddress(address: string): string | null {
  const v4 = v4Bytes(address);
  if (v4) return refuseV4(v4);
  const v6 = v6Bytes(address);
  if (!v6) return "not an address";
  // An IPv4 written as IPv6 is that IPv4: mapped (::ffff:0:0/96) and NAT64's well-known prefix (64:ff9b::/96).
  const embedded = (prefix: number[]) => inRange(v6, [prefix, 96, ""]);
  if (
    embedded([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]) ||
    embedded([0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])
  ) {
    const why = refuseV4(v6.slice(12));
    return why ? `${why} (as IPv6)` : null;
  }
  if (v6.every((b) => b === 0)) return "an unspecified address";
  if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) return "a loopback address";
  if (!inRange(v6, [[0x20], 3, ""])) return V6_OTHER.find((r) => inRange(v6, r))?.[2] ?? RESERVED;
  // 6to4 (2002::/16) carries an IPv4 in its next four bytes.
  if (v6[0] === 0x20 && v6[1] === 0x02) {
    const why = refuseV4(v6.slice(2, 6));
    return why ? `${why} (in a 6to4 address)` : null;
  }
  return V6_GLOBAL_EXCEPTIONS.find((r) => inRange(v6, r))?.[2] ?? null;
}

// What a company chooses the board should reach (a connection's server, its OAuth endpoints, a webhook, an
// SMTP server) is held to the same rule, less what the operator lists in ROSTERDOCK_PRIVATE_DESTINATIONS: an
// MCP server inside the cluster, a model on the host. A listed name is trusted with whatever it resolves to;
// a listed address or range is reached whatever name led to it.

/**
 * What the operator lets a company's connections reach though it is not public (ROSTERDOCK_PRIVATE_DESTINATIONS).
 * The names, ranges and entries are every company's; `companies` holds what one company alone may reach, by its
 * id, and counts only once a list is narrowed to that company (forCompany), so a list nobody narrowed never
 * gives one company another's destination.
 */
export interface PrivateDestinations {
  /** Lower case. `*.example.internal` stands for every name under example.internal, not for the name itself. */
  names: string[];
  ranges: Range[];
  /** As the operator wrote them, for a person to read. */
  entries: string[];
  /** One company's own entries, by the company's id. */
  companies?: Record<string, PrivateDestinations>;
  /** Set once the list is narrowed to a company (forCompany): whose list it is now. */
  narrowedTo?: string;
}

export const NO_PRIVATE_DESTINATIONS: PrivateDestinations = { names: [], ranges: [], entries: [] };

// A URL reads a name whose last label is a number (decimal, or 0x hex) as an IPv4 address, so no URL's host
// is ever such a name.
const NUMERIC_TAIL = /(^|\.)(0x[\da-f]*|\d+)$/;

const NAME_RE =
  /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * An address on its own as its bytes, an IPv4 written as IPv6 (mapped, or NAT64's well-known prefix) by its
 * IPv4, as refuseAddress reads them, so a range matches either way.
 */
function addressBytes(address: string): number[] | null {
  const v4 = v4Bytes(address);
  if (v4) return v4;
  const v6 = v6Bytes(address);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  const nat64 = inRange(v6, [[0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96, ""]);
  return mapped || nat64 ? v6.slice(12) : v6;
}

/** Whether this is an address on its own (IPv4, or IPv6 without brackets), not a name. */
export function isAddress(text: string): boolean {
  return addressBytes(text) !== null;
}

/**
 * The operator's list, from a comma-separated setting: host names (`ollama.internal`, `*.svc.cluster.local`),
 * addresses (`127.0.0.1`, `::1`) and ranges (`10.0.0.0/8`, `fd00::/8`). Anything else stops the board from
 * starting, so a typo never quietly allows nothing or everything.
 */
export function parsePrivateDestinations(raw: string | undefined): PrivateDestinations {
  const all: PrivateDestinations = { names: [], ranges: [], entries: [] };
  for (const item of (raw ?? "").split(",")) {
    const written = item.trim().toLowerCase();
    if (!written) continue;
    // `<company id>=<entry>`: that company's alone.
    const eq = written.indexOf("=");
    const company = eq >= 0 ? written.slice(0, eq).trim() : null;
    if (company !== null && !COMPANY_ID_RE.test(company))
      throw new Error(
        `ROSTERDOCK_PRIVATE_DESTINATIONS: "${written}" names a company by "${company}", which is not a company id`,
      );
    const entry = company === null ? written : written.slice(eq + 1).trim();
    const out =
      company === null ? all : ((all.companies ??= {})[company] ??= { names: [], ranges: [], entries: [] });
    const [addr, bitsText, extra] = entry.replace(/^\[|\](?=\/|$)/g, "").split("/");
    const bytes = entry.includes("%") ? null : addressBytes(addr!);
    const name = addr!.replace(/\.$/, "");
    if (bytes && extra === undefined) {
      const max = bytes.length * 8;
      // An IPv4 range written as IPv6 (::ffff:10.0.0.0/104) counts its prefix over the whole IPv6 address.
      const over = bytes.length === 4 && addr!.includes(":") ? 96 : 0;
      const given = bitsText === undefined ? max + over : /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : NaN;
      if (!(given >= 0 && given <= max + over))
        throw new Error(
          `ROSTERDOCK_PRIVATE_DESTINATIONS: ${written} has no prefix length from /${over} to /${max + over}`,
        );
      // ::ffff:0:0/96 or 64:ff9b::/96 reads as every IPv4 address, cloud metadata and loopback included.
      if (over && given <= over)
        throw new Error(
          `ROSTERDOCK_PRIVATE_DESTINATIONS: ${written} is every IPv4 address there is; list the IPv4 ranges you mean`,
        );
      const bits = given - over;
      // The range's own address with its host bits cleared: 10.1.2.3/8 is 10.0.0.0/8.
      const prefix = bytes.map((b, i) => b & (0xff << (8 - Math.max(0, Math.min(8, bits - i * 8)))) & 0xff);
      out.ranges.push([prefix, bits, entry]);
    } else if (bitsText === undefined && NAME_RE.test(name) && !NUMERIC_TAIL.test(name)) {
      out.names.push(name);
    } else {
      // A zone (%eth0) names an interface, not a destination.
      throw new Error(
        `ROSTERDOCK_PRIVATE_DESTINATIONS: "${written}" is not a host name, an address or an address range (10.0.0.0/8)`,
      );
    }
    out.entries.push(entry);
  }
  return all;
}

/** A company's id, as the board writes one. */
const COMPANY_ID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/**
 * The list as one company has it: what every company may reach, and what the operator gave that company
 * alone. A list already narrowed is that company's only; narrowing it to another throws, since it carries
 * the first company's entries.
 */
export function forCompany(allow: PrivateDestinations, companyId: string): PrivateDestinations {
  const id = companyId.toLowerCase();
  if (allow.narrowedTo !== undefined) {
    if (allow.narrowedTo === id) return allow;
    throw new Error("a list of private destinations narrowed to one company was narrowed to another");
  }
  const own = allow.companies?.[id];
  return {
    names: [...allow.names, ...(own?.names ?? [])],
    ranges: [...allow.ranges, ...(own?.ranges ?? [])],
    entries: [...allow.entries, ...(own?.entries.filter((e) => !allow.entries.includes(e)) ?? [])],
    narrowedTo: id,
  };
}

/** Whether the operator lists this name, itself or under a `*.` entry. */
export function nameListed(host: string, allow: PrivateDestinations): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.names.some((n) =>
    n.startsWith("*.") ? name.endsWith(n.slice(1)) && name.length > n.length - 1 : name === n,
  );
}

/** Whether this address is in a range the operator lists. */
export function addressListed(address: string, allow: PrivateDestinations): boolean {
  const bytes = addressBytes(address);
  return !!bytes && allow.ranges.some((r) => r[0].length === bytes.length && inRange(bytes, r));
}

/** Whether the operator lists this host: the name itself (or under a `*.` entry), or an address in a listed range. */
export function hostListed(host: string, allow: PrivateDestinations): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return isAddress(bare) ? addressListed(bare, allow) : nameListed(bare, allow);
}

/** Why the board does not connect to this address for a company, or null: it is public, or the operator lists it. */
export function refuseDestination(address: string, allow: PrivateDestinations): string | null {
  const why = refuseAddress(address);
  return why && !addressListed(address, allow) ? why : null;
}

export const NOT_ALLOWED = "which this board's operator has not allowed";

/** The refusal of an address written in a URL, for a person to read. */
export function refusedLiteral(address: string, why: string): string {
  return `refused: ${address} is ${why}, ${NOT_ALLOWED}`;
}
