import { assertNoRawSecrets, RawSecretError } from "@rosterdock/shared";
import type { ZodType } from "zod";
import { HttpError } from "./http-error.js";

/** Parse a request body with a shared schema, then run the raw-secret guard. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, "invalid request body", parsed.error.issues);
  }
  try {
    assertNoRawSecrets(parsed.data);
  } catch (err) {
    if (err instanceof RawSecretError) throw new HttpError(422, err.message, err.findings);
    throw err;
  }
  return parsed.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a uuid, as ids are. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function uuidParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new HttpError(400, `${name} must be a uuid`);
  return value;
}
