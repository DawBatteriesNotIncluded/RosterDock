// Which addresses the board reads the web at: public ones only. A name is
// resolved and every address it gets is checked, so a name that points at the
// cluster, the pod itself or a cloud's metadata service is refused like the
// address would be. IPv4 refuses the special-purpose ranges (RFC 6890 and its
// updates); IPv6 allows only global unicast (2000::/3), less its documentation,
// benchmarking and tunnel ranges, and reads the IPv4 inside a mapped, NAT64 or
// 6to4 address as that IPv4.

import { isIPv4, isIPv6 } from "node:net";

/** Every address a host name resolves to. */
export type Resolve = (host: string) => Promise<string[]>;

/** A name the board does not read at, with why: one of its addresses is not public, or it has none. */
export class RefusedAddress extends Error {}

type Range = [prefix: number[], bits: number, why: string];

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

function inRange(bytes: number[], [prefix, bits]: Range): boolean {
  for (let i = 0; i < bits; i += 8) {
    const take = Math.min(8, bits - i);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((bytes[i / 8]! & mask) !== (prefix[i / 8] ?? 0)) return false;
  }
  return true;
}

function v4Bytes(address: string): number[] | null {
  if (!isIPv4(address)) return null;
  return address.split(".").map(Number);
}

/** An IPv6 address as its 16 bytes (a zone and an IPv4 tail allowed), or null when it is not one. */
function v6Bytes(address: string): number[] | null {
  let s = address.split("%")[0]!;
  if (!isIPv6(s)) return null;
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

/**
 * A name's addresses, once every one of them is public: a name with one address the board must not reach is
 * refused whole, since the connection could use any of them. Throws RefusedAddress with the reason.
 */
export async function publicAddresses(resolve: Resolve, host: string): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new RefusedAddress(`${host} does not resolve${code ? ` (${code})` : ""}`);
  }
  if (!addresses.length) throw new RefusedAddress(`${host} does not resolve`);
  for (const a of addresses) {
    const why = refuseAddress(a);
    if (why)
      throw new RefusedAddress(`${host} resolves to ${a}, ${why}; the board reads only public addresses`);
  }
  return addresses;
}
