// A company's style packs: which are on, at what level, and the text a
// teammate's brief carries. Switching a pack on takes its file from the build
// (styles/vendor) when that copy hashes to the pin, and otherwise downloads it
// once at the pinned commit and refuses it unless it hashes to the pin; the text
// is kept for the company, so switching off and on again reads nothing. The
// download goes through the board's egress (web/egress.ts) like a company's
// connections: a public address only, every redirect hop checked again.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ActorRef } from "@rosterdock/shared";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { egressFetch, readCapped, type Egress } from "../web/egress.js";
import { rawUrl, STYLE_PACKS, vendoredPath, type StyleLevel, type StylePack } from "./catalog.js";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;

interface StyleRow {
  pack: string;
  enabled: boolean;
  level: string | null;
  sha256: string;
  fetched_at: Date;
}

export interface StyleDeps {
  db: Db;
  /** How the file is downloaded; tests inject its transport and resolver. */
  egress: Egress;
  catalog: readonly StylePack[];
  /** Where the build carries the packs' files (catalog.ts VENDOR_DIR); null for none. */
  vendorDir: string | null;
}

/** What a brief carries for one pack that is on. */
export interface HouseStyle {
  id: string;
  label: string;
  applies: "code" | "replies";
  level: string | null;
  body: string;
}

/** A skill file's YAML front matter is for the host that loads skills, not for the teammate. */
export function stripFrontMatter(text: string): string {
  const t = text.replace(/^﻿/, "");
  if (!/^---\r?\n/.test(t)) return t.trim();
  const end = t.indexOf("\n---", 3);
  if (end < 0) return t.trim();
  const after = t.indexOf("\n", end + 4);
  return (after < 0 ? "" : t.slice(after + 1)).trim();
}

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The pack's file as the build carries it, when it is there and is the pinned one; anything else is ignored. */
async function vendored(pack: StylePack, dir: string | null): Promise<Buffer | null> {
  if (!dir) return null;
  const bytes = await readFile(vendoredPath(dir, pack)).catch(() => null);
  return bytes && bytes.length <= MAX_BYTES && sha256Of(bytes) === pack.sha256 ? bytes : null;
}

export async function listStyles(deps: Pick<StyleDeps, "db" | "catalog" | "vendorDir">, companyId: string) {
  const rows = (
    await deps.db.query<StyleRow>(
      "SELECT pack, enabled, level, sha256, fetched_at FROM company_style_packs WHERE company_id = $1",
      [companyId],
    )
  ).rows;
  const bundled = await Promise.all(deps.catalog.map(async (p) => !!(await vendored(p, deps.vendorDir))));
  return deps.catalog.map((p, i) => {
    const row = rows.find((r) => r.pack === p.id);
    return {
      id: p.id,
      label: p.label,
      what: p.what,
      applies: p.applies,
      levels: p.levels,
      level: row?.level ?? p.defaultLevel,
      enabled: !!row?.enabled,
      source: { ...p.source, url: rawUrl(p) },
      /** The build carries the pinned file, so switching on reaches no network. */
      bundled: bundled[i]!,
      fetchedAt: row?.fetched_at.toISOString() ?? null,
    };
  });
}

async function download(pack: StylePack, egress: Egress): Promise<{ sha256: string; body: string }> {
  const url = rawUrl(pack);
  let res: Response;
  try {
    res = await egressFetch(egress, { redirect: "follow", timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES + 1 })(
      url,
    );
  } catch (err) {
    throw new HttpError(
      502,
      `could not download ${pack.label} from ${pack.source.repo}: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(502, `could not download ${pack.label} from ${pack.source.repo}: HTTP ${res.status}`);
  }
  let read: Awaited<ReturnType<typeof readCapped>>;
  try {
    read = await readCapped(res, MAX_BYTES);
  } catch (err) {
    throw new HttpError(
      502,
      `could not download ${pack.label} from ${pack.source.repo}: ${(err as Error).message}`,
    );
  }
  if (read.cut) throw new HttpError(502, `${pack.label} is larger than a style file should be`);
  const bytes = Buffer.from(read.bytes);
  const sha256 = sha256Of(bytes);
  if (sha256 !== pack.sha256)
    throw new HttpError(
      502,
      `${pack.label} at ${pack.source.commit.slice(0, 7)} is not the file RosterDock pinned (sha256 ${sha256.slice(0, 12)}…); nothing was switched on`,
    );
  return { sha256, body: stripFrontMatter(bytes.toString("utf8")) };
}

/** The pinned file: the build's copy, or a download that must hash to the pin. */
async function packFile(pack: StylePack, deps: StyleDeps): Promise<{ sha256: string; body: string }> {
  const local = await vendored(pack, deps.vendorDir);
  if (local) return { sha256: pack.sha256, body: stripFrontMatter(local.toString("utf8")) };
  return download(pack, deps.egress);
}

/** Switch a pack on or off, or change its level. The first switch on reads and checks the file. */
export async function setStyle(
  deps: StyleDeps,
  companyId: string,
  actor: ActorRef,
  packId: string,
  input: { enabled: boolean; level?: StyleLevel | undefined },
) {
  const pack = deps.catalog.find((p) => p.id === packId);
  if (!pack) throw notFound("style pack");
  if (input.level && !pack.levels?.includes(input.level))
    throw new HttpError(400, `${pack.label} has no level ${input.level}`);
  const row = (
    await deps.db.query<StyleRow>(
      "SELECT pack, enabled, level, sha256, fetched_at FROM company_style_packs WHERE company_id = $1 AND pack = $2",
      [companyId, pack.id],
    )
  ).rows[0];
  if (!row && !input.enabled) return;
  // Read once per pin: a pack last kept at another pin is read again at this one.
  const file = input.enabled && (!row || row.sha256 !== pack.sha256) ? await packFile(pack, deps) : null;
  const level = input.level ?? (row?.level as StyleLevel | null) ?? pack.defaultLevel;
  await mutate(deps.db, companyId, actor, async (ctx) => {
    await ctx.client.query(
      `INSERT INTO company_style_packs (company_id, pack, enabled, level, sha256, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, pack) DO UPDATE SET enabled = EXCLUDED.enabled, level = EXCLUDED.level,
         sha256 = CASE WHEN $7 THEN EXCLUDED.sha256 ELSE company_style_packs.sha256 END,
         body = CASE WHEN $7 THEN EXCLUDED.body ELSE company_style_packs.body END,
         fetched_at = CASE WHEN $7 THEN now() ELSE company_style_packs.fetched_at END,
         updated_at = now()`,
      [
        companyId,
        pack.id,
        input.enabled,
        level,
        file?.sha256 ?? row!.sha256,
        file?.body ?? "",
        file !== null,
      ],
    );
    await ctx.emit(
      "company.updated",
      { kind: "company", id: companyId },
      { changes: ["style"], pack: pack.id, enabled: input.enabled, level },
    );
  });
}

/** The packs that are on for a company, as a brief carries them, in catalog order. */
export async function houseStyleFor(
  db: Queryable,
  companyId: string,
  catalog: readonly StylePack[] = STYLE_PACKS,
): Promise<HouseStyle[]> {
  const rows = (
    await db.query<{ pack: string; level: string | null; body: string }>(
      "SELECT pack, level, body FROM company_style_packs WHERE company_id = $1 AND enabled",
      [companyId],
    )
  ).rows;
  return catalog.flatMap((p) => {
    const row = rows.find((r) => r.pack === p.id);
    return row && row.body.trim()
      ? [{ id: p.id, label: p.label, applies: p.applies, level: p.levels ? row.level : null, body: row.body }]
      : [];
  });
}
