// The stub engine follows the pack: declared outputs are written, and a
// research pack gets documents that cite a source, so the research review's
// sources check passes in demos without a model.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stubEngine } from "../src/engines/stub.js";

async function run(pack: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-stub-"));
  try {
    const result = await stubEngine.run({
      workdir: dir,
      pack,
      model: "stub",
      signal: new AbortController().signal,
      emit: () => {},
      onUsage: () => {},
      env: {},
      allowedTools: null,
      mcp: null,
    });
    const doc = await readFile(path.join(dir, "research.md"), "utf8");
    return { result, doc };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OUTPUTS = "## Expected outputs\n- research.md\n\n## Sandbox\n";

describe("stub engine", () => {
  it("writes a Sources section into documents when the pack asks for research", async () => {
    const plain = await run(`# Task\n\n${OUTPUTS}`);
    expect(plain.result.ok).toBe(true);
    expect(plain.doc).not.toContain("## Sources");
    const research = await run(`# Task\n\n## Research\nDocuments with sources.\n\n${OUTPUTS}`);
    expect(research.doc).toContain("## Sources\n- https://example.invalid/stub-source");
  });
});
