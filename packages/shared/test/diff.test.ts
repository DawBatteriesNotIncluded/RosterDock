// The parser and applier against a recorded `git diff --cached --no-renames`
// (fixtures/changes.diff) with the base and resulting file contents recorded
// alongside it. Nothing here runs git.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addedText,
  applyFilePatch,
  DiffError,
  diffStats,
  parseUnifiedDiff,
  PatchError,
  renderBinaryFileDiff,
  renderNewFileDiff,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(path.join(here, "fixtures", name), "utf8");
const diff = read("changes.diff");
const base = JSON.parse(read("diff-base.json")) as Record<string, string | null>;
const after = JSON.parse(read("diff-after.json")) as Record<string, string | null>;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(diff);

  it("finds every file with its status, including binary and paths with spaces", () => {
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["docs/old.md", "deleted", false],
      ["docs/vms-architecture.md", "added", false],
      ["logo.bin", "modified", true],
      ["notail.txt", "added", false],
      ["notes dir/plain.txt", "modified", false],
      ["workflows/vms-digest.json", "modified", false],
    ]);
  });

  it("numbers lines on both sides and counts additions and deletions", () => {
    const json = files.find((f) => f.path === "workflows/vms-digest.json")!;
    expect(json.hunks).toHaveLength(2);
    expect(json.hunks[0]!.header).toBe("@@ -1,7 +1,9 @@");
    expect(json.hunks[1]!).toMatchObject({ index: 1, oldStart: 34, oldLines: 6, newStart: 36, newLines: 7 });
    const del = json.hunks[0]!.lines.find((l) => l.kind === "del")!;
    expect(del).toMatchObject({ old: 4, new: null, text: '    "executionOrder": "v0",' });
    const added = json.hunks[0]!.lines.filter((l) => l.kind === "add").map((l) => l.new);
    expect(added).toEqual([4, 5, 6]);
    const ctx = json.hunks[1]!.lines[0]!;
    expect(ctx).toMatchObject({ kind: "ctx", old: 34, new: 36 });
    expect(json.additions).toBe(4);
    expect(json.deletions).toBe(1);
    expect(diffStats(files)).toEqual({ files: 6, additions: 14, deletions: 6 });
  });

  it("marks lines without a trailing newline", () => {
    const notail = files.find((f) => f.path === "notail.txt")!;
    expect(notail.hunks[0]!.lines[0]).toMatchObject({ text: "tail", noNewline: true });
    const plain = files.find((f) => f.path === "notes dir/plain.txt")!;
    const lastDel = plain.hunks[0]!.lines.filter((l) => l.kind === "del").at(-1)!;
    expect(lastDel.noNewline).toBe(true);
    const lastAdd = plain.hunks[0]!.lines.filter((l) => l.kind === "add").at(-1)!;
    expect(lastAdd.noNewline).toBeUndefined();
  });

  it("collects the added text for content scans", () => {
    expect(addedText(files)).toContain('"active": false');
    expect(addedText(files)).not.toContain("to be removed");
  });

  it("tolerates an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("applyFilePatch", () => {
  const files = parseUnifiedDiff(diff);

  it("reproduces every recorded result from the recorded base", () => {
    for (const f of files) {
      if (f.binary) continue;
      expect(applyFilePatch(base[f.path] ?? null, f), f.path).toBe(after[f.path]);
    }
  });

  it("refuses a base that does not match the context", () => {
    const json = files.find((f) => f.path === "workflows/vms-digest.json")!;
    expect(() => applyFilePatch(base[json.path]!.replace("Node 28", "Node 28b"), json)).toThrow(PatchError);
    expect(() => applyFilePatch(null, json)).toThrow(/does not match/);
  });

  it("refuses a hunk cut short, which would otherwise apply as a deletion", () => {
    const json = files.find((f) => f.path === "workflows/vms-digest.json")!;
    const hunk = json.hunks[0]!;
    // The diff ends before the hunk's added lines: what a cut by length used to leave.
    const cut = { ...json, hunks: [{ ...hunk, lines: hunk.lines.filter((l) => l.kind !== "add") }] };
    expect(() => applyFilePatch(base[json.path]!, cut)).toThrow(/hunk 1 is incomplete/);
  });

  it("refuses binary files", () => {
    const bin = files.find((f) => f.binary)!;
    expect(() => applyFilePatch("x", bin)).toThrow(/binary/);
  });
});

describe("renderNewFileDiff", () => {
  it("round-trips through the parser and applier, with and without a trailing newline", () => {
    for (const content of ["# Notes\n\nOne line.\n", "tail", "", "a\n"]) {
      const text = renderNewFileDiff("notes/plan.md", content);
      const [file] = parseUnifiedDiff(text);
      if (content === "") {
        expect(file!.hunks[0]!.lines).toEqual([]);
        continue;
      }
      expect(file).toMatchObject({ path: "notes/plan.md", status: "added" });
      expect(applyFilePatch(null, file!)).toBe(content);
    }
  });
});

describe("names git quotes", () => {
  // One change recorded twice from git (fixtures/quoted-names): with core.quotePath, git's default, which escapes
  // every byte past ASCII, and without it, as the harvest diffs. A name with a quote and a tab is quoted either
  // way; one with a trailing space, beside the README.md it is not, is quoted neither way.
  it("reads every name back as it is, however git printed it", () => {
    for (const recorded of ["quote-path.diff", "no-quote-path.diff"]) {
      const files = parseUnifiedDiff(read(`quoted-names/${recorded}`));
      expect(files.map((f) => [f.path, f.status])).toEqual([
        ["README.md ", "added"],
        ["café.md", "modified"],
        ["résumé.md", "added"],
        ['say "hi"\tnow.md', "added"],
      ]);
    }
  });

  it("renders a name git would quote as git does, and reads it back", () => {
    for (const name of ['say "hi"\tnow.md', "back\\slash.md", "new\nline.md", "café.md", "README.md "]) {
      expect(parseUnifiedDiff(renderNewFileDiff(name, "x\n"))[0]?.path).toBe(name);
      expect(parseUnifiedDiff(renderBinaryFileDiff(name))[0]?.path).toBe(name);
    }
  });
});

describe("lines that read like headers", () => {
  // Recorded from git (fixtures/header-like-lines.diff): a deleted SQL comment ("-- old comment" reads
  // "--- old comment"), an added Lua line "++ x" ("+++ x"), a deleted file holding "-- a/config.sql", a new file
  // holding "++ b/../../x", and an empty new file under "src/Plan b/" beside a root __init__.py.
  const files = parseUnifiedDiff(read("header-like-lines.diff"));

  it("keeps every hunk's lines in it, and every file under its own name", () => {
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["drop.sql", "deleted", 0, 2],
      ["inc.lua", "modified", 1, 0],
      ["notes.md", "added", 1, 0],
      ["schema.sql", "modified", 0, 1],
      ["src/Plan b/__init__.py", "added", 0, 0],
    ]);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(["-- a/config.sql", "select 1;"]);
    expect(files[1]!.hunks[0]!.lines.find((l) => l.kind === "add")?.text).toBe("++ x");
    expect(files[2]!.hunks[0]!.lines.map((l) => l.text)).toEqual(["++ b/../../x"]);
    expect(files[3]!.hunks[0]!.lines.find((l) => l.kind === "del")?.text).toBe("-- old comment");
  });

  it("applies each file's hunks to what it was", () => {
    expect(applyFilePatch("create table a;\n-- old comment\ncreate table b;\n", files[3]!)).toBe(
      "create table a;\ncreate table b;\n",
    );
    expect(applyFilePatch("local x = 1\nreturn x\n", files[1]!)).toBe("local x = 1\n++ x\nreturn x\n");
    expect(applyFilePatch(null, files[2]!)).toBe("++ b/../../x\n");
  });
});

describe("a diff git did not write", () => {
  const stanza = (body: string[]) =>
    ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", ...body, ""].join("\n");

  it("reads a hunk whose heading holds a line separator, its '-- x' deletion and the line it adds", () => {
    // Recorded from git (fixtures/line-separator-heading.diff): the heading git took for the hunk is the line
    // above it, "section\u2028heading"; read with `.` alone the @@ line went unread, and the hunk with it.
    const [file] = parseUnifiedDiff(read("line-separator-heading.diff"));
    expect(file).toMatchObject({ path: "settings.sql", status: "modified", additions: 1, deletions: 1 });
    expect(file!.hunks[0]!.section).toBe("section\u2028heading");
    expect(file!.hunks[0]!.lines.find((l) => l.kind === "del")?.text).toBe("-- x");
    expect(addedText([file!])).toContain('api_key = "not-a-real-value-123"');
  });

  it("reads a quoted name with an emoji in it as it is", () => {
    for (const name of ['say "😀".md', "tab\t😀🚀.md"])
      expect(parseUnifiedDiff(renderNewFileDiff(name, "x\n"))[0]?.path).toBe(name);
  });

  it("refuses what git would not print: a hunk header it cannot read, a hunk longer than its header, a stray line", () => {
    expect(() => parseUnifiedDiff(stanza(["@@ -1 +1 @ broken", "-a", "+b"]))).toThrow(DiffError);
    // One line each way by the header, then a "--- " line that would rename the file.
    expect(() => parseUnifiedDiff(stanza(["@@ -1 +1 @@", "-a", "+b", "--- a/../../etc/passwd"]))).toThrow(
      "x.md: hunk 1 is longer than its header says",
    );
    expect(() => parseUnifiedDiff(stanza(["what is this", "@@ -1 +1 @@", "-a", "+b"]))).toThrow(
      "x.md: a line git does not write in a diff",
    );
    // A binary patch's encoded bytes are its own.
    const binary = [
      "diff --git a/x.png b/x.png",
      "new file mode 100644",
      "index 0000000..e69de29",
      "GIT binary patch",
      "literal 3",
      "KcmZQz00932",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
    ];
    expect(parseUnifiedDiff(binary.join("\n"))).toMatchObject([{ path: "x.png", binary: true }]);
  });

  it("refuses a path that is not in the repository", () => {
    for (const bad of [
      "../../outside.md",
      "/etc/passwd",
      ".git/config",
      "docs/../../x",
      "a//b",
      "./x",
      ".GIT/hooks/x",
    ]) {
      const text = [
        `diff --git a/${bad} b/${bad}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${bad}`,
        "@@ -0,0 +1 @@",
        "+x",
        "",
      ].join("\n");
      expect(() => parseUnifiedDiff(text), bad).toThrow(DiffError);
    }
  });

  it("deletes no file whose hunks were cut short", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/x.md b/x.md",
        "deleted file mode 100644",
        "--- a/x.md",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-a",
        "",
      ].join("\n"),
    );
    expect(() => applyFilePatch("a\nb\nc\n", file!)).toThrow(PatchError);
  });
});
