// A secret store the board can write to. Nothing here is stored by the board
// itself: a row keeps a NAME, and the value lives here, in the cluster's own
// Secrets or (dev and compose) in files. The one writer is the OAuth flow of
// a connection: the tokens it obtains land under the connection's name and
// are read back at call time, the way an env var name is resolved.

import { trimTrailingSlashes } from "@rosterdock/shared";

export type SecretData = Record<string, string>;

export interface SecretStore {
  readonly kind: "kubernetes" | "file";
  /** The data under `name`, or null when there is no such secret. */
  get(name: string): Promise<SecretData | null>;
  /** Create or replace the whole secret. */
  put(name: string, data: SecretData): Promise<void>;
  /** Forget it; nothing happens when it is already gone. */
  delete(name: string): Promise<void>;
}

/** The store answered, but not with what was asked. The message never carries a value. */
export class SecretStoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SecretStoreError";
    this.status = status;
  }
}

// A Kubernetes Secret name (DNS subdomain), which the file store honours too so a name is one name.
const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

export function assertSecretName(name: string): string {
  if (!NAME_RE.test(name)) throw new SecretStoreError(400, "not a secret name");
  return name;
}

/** Where a connection's OAuth tokens live. */
export function connectionSecretName(connectionId: string): string {
  return `rosterdock-connection-${connectionId.toLowerCase()}`;
}

/**
 * A connection's entry if it is this issuer's, else nothing: every write names the issuer whose client secret
 * and tokens it holds (`issuer`), so what one authorization server issued never reaches another, even when a
 * late write lands after the connection moved. An entry written before entries named one is the row's.
 */
export function entryFor(data: SecretData | null, issuer: string | null): SecretData | null {
  if (!data) return null;
  if (data.issuer === undefined) return data;
  return issuer !== null && trimTrailingSlashes(data.issuer) === trimTrailingSlashes(issuer) ? data : null;
}
