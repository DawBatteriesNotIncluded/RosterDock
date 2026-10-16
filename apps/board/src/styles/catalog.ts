// Style packs a company can switch on in Settings: other people's published
// rule files that change how teammates write. Each is pinned to a commit and the
// file's hash below, so the upstream can change without a teammate reading
// something nobody chose. scripts/vendor-styles.mts puts the pinned files and
// their licences in the build (VENDOR_DIR); nothing in the source carries their
// text. The framing each pack gets in a teammate's brief is RosterDock's own (runs/pack.ts).

import path from "node:path";
import { fileURLToPath } from "node:url";

export const STYLE_LEVELS = ["lite", "full", "ultra"] as const;
export type StyleLevel = (typeof STYLE_LEVELS)[number];

export interface StylePack {
  id: string;
  label: string;
  /** One sentence for Settings. */
  what: string;
  /** What it governs in a brief: the code a teammate writes, or what it says. */
  applies: "code" | "replies";
  /** Levels a person picks from, and the one RosterDock starts with; none when the pack has no levels. */
  levels: readonly StyleLevel[] | null;
  defaultLevel: StyleLevel | null;
  source: {
    home: string;
    repo: string;
    commit: string;
    path: string;
    license: string;
  };
  /** sha256 of the file at that commit, as downloaded. */
  sha256: string;
}

export const STYLE_PACKS: readonly StylePack[] = [
  {
    id: "ponytail",
    label: "Minimal code (Ponytail)",
    what: "Before writing code, reuse what exists, then the standard library, then the platform; write the least code that works, keeping validation, error handling, security and a check.",
    applies: "code",
    levels: null,
    defaultLevel: null,
    source: {
      home: "https://github.com/dietrichgebert/ponytail",
      repo: "dietrichgebert/ponytail",
      commit: "e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156",
      path: "AGENTS.md",
      license: "MIT",
    },
    sha256: "b57f736a83ddab7111d752008c3e131a157e646a6b47c9eb223f076c494685a8",
  },
  {
    id: "caveman",
    label: "Terse replies (Caveman)",
    what: "Messages, handovers and review comments drop filler, hedging and pleasantries; code, commands and errors stay exact. Delivered files are written normally.",
    applies: "replies",
    levels: ["lite", "full", "ultra"],
    // lite keeps full sentences: what teammates say is read by people.
    defaultLevel: "lite",
    source: {
      home: "https://caveman.so",
      repo: "JuliusBrussee/caveman",
      commit: "2fd153c67988e980fb0b2455c90832159a6a5a25",
      path: "plugins/caveman/skills/caveman/SKILL.md",
      license: "MIT",
    },
    sha256: "0bf09a0a9a017d004a81d4b693e5a2d830e1a28230a5885df773e1ed9c0571cc",
  },
];

/** A file of the pack's repository at the pinned commit: its style file unless another is named. */
export function rawUrl(pack: StylePack, file: string = pack.source.path): string {
  return `https://raw.githubusercontent.com/${pack.source.repo}/${pack.source.commit}/${file}`;
}

/** Where the build carries the packs' files, as scripts/vendor-styles.mts writes them: apps/board/styles/vendor. */
export const VENDOR_DIR = fileURLToPath(new URL("../../styles/vendor/", import.meta.url));

/** A pack's file in a vendor directory (`<id>.md`, the bytes as published), or its licence (`<id>.LICENSE`). */
export function vendoredPath(dir: string, pack: StylePack, kind: "md" | "LICENSE" = "md"): string {
  return path.join(dir, `${pack.id}.${kind}`);
}
