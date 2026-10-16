// Where an artifact's text lives: in its row up to the inline limit, else in
// the object store under a key of the company, the run and the content's hash.

import type { ObjectStore } from "./s3.js";

export function artifactObjectKey(companyId: string, runId: string, sha256: string): string {
  return `companies/${companyId}/runs/${runId}/${sha256}`;
}

/**
 * The artifact's text: the row's content, or the object the row points at.
 * Null when there is no row, when the object is gone, or when the row points
 * at an object and this board has no store to read it from.
 */
export async function artifactText(
  store: ObjectStore | null,
  row: { content: string | null; object_key: string | null } | null,
): Promise<string | null> {
  if (!row) return null;
  if (row.content !== null) return row.content;
  if (!row.object_key || !store) return null;
  const bytes = await store.get(row.object_key);
  return bytes ? bytes.toString("utf8") : null;
}

/**
 * The artifact's bytes: a text row decoded from utf8, a binary row from its
 * base64, or the object as stored. Null as artifactText is.
 */
export async function artifactBytes(
  store: ObjectStore | null,
  row: { content: string | null; object_key: string | null; encoding?: string | null } | null,
): Promise<Buffer | null> {
  if (!row) return null;
  if (row.content !== null) return Buffer.from(row.content, row.encoding === "base64" ? "base64" : "utf8");
  if (!row.object_key || !store) return null;
  return store.get(row.object_key);
}
