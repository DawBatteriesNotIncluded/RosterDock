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

// The section heading after the range is the nearest line git found above the hunk, whatever it holds (a U+2028,
// a carriage return): `s`, so `.` takes those too.
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/s;
const NO_NEWLINE = "\\ No newline at end of file";

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A name as git quotes one (`"caf\303\251 \"x\".md"`: a quote, a backslash or a control character, and with
 * core.quotePath every byte past ASCII, escaped C's way, octal escapes being the UTF-8 bytes), read back from
 * `s` at `from`, which is its opening quote. Null where it is not one.
 */
function readQuoted(s: string, from: number): { name: string; end: number } | null {
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = from + 1; i < s.length; i++) {
    // By code point: an emoji is two UTF-16 units, each of which alone would encode as U+FFFD.
    const c = String.fromCodePoint(s.codePointAt(i)!);
    if (c === '"') return { name: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    if (c !== "\\") {
      bytes.push(...utf8.encode(c));
      i += c.length - 1;
      continue;
    }
    const next = s[++i];
    if (next !== undefined && next in C_ESCAPES) bytes.push(C_ESCAPES[next]!);
    else if (/^[0-7]{3}$/.test(s.slice(i, i + 3))) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else return null;
  }
  return null;
}

/**
 * A path as git prints it in a diff, without its `a/` or `b/` prefix and the tab git appends after a name with
 * a space in it, unquoted where git quoted it. Never trimmed: `README.md ` is not `README.md`.
 */
function cleanPath(raw: string): string {
  // A name with a tab in it is quoted, so a tab here is git's own.
  const p = raw.replace(/\t.*$/, "");
  return unprefixed(p.startsWith('"') ? (readQuoted(p, 0)?.name ?? p) : p);
}

function unprefixed(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

function pathsFromGitHeader(line: string): { a: string; b: string } | null {
  const rest = line.slice("diff --git ".length);
  // "diff --git a/x b/x" with one name both sides (the harvest diffs with --no-renames): split at the middle, as
  // git apply reads it, whatever spaces and " b/" the name holds. A stanza with no ---/+++ lines (an empty new
  // file, a binary one, a mode change) is named by this alone.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") {
    const [a, b] = [rest.slice(0, mid), rest.slice(mid + 1)];
    if (a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2))
      return { a: a.slice(2), b: b.slice(2) };
  }
  // "diff --git \"a/x\" \"b/x\"" where git quoted the names.
  if (rest.startsWith('"')) {
    const a = readQuoted(rest, 0);
    if (!a) return null;
    return { a: unprefixed(a.name), b: cleanPath(rest.slice(a.end + 1)) };
  }
  // "diff --git a/x b/x"; paths may contain spaces, so split on " b/" (or ' "b/') from the right.
  const quoted = rest.lastIndexOf(' "b/');
  const cut = quoted >= 0 ? quoted : rest.lastIndexOf(" b/");
  if (cut < 0) return null;
  return { a: cleanPath(rest.slice(0, cut)), b: cleanPath(rest.slice(cut + 1)) };
}

/**
 * A name in a diff as git prints it with core.quotePath false: quoted, C's way, where it holds a quote, a
 * backslash or a control character, as it is otherwise.
 */
export function quoteDiffPath(prefixed: string): string {
  if (!/["\\\u0000-\u001f\u007f]/.test(prefixed)) return prefixed;
  const named = Object.fromEntries(Object.entries(C_ESCAPES).map(([k, v]) => [v, k]));
  let out = "";
  for (const c of prefixed) {
    const code = c.charCodeAt(0);
    if (named[code] !== undefined && (code < 32 || c === '"' || c === "\\")) out += `\\${named[code]}`;
    else if (code < 32 || code === 127) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += c;
  }
  return `"${out}"`;
}

/** A diff that is not as git writes one: a line it would not print, a hunk longer than its header, a path outside the tree. */
export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffError";
  }
}

/** The lines git prints between a file's `diff --git` and its first hunk, besides the ones read for what they say. */
const METADATA = [
  "index ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
];

/** A path in the tree as git names one: not empty, not absolute, no `.`, `..` or `.git` part. */
function treePath(p: string): boolean {
  return (
    p !== "" &&
    !p.startsWith("/") &&
    p.split("/").every((part) => !["", ".", "..", ".git"].includes(part.toLowerCase()))
  );
}

/**
 * Parse a unified diff (as `git diff` prints it) into files, hunks and numbered lines. Strict where it matters:
 * a line git would not print in a file's stanza, a hunk longer than its header says, or a path that is not in
 * the tree throws a DiffError, so nothing reads past what it could not read. A hunk cut short is kept as it is;
 * applyFilePatch refuses it.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  // What the current hunk still has to come, by its @@ header: until then every line is one of its lines,
  // whatever it starts with (a deleted "-- comment" reads "--- comment").
  let oldLeft = 0;
  let newLeft = 0;
  // Past "GIT binary patch", the file's encoded bytes, until the next file.
  let binaryPayload = false;

  const named = () => newPath ?? oldPath ?? file?.path ?? "";
  const closeFile = () => {
    oldLeft = 0;
    newLeft = 0;
    binaryPayload = false;
    if (!file) return;
    if (file.status !== "deleted" && newPath && newPath !== "/dev/null") file.path = newPath;
    else if (file.status === "deleted" && oldPath && oldPath !== "/dev/null") file.path = oldPath;
    if (!treePath(file.path))
      throw new DiffError(`a path that is not in the repository: ${JSON.stringify(file.path)}`);
    files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const end = line === "" && i === lines.length - 1;
    if (file && hunk && (oldLeft > 0 || newLeft > 0) && !end) {
      const mark = line[0];
      if (mark === "+" && newLeft > 0) {
        hunk.lines.push({ kind: "add", old: null, new: newNo++, text: line.slice(1) });
        file.additions += 1;
        newLeft -= 1;
        continue;
      }
      if (mark === "-" && oldLeft > 0) {
        hunk.lines.push({ kind: "del", old: oldNo++, new: null, text: line.slice(1) });
        file.deletions += 1;
        oldLeft -= 1;
        continue;
      }
      if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) });
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      // Anything else: the hunk was cut short; what follows is read as below.
    }
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
    // Before the first file (a commit message, a cover note), and a binary file's encoded bytes.
    if (!file || binaryPayload) continue;
    if (line === NO_NEWLINE && hunk) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        index: file.hunks.length,
        header: line.replace(/ @@.*$/s, " @@"),
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
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      continue;
    }
    // A blank line between files, or the text's own end.
    if (line === "") continue;
    if (line.startsWith("@@")) throw new DiffError(`${named()}: a hunk header git does not write`);
    // Past a hunk's lines, only the next hunk or the next file.
    if (hunk) throw new DiffError(`${named()}: hunk ${hunk.index + 1} is longer than its header says`);
    if (line.startsWith("new file mode ")) file.status = "added";
    else if (line.startsWith("deleted file mode ")) file.status = "deleted";
    else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line === "GIT binary patch") {
      file.binary = true;
      binaryPayload = true;
    } else if (line.startsWith("--- ")) oldPath = cleanPath(line.slice(4));
    else if (line.startsWith("+++ ")) newPath = cleanPath(line.slice(4));
    else if (!METADATA.some((prefix) => line.startsWith(prefix)))
      throw new DiffError(`${named()}: a line git does not write in a diff`);
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
 * deleted lines exactly (the diff was taken from that base), and every hunk must
 * hold as many lines as its header counts (a diff cut short inside a hunk would
 * otherwise apply as a deletion), otherwise PatchError. Returns null for a deletion.
 */
export function applyFilePatch(base: string | null, file: DiffFile): string | null {
  if (file.binary) throw new PatchError(`${file.path}: binary files cannot be patched from a text diff`);
  // Every hunk whole, a deletion's too: one cut short is no record of what it removes.
  for (const hunk of file.hunks) {
    const oldCount = hunk.lines.filter((l) => l.kind !== "add").length;
    const newCount = hunk.lines.filter((l) => l.kind !== "del").length;
    if (oldCount !== hunk.oldLines || newCount !== hunk.newLines)
      throw new PatchError(`${file.path}: hunk ${hunk.index + 1} is incomplete; the diff was cut inside it`);
  }
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
    `diff --git ${quoteDiffPath(`a/${path}`)} ${quoteDiffPath(`b/${path}`)}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ ${quoteDiffPath(`b/${path}`)}`,
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
  const a = quoteDiffPath(`a/${path}`);
  const b = quoteDiffPath(`b/${path}`);
  return `diff --git ${a} ${b}\nnew file mode 100644\nBinary files /dev/null and ${b} differ\n`;
}

/** Text a diff contributes to the new tree: every added line, for content scans. */
export function addedText(files: DiffFile[]): string {
  const out: string[] = [];
  for (const f of files)
    for (const h of f.hunks) for (const l of h.lines) if (l.kind === "add") out.push(l.text);
  return out.join("\n");
}
