// Put each style pack's file in the build, so switching one on downloads
// nothing: for every STYLE_PACKS entry, fetch the file and its repository's
// licence at the pinned commit, refuse the file unless it hashes to the pin, and
// write styles/vendor/<id>.md (the bytes as published) and <id>.LICENSE (one
// line saying where both came from, then the licence as published). Nothing is
// written unless every pack checks out.
// Usage, from apps/board (it needs raw.githubusercontent.com):
//   node --import tsx scripts/vendor-styles.mts [--out <dir>]
// then commit apps/board/styles/vendor. Run it again whenever a pin in
// src/styles/catalog.ts moves; test/styles.test.ts fails until it has.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rawUrl, STYLE_PACKS, VENDOR_DIR, vendoredPath, type StylePack } from "../src/styles/catalog.js";

const LICENCE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"];
// What a licence file must say for the catalog's name for it to be believed.
const LICENCE_TEXT: Record<string, RegExp> = { MIT: /Permission is hereby granted, free of charge/ };

const outAt = process.argv.indexOf("--out");
const out = outAt > 0 ? path.resolve(process.argv[outAt + 1] ?? ".") : VENDOR_DIR;

async function get(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchPack(pack: StylePack) {
  const at = `${pack.source.repo} at ${pack.source.commit}`;
  const file = await get(rawUrl(pack));
  if (!file) throw new Error(`${pack.id}: ${pack.source.path} is not in ${at}`);
  const sha256 = createHash("sha256").update(file).digest("hex");
  if (sha256 !== pack.sha256)
    throw new Error(`${pack.id}: ${pack.source.path} hashes to ${sha256}, not the pinned ${pack.sha256}`);
  for (const name of LICENCE_FILES) {
    const licence = await get(rawUrl(pack, name));
    if (!licence) continue;
    const mark = LICENCE_TEXT[pack.source.license];
    if (mark && !mark.test(licence.toString("utf8")))
      throw new Error(
        `${pack.id}: ${name} in ${at} is not the ${pack.source.license} licence the catalog names`,
      );
    const note = `${pack.label}: ${pack.source.path} from https://github.com/${pack.source.repo} at ${pack.source.commit}, under the licence below (${name} at the same commit).\n\n`;
    return { pack, file, licence: Buffer.concat([Buffer.from(note, "utf8"), licence]), name };
  }
  throw new Error(`${pack.id}: no licence file in ${at} (tried ${LICENCE_FILES.join(", ")})`);
}

try {
  const packs = await Promise.all(STYLE_PACKS.map(fetchPack));
  mkdirSync(out, { recursive: true });
  for (const p of packs) {
    writeFileSync(vendoredPath(out, p.pack), p.file);
    writeFileSync(vendoredPath(out, p.pack, "LICENSE"), p.licence);
    console.log(`${p.pack.id}: ${p.file.length} bytes, the pinned file; licence from ${p.name}`);
  }
  console.log(`wrote ${out}; commit it`);
} catch (err) {
  console.error(`nothing written: ${(err as Error).message}`);
  process.exit(1);
}
