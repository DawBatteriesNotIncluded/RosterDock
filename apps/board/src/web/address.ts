// Which addresses the board connects to, once a name is resolved: every
// address it gets is checked (the rules are @rosterdock/shared's address.ts), so
// a name that points at the cluster, the pod itself or a cloud's metadata
// service is refused like the address would be. The web reader takes public
// addresses only; a company's destinations, the private ones the operator lists
// too (egress.ts).

import {
  addressListed,
  nameListed,
  NOT_ALLOWED,
  refuseAddress,
  refuseDestination,
  reservedFor,
  type PrivateDestinations,
} from "@rosterdock/shared";

export {
  addressListed,
  nameListed,
  NO_PRIVATE_DESTINATIONS,
  parsePrivateDestinations,
  refuseAddress,
  refuseDestination,
  refusedLiteral,
  type PrivateDestinations,
} from "@rosterdock/shared";

/** Every address a host name resolves to. */
export type Resolve = (host: string) => Promise<string[]>;

/** A name the board does not read at, with why: one of its addresses is not public, or it has none. */
export class RefusedAddress extends Error {}

/** Every address a name resolves to; a name with none, or that fails to resolve, is refused. */
async function resolved(resolve: Resolve, host: string): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new RefusedAddress(`${host} does not resolve${code ? ` (${code})` : ""}`);
  }
  if (!addresses.length) throw new RefusedAddress(`${host} does not resolve`);
  return addresses;
}

/**
 * A name's addresses, once every one of them is public: a name with one address the board must not reach is
 * refused whole, since the connection could use any of them. Throws RefusedAddress with the reason.
 */
export async function publicAddresses(resolve: Resolve, host: string): Promise<string[]> {
  const addresses = await resolved(resolve, host);
  for (const a of addresses) {
    const why = refuseAddress(a);
    if (why)
      throw new RefusedAddress(`${host} resolves to ${a}, ${why}; the board reads only public addresses`);
  }
  return addresses;
}

/**
 * A name's addresses, once the board may connect to every one of them for a company: each is public or in a
 * range the operator lists, or the operator lists the name. Throws RefusedAddress with the reason.
 */
export async function reachableAddresses(
  resolve: Resolve,
  host: string,
  allow: PrivateDestinations,
): Promise<string[]> {
  const addresses = await resolved(resolve, host);
  if (nameListed(host, allow)) {
    // A listed name is trusted with its addresses, except one in a range the operator gave another company
    // alone, unless this company may reach that address itself.
    const reserved = { names: [], ranges: reservedFor(allow), entries: [] };
    for (const a of addresses)
      if (addressListed(a, reserved) && !addressListed(a, allow))
        throw new RefusedAddress(
          `refused: ${host} resolves to an address this board's operator gave another company alone`,
        );
    return addresses;
  }
  // The kind of address, not the address: a company learns nothing of the network behind the board.
  for (const a of addresses) {
    const why = refuseDestination(a, allow);
    if (why) throw new RefusedAddress(`refused: ${host} resolves to ${why}, ${NOT_ALLOWED}`);
  }
  return addresses;
}
