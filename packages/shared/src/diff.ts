// Unified diffs as data. Pure: parse what `git diff` prints into files, hunks
// and numbered lines (the review object anchors comments to these), apply a
// file's hunks to its base text (the pull request is built from the exact
// reviewed diff), and render a new-file diff (projects without a repository
// still get a review). No git, no filesystem.

export type DiffLineKind = "ctx" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file; null for added lines. */
  old: number | null;
  /** Line number in the new file; null for deleted lines. */
  new: number | null;
  text: string;
  /** This line is the last of its file and has no trailing newline. */
  noNewline?: boolean;
}

export interface DiffHunk {
  /** 0-based position within the file's hunks; comments anchor to it. */
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The function or section name git prints after the range, if any. */
  section: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted";

export interface DiffFile {
  /** Path in the new tree (the old path for a deletion). */
  path: string;
  status: DiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const NO_NEWLINE = "\\ No newline at end of file";

/** Strip git's `a/` or `b/` prefix and the tab git appends after paths containing spaces. */
function cleanPath(raw: string): string {
  let p = raw.replace(/\t.*$/, "").trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function pathsFromGitHeader(line: string): { a: string; b: string } | null {
  // "diff --git a/x b/x"; paths may contain spaces, so split on " b/" from the right.
  const rest = line.slice("diff --git ".length);
  const cut = rest.lastIndexOf(" b/");
  if (cut < 0) return null;
  return { a: cleanPath(rest.slice(0, cut)), b: cleanPath(rest.slice(cut + 1)) };
}

/** Parse a unified diff (as `git diff` prints it) into files, hunks and numbered lines. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldPath: string | null = null;
  let newPath: string | null = null;

  const closeFile = () => {
    if (!file) return;
    if (file.status !== "deleted" && newPath && newPath !== "/dev/null") file.path = newPath;
    else if (file.status === "deleted" && oldPath && oldPath !== "/dev/null") file.path = oldPath;
    files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      closeFile();
      const paths = pathsFromGitHeader(line);
      file = {
        path: paths?.b ?? paths?.a ?? "",
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      oldPath = paths?.a ?? null;
      newPath = paths?.b ?? null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = cleanPath(line.slice(4));
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        index: file.hunks.length,
        header: line.replace(/ @@.*$/, " @@"),
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: (m[5] ?? "").trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    if (line === NO_NEWLINE) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "+") {
      hunk.lines.push({ kind: "add", old: null, new: newNo++, text: body });
      file.additions += 1;
    } else if (mark === "-") {
      hunk.lines.push({ kind: "del", old: oldNo++, new: null, text: body });
      file.deletions += 1;
    } else if (mark === " " || line === "") {
      // An empty line inside a hunk is a context line whose text is empty.
      if (line === "" && i === lines.length - 1) continue;
      hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: body });
    }
    // Anything else (index lines, mode lines, similarity) is metadata.
  }
  closeFile();
  return files;
}

export function diffStats(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

interface TextLine {
  text: string;
  noNewline: boolean;
}

function splitLines(text: string): TextLine[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const trailing = parts[parts.length - 1] === "";
  if (trailing) parts.pop();
  return parts.map((t, i) => ({ text: t, noNewline: !trailing && i === parts.length - 1 }));
}

function joinLines(lines: TextLine[]): string {
  if (!lines.length) return "";
  const last = lines[lines.length - 1]!;
  return lines.map((l) => l.text).join("\n") + (last.noNewline ? "" : "\n");
}

/**
 * Apply one file's hunks to its base text. The base must match the context and
 * deleted lines exactly (the diff was taken from that base), otherwise PatchError.
 * Returns null for a deletion.
 */
export function applyFilePatch(base: string | null, file: DiffFile): string | null {
  if (file.binary) throw new PatchError(`${file.path}: binary files cannot be patched from a text diff`);
  if (file.status === "deleted") return null;
  const src = splitLines(base ?? "");
  const out: TextLine[] = [];
  let cursor = 0; // 0-based index into src
  for (const hunk of file.hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    // Hunks with oldLines = 0 sit AFTER line oldStart (git convention).
    const target = hunk.oldLines === 0 ? hunk.oldStart : start;
    if (target < cursor)
      throw new PatchError(`${file.path}: hunk ${hunk.index + 1} overlaps the previous hunk`);
    while (cursor < target) {
      const l = src[cursor];
      if (!l) throw new PatchError(`${file.path}: hunk ${hunk.index + 1} starts past the end of the file`);
      out.push(l);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        out.push({ text: line.text, noNewline: line.noNewline === true });
        continue;
      }
      const actual = src[cursor];
      if (!actual || actual.text !== line.text) {
        throw new PatchError(
          `${file.path}: hunk ${hunk.index + 1} does not match the base at line ${cursor + 1}`,
        );
      }
      cursor += 1;
      if (line.kind === "ctx") out.push({ text: line.text, noNewline: line.noNewline === true });
    }
  }
  while (cursor < src.length) out.push(src[cursor++]!);
  return joinLines(out);
}

/** A unified diff adding `path` with `content`, as git would print it for a new file. */
export function renderNewFileDiff(path: string, content: string): string {
  const lines = splitLines(content);
  const out = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@`,
  ];
  for (const l of lines) {
    out.push(`+${l.text}`);
    if (l.noNewline) out.push(NO_NEWLINE);
  }
  return `${out.join("\n")}\n`;
}

/** The stanza git prints for a new binary file; the parser marks it binary and the bytes travel as an artifact. */
export function renderBinaryFileDiff(path: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`;
}

/** Text a diff contributes to the new tree: every added line, for content scans. */
export function addedText(files: DiffFile[]): string {
  const out: string[] = [];
  for (const f of files)
    for (const h of f.hunks) for (const l of h.lines) if (l.kind === "add") out.push(l.text);
  return out.join("\n");
}
