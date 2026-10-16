// The office's images (the plan's asset packs): a PNG per sprite mode and per
// room, content-addressed in the object store under the company. The company
// settings keep, per image name, the object's hash and its size, so the office
// knows what to load and the serving route what to fetch. Only this module
// writes `settings.officePack`; a company PATCH keeps what is there. Nothing
// deletes objects: a replaced image leaves its bytes, as an artifact does.
import {
  OFFICE_IMAGE_MAX_BYTES,
  OFFICE_IMAGE_NAME_RE,
  OfficePackSchema,
  sha256Hex,
  type ActorRef,
  type OfficeImage,
  type OfficePack,
} from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import type { ObjectStore } from "../storage/s3.js";

export function officeImageKey(companyId: string, sha256: string): string {
  return `companies/${companyId}/office/${sha256}`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's header, or null when the bytes are not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.byteLength < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export function officeImageName(value: unknown): string {
  if (typeof value !== "string" || !OFFICE_IMAGE_NAME_RE.test(value)) {
    throw new HttpError(400, "an image is sprite.<mode> or room.<department id>");
  }
  return value;
}

/** The pack as the settings hold it; an entry that does not parse is left out rather than trusted. */
export function officePackOf(settings: Record<string, unknown>): OfficePack {
  const parsed = OfficePackSchema.safeParse(settings.officePack ?? {});
  return parsed.success ? parsed.data : {};
}

interface SettingsRow {
  settings: Record<string, unknown>;
}

async function writePack(
  db: Db,
  companyId: string,
  actor: ActorRef,
  name: string,
  next: (pack: OfficePack) => OfficePack,
): Promise<Record<string, unknown>> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const cur = await ctx.client.query<SettingsRow>(
      "SELECT settings FROM companies WHERE id = $1 FOR UPDATE",
      [companyId],
    );
    const row = cur.rows[0];
    if (!row) throw notFound("company");
    const settings = { ...row.settings, officePack: next(officePackOf(row.settings)) };
    await ctx.client.query("UPDATE companies SET settings = $2::jsonb, updated_at = now() WHERE id = $1", [
      companyId,
      JSON.stringify(settings),
    ]);
    await ctx.emit(
      "company.updated",
      { kind: "company", id: companyId },
      { changes: ["officePack"], image: name },
    );
    return settings;
  });
  return result;
}

/** Store one image and record it in the pack; the same bytes land on the same key. */
export async function putOfficeImage(
  db: Db,
  companyId: string,
  actor: ActorRef,
  name: string,
  contentBase64: string,
  store: ObjectStore | null,
): Promise<Record<string, unknown>> {
  if (!store)
    throw new HttpError(413, "office images need an object store, and the board has none configured");
  const buf = Buffer.from(contentBase64, "base64");
  if (buf.byteLength > OFFICE_IMAGE_MAX_BYTES) {
    throw new HttpError(413, `the image is ${buf.byteLength} bytes; the limit is ${OFFICE_IMAGE_MAX_BYTES}`);
  }
  const size = pngSize(buf);
  if (!size) throw new HttpError(400, "the image is not a PNG");
  const sha256 = sha256Hex(buf);
  await store.put(officeImageKey(companyId, sha256), buf, "image/png");
  const image: OfficeImage = { sha256, width: size.width, height: size.height, bytes: buf.byteLength };
  return writePack(db, companyId, actor, name, (pack) => ({ ...pack, [name]: image }));
}

/** Forget an image; its bytes stay in the store. */
export async function deleteOfficeImage(
  db: Db,
  companyId: string,
  actor: ActorRef,
  name: string,
): Promise<Record<string, unknown>> {
  return writePack(db, companyId, actor, name, (pack) => {
    const { [name]: _gone, ...rest } = pack;
    return rest;
  });
}

/** The bytes of a named image, from the store. */
export async function officeImageBytes(
  db: Db,
  companyId: string,
  name: string,
  store: ObjectStore | null,
): Promise<{ image: OfficeImage; bytes: Buffer }> {
  const res = await db.query<SettingsRow>("SELECT settings FROM companies WHERE id = $1", [companyId]);
  const row = res.rows[0];
  if (!row) throw notFound("company");
  const image = officePackOf(row.settings)[name];
  if (!image) throw notFound("image");
  const bytes = store ? await store.get(officeImageKey(companyId, image.sha256)) : null;
  if (!bytes) throw notFound("image");
  return { image, bytes };
}
