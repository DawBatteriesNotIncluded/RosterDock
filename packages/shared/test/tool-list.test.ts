import { describe, expect, it } from "vitest";
import { codexReach, splitToolList, toolName } from "../src/index.js";

const WORKSPACE = ["Read(./**)", "Write(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)"];

describe("a department's tool list", () => {
  it("splits on commas and spaces, never inside a rule, and names the tool a rule is for", () => {
    expect(splitToolList("Bash(git diff:*), Read  Edit(./a,b/**)")).toEqual([
      "Bash(git diff:*)",
      "Read",
      "Edit(./a,b/**)",
    ]);
    expect(toolName("Edit(./a,b/**)")).toBe("Edit");
    expect(toolName("WebSearch")).toBe("WebSearch");
  });

  it("narrows nothing for Codex when there is no list", () => {
    const all = { ok: true, write: true, network: true, webSearch: true };
    expect(codexReach(null)).toEqual(all);
    expect(codexReach(undefined)).toEqual(all);
    expect(codexReach([])).toEqual(all);
  });

  it("refuses Codex a list that leaves out the shell, since Codex reads and runs everything through it", () => {
    for (const list of [WORKSPACE, ["Read", "Write", "WebSearch", "WebFetch"], ["mcp__rosterdock"]])
      expect(codexReach(list)).toEqual({
        ok: false,
        reason: "it reads files and runs commands only through its shell, and the list leaves out Bash",
      });
  });

  it("refuses Codex a list that allows only some shell commands: it cannot hold its shell to them", () => {
    expect(codexReach([...WORKSPACE, "Bash(npm test:*)", "Bash(git diff:*)"])).toEqual({
      ok: false,
      reason:
        "it cannot hold its shell to some commands, and the list allows only Bash(npm test:*), Bash(git diff:*)",
    });
    const many = ["Bash(a)", "Bash(b)", "Bash(c)", "Bash(d)"];
    expect(codexReach(many)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Bash\(c\) and more$/),
    });
  });

  it("reads the shell, writes, the network and web search from the list, rules or not", () => {
    // Read only: no write tool, so a read-only sandbox; nothing on the web.
    expect(codexReach(["Bash", "Read(./**)", "Grep(./**)"])).toEqual({
      ok: true,
      write: false,
      network: false,
      webSearch: false,
    });
    // A write tool in any form lets Codex write; the shell may be on a line with others, and PowerShell is one.
    expect(codexReach(["Read(./**),Edit(src/**) Bash"])).toMatchObject({ ok: true, write: true });
    expect(codexReach(["PowerShell", "NotebookEdit"])).toMatchObject({ ok: true, write: true });
    expect(codexReach(["Bash", "MultiEdit"])).toMatchObject({ ok: true, write: true });
    // WebSearch keeps Codex's search; WebFetch on its own keeps the network for its commands.
    expect(codexReach([...WORKSPACE, "Bash", "WebSearch", "WebFetch"])).toEqual({
      ok: true,
      write: true,
      network: true,
      webSearch: true,
    });
    // A WebFetch held to some sites keeps no network: Codex cannot hold its commands to them.
    expect(codexReach(["Bash", "WebFetch(domain:docs.example.com)"])).toMatchObject({
      ok: true,
      network: false,
      webSearch: false,
    });
  });
});
