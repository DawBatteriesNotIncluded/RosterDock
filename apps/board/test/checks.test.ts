// Pure review checks over parsed diffs. No database.
import { parseUnifiedDiff, renderNewFileDiff } from "@rosterdock/shared";
import { describe, expect, it } from "vitest";
import {
  evaluationCheck,
  outputsCheck,
  scoreCriteria,
  secretsCheck,
  sourcesCheck,
  testsCheck,
  weightedScore,
} from "../src/reviews/checks.js";
import { extractSourceUrls, refuseSourceUrl, sourceFetcher, summarisePage } from "../src/reviews/sources.js";

describe("sourcesCheck", () => {
  it("passes documents with a Sources section or links, names the ones without, and is not run with none", () => {
    expect(sourcesCheck([]).ok).toBeNull();
    const ok = sourcesCheck([
      {
        path: "research.md",
        content: "# Findings\n\nGong exports calls.\n\n## Sources\n- https://gong.io/docs\n",
      },
      { path: "notes.md", content: "See https://example.com/spec for the spec.\n" },
      { path: "refs.md", content: "## References\n1. The VMS intake workflow\n" },
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.title).toBe("All 3 documents cite sources");
    const bad = sourcesCheck([
      { path: "research.md", content: "# Findings\n\nTrust me.\n\n## Sources\n" },
      { path: "good.md", content: "## Sources\n- the intake workflow\n" },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.title).toBe("A document cites no sources: research.md");
    expect(bad.detail).toEqual({
      documents: ["research.md", "good.md"],
      missing: ["research.md"],
      cited: ["good.md"],
      sources: [],
    });
  });
});

const clean = parseUnifiedDiff(
  renderNewFileDiff("notes/credentials.md", "# Credentials (names only)\n\n- VMS_SMTP · outbound mail\n"),
);

describe("sources fetched", () => {
  it("finds the links in the documents, once each, capped, and refuses what the board must not reach", () => {
    expect(
      extractSourceUrls([
        {
          content:
            "See https://gong.io/docs/calls. And https://gong.io/docs/calls again, plus http://example.org/a)",
        },
        { content: "- https://example.org/b\n" },
      ]),
    ).toEqual(["https://gong.io/docs/calls", "http://example.org/a", "https://example.org/b"]);
    expect(extractSourceUrls([{ content: null }])).toEqual([]);
    expect(refuseSourceUrl("https://gong.io/docs")).toBeNull();
    expect(refuseSourceUrl("ftp://gong.io/docs")).toMatch(/ftp links are not fetched/);
    expect(refuseSourceUrl("http://localhost:3000/api")).toMatch(/localhost/);
    expect(refuseSourceUrl("http://10.0.0.1/admin")).toMatch(/literal address/);
    expect(refuseSourceUrl("http://[::1]/")).toMatch(/literal address/);
    expect(refuseSourceUrl("http://board.rosterdock.internal/")).toMatch(/internal name/);
    expect(refuseSourceUrl("http://postgres/")).toMatch(/internal name/);
    expect(refuseSourceUrl("https://user:pw@example.org/")).toMatch(/credentials/);
    expect(refuseSourceUrl("not a url")).toBe("not a URL");
  });

  it("summarises a page as its title and text, without scripts, styles or markup", () => {
    const page = summarisePage(
      "text/html; charset=utf-8",
      "<html><head><title>Calls &amp; API</title><style>p{}</style></head><body><script>x()</script><h1>Calls</h1><p>GET /v2/calls lists calls.</p><!-- c --><p>Paged.</p></body></html>",
    );
    expect(page.title).toBe("Calls & API");
    expect(page.excerpt).toBe("Calls\nGET /v2/calls lists calls.\nPaged.");
    expect(summarisePage("text/plain", "  plain   text\n\n\n more ").excerpt).toBe("plain text\nmore");
  });

  it("fetches each source once with the guard on every hop, and the check reads the answers", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      expect(init?.redirect).toBe("manual");
      if (url === "https://gong.io/docs/calls")
        return new Response(
          "<html><title>Calls API</title><body><p>GET /v2/calls lists calls.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        );
      if (url === "https://gong.io/moved")
        return new Response(null, { status: 302, headers: { location: "/docs/calls" } });
      if (url === "https://gong.io/inside")
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/admin" } });
      if (url === "https://gong.io/image")
        return new Response("...", { status: 200, headers: { "content-type": "image/png" } });
      if (url === "https://gong.io/down") throw new Error("ECONNREFUSED");
      return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    };
    const fetched = await sourceFetcher({ fetch: fake }).fetch([
      "https://gong.io/docs/calls",
      "https://gong.io/moved",
      "https://gong.io/inside",
      "https://gong.io/image",
      "https://gong.io/down",
      "https://gong.io/gone",
      "http://localhost/secret",
    ]);
    expect(fetched.map((s) => [s.ok, s.status, s.title, s.note])).toEqual([
      [true, 200, "Calls API", null],
      [true, 200, "Calls API", null],
      [false, null, null, "redirected to http://10.0.0.1/admin: a literal address is not fetched"],
      [false, 200, null, "not text (image/png)"],
      [false, null, null, "could not be reached: ECONNREFUSED"],
      [false, 404, null, "answered 404"],
      [false, null, null, "localhost is not fetched"],
    ]);
    expect(fetched[0]!.excerpt).toBe("GET /v2/calls lists calls.");
    expect(calls).not.toContain("http://10.0.0.1/admin");
    expect(calls).not.toContain("http://localhost/secret");
    // The check: cited and answering passes; a cited source that does not answer fails and names it.
    const docs = [
      { path: "r.md", content: "x\n## Sources\n- https://gong.io/docs/calls\n- https://gong.io/gone\n" },
    ];
    const good = sourcesCheck(docs, [fetched[0]!]);
    expect(good.ok).toBe(true);
    expect(good.title).toBe("The document cites sources · 1 source answered");
    const bad = sourcesCheck(docs, [fetched[0]!, fetched[5]!]);
    expect(bad.ok).toBe(false);
    expect(bad.title).toBe("The document cites sources · 1 of 2 does not answer: https://gong.io/gone");
    expect((bad.detail.sources as unknown[]).length).toBe(2);
    // Without fetching (the board off the web) the check is what it was.
    expect(sourcesCheck(docs).title).toBe("The document cites sources");
  });
});

describe("secretsCheck", () => {
  it("passes a diff that names credentials", () => {
    const c = secretsCheck(clean);
    expect(c.ok).toBe(true);
    expect(c.title).toBe("No credential values in the diff");
  });

  it("flags secret-shaped strings and literal assignments, reporting the line and never the value", () => {
    const leaky = parseUnifiedDiff(
      renderNewFileDiff(
        "workflow.json",
        '{\n  "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyz",\n  "smtp_password": "hunter2hunter2"\n}\n',
      ),
    );
    const c = secretsCheck(leaky);
    expect(c.ok).toBe(false);
    expect(c.title).toBe("2 secret-shaped strings in the diff");
    expect(c.detail.lines).toEqual([
      { path: "workflow.json", line: 2 },
      { path: "workflow.json", line: 3 },
    ]);
    expect(JSON.stringify(c)).not.toContain("hunter2");
    expect(JSON.stringify(c)).not.toContain("ghp_");
  });

  it("flags a key in the middle of a line and an unquoted secret assignment, and passes code that names them", () => {
    // Made-up fakes in the shape of the real keys.
    const leaky = parseUnifiedDiff(
      renderNewFileDiff(
        "setup.sh",
        [
          "#!/bin/sh",
          "OPENAI_API_KEY=sk-proj-FAKE0123456789abcdefghij",
          "export ANTHROPIC_API_KEY=sk-ant-api03-FAKE0123456789abcdef",
          'const key = "sk-ant-api03-FAKE0123456789abcdef";',
          'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://api.example.com',
          "DB_PASSWORD=hunter2hunter2",
          "",
        ].join("\n"),
      ),
    );
    const c = secretsCheck(leaky);
    expect(c.ok).toBe(false);
    expect((c.detail.lines as { line: number }[]).map((l) => l.line)).toEqual([2, 3, 4, 5, 6]);
    for (const value of ["sk-proj", "sk-ant", "abcdefghijklmnop", "hunter2"])
      expect(JSON.stringify(c)).not.toContain(value);

    const named = parseUnifiedDiff(
      renderNewFileDiff(
        "src/client.ts",
        [
          "const apiKey = process.env.OPENAI_API_KEY;",
          'const headers = { authorization: "Bearer " + apiKey };',
          "// export OPENAI_API_KEY=${OPENAI_API_KEY} before you run it",
          "",
        ].join("\n"),
      ),
    );
    expect(secretsCheck(named).ok).toBe(true);
  });
});

describe("outputsCheck", () => {
  it("is not run without declared outputs, passes when every output is in the diff or artifacts", () => {
    expect(outputsCheck([], [], clean).ok).toBeNull();
    expect(outputsCheck(["credentials.md"], [], clean).ok).toBe(true);
    expect(outputsCheck(["notes/credentials.md", "plan.md"], ["plan.md"], clean).ok).toBe(true);
    const missing = outputsCheck(["credentials.md", "diagram.svg"], [], clean);
    expect(missing.ok).toBe(false);
    expect(missing.title).toBe("Missing declared output: diagram.svg");
  });
});

describe("evaluation", () => {
  const criteria = [
    { text: "Every node has a note", weight: 2 },
    { text: "Credentials by name only", weight: 1 },
  ];

  it("is pending until scored, then a weighted mean against the threshold", () => {
    expect(evaluationCheck([], null)).toBeNull();
    expect(evaluationCheck(criteria, null)!.ok).toBeNull();
    const scores = scoreCriteria(criteria, [
      { criterion: 0, score: 0.5, note: "two nodes lack notes" },
      { criterion: 1, score: 1 },
    ]);
    expect(weightedScore(scores)).toBeCloseTo((2 * 0.5 + 1) / 3);
    const c = evaluationCheck(criteria, scores)!;
    expect(c.ok).toBe(false);
    expect(c.title).toBe("Evaluation 67% of weighted criteria");
    const pass = evaluationCheck(
      criteria,
      scoreCriteria(criteria, [
        { criterion: 0, score: 0.9 },
        { criterion: 1, score: 1 },
      ]),
    )!;
    expect(pass.ok).toBe(true);
    expect(pass.title).toBe("Evaluation 93% of weighted criteria");
  });

  it("does not pass while a criterion is unscored, and refuses unknown criteria", () => {
    const partial = evaluationCheck(criteria, scoreCriteria(criteria, [{ criterion: 0, score: 1 }]))!;
    expect(partial.ok).toBe(false);
    expect(partial.title).toMatch(/1 not scored/);
    expect(() => scoreCriteria(criteria, [{ criterion: 5, score: 1 }])).toThrow(/no criterion 5/);
  });

  it("wraps the worker's test report", () => {
    expect(testsCheck({ ok: true, title: "npm test passed", detail: "12 passing" })).toMatchObject({
      kind: "tests",
      ok: true,
      detail: { output: "12 passing" },
    });
  });
});
