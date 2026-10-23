// Pure review checks over parsed diffs. No database.
import { createHash } from "node:crypto";
import { parseUnifiedDiff, renderNewFileDiff } from "@rosterdock/shared";
import { describe, expect, it } from "vitest";
import {
  evaluationCheck,
  outputsCheck,
  scanBinary,
  scoreCriteria,
  secretsCheck,
  sourcesCheck,
  testsCheck,
  weightedScore,
} from "../src/reviews/checks.js";
import { scanRunBinaries } from "../src/reviews/service.js";
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

  it("reads each character reference once, so escaped markup stays text", () => {
    const page = summarisePage(
      "text/html",
      "<title>A &amp;amp; B</title><p>Write &amp;lt;script&amp;gt; as &lt;script&gt;.</p><p>It&#8217;s &#x41;&#65;; &#0; &bogus;</p>",
    );
    expect(page.title).toBe("A &amp; B");
    expect(page.excerpt).toBe("Write &lt;script&gt; as <script>.\nIt\u2019s AA; &#0; &bogus;");
  });

  it("ends a script, a style, a title or a comment wherever a browser would", () => {
    const page = summarisePage(
      "text/html",
      [
        "<html><head><title>Kept</title ><meta charset=utf-8>",
        "<style>p{}</style\n>",
        "<body><p>one</p>",
        "<script>a()</script ><p>two</p>",
        "<SCRIPT type=module>b()</SCRIPT\t>three",
        '<script>c()</script foo="bar"><p>four</p>',
        "<!-- d --!>five<!-->six<!--->seven",
        "<p>1 < 2 and 3 > 2</p>",
        "<script>never closed()",
      ].join(""),
    );
    expect(page.title).toBe("Kept");
    expect(page.excerpt).toBe("one\ntwo three\nfour five six seven\n1 < 2 and 3 > 2");
  });

  it("reads a hostile page, or a link in a document, in one pass", () => {
    const half = 512 * 1024; // the most of a page the fetcher reads
    const pages = [
      "<".repeat(half),
      "<script".repeat(half / 7),
      "<title".repeat(half / 6),
      "<!--".repeat(half / 4),
      "<p>" + "\u00a0".repeat(half),
      "&nbsp;".repeat(half / 6) + "<p>",
    ];
    for (const body of pages) {
      const start = performance.now();
      summarisePage("text/html", body);
      expect(performance.now() - start).toBeLessThan(500);
    }
    const start = performance.now();
    const link = `https://example.org/${".".repeat(half)}x`;
    expect(extractSourceUrls([{ content: `See ${link}.` }])).toEqual([link]);
    expect(performance.now() - start).toBeLessThan(500);
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
    const fetched = await sourceFetcher({ fetch: fake, resolve: async () => ["93.184.215.14"] }).fetch([
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
    // A diff that could not be read was not scanned: the check fails and says why.
    expect(secretsCheck([], "x.md: a line git does not write in a diff")).toMatchObject({
      ok: false,
      detail: { unread: "x.md: a line git does not write in a diff" },
    });
  });

  it("scans every binary file's bytes, binds their sha256, and names them as files the review cannot show", async () => {
    const stanza = (p: string) =>
      `diff --git a/${p} b/${p}\nnew file mode 100644\nBinary files /dev/null and b/${p} differ\n`;
    const binary = (...paths: string[]) => parseUnifiedDiff(paths.map(stanza).join(""));
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    // Text git calls binary (an attribute): scanned like an added line, reported by its line, never its value.
    const text = Buffer.from('{\n  "smtp_password": "not-a-real-value-123"\n}\n');
    expect(secretsCheck(binary("config.json"), undefined, [await scanBinary("config.json", text)])).toEqual({
      kind: "secrets",
      ok: false,
      title: "1 secret-shaped string in the diff",
      detail: {
        scannedChars: text.toString().length,
        binaries: [{ path: "config.json", sha256: sha(text) }],
        unshown: ["config.json"],
        lines: [{ path: "config.json", line: 2 }],
      },
    });
    // With a NUL byte in it, and as UTF-16 in either byte order: scanned all the same, whatever character
    // stands before the key (an ideographic space is 0x00 0x30 in UTF-16: read as bytes, a "0" would join it).
    const nul = Buffer.concat([Buffer.from([0]), Buffer.from('\napi_key = "not-a-real-value-123"\n')]);
    expect((await scanBinary("data.bin", nul)).lines).toEqual([2]);
    const utf16 = Buffer.from('\ufeffname: x\npassword = "not-a-real-value-123"\n', "utf16le");
    expect((await scanBinary("notes.txt", utf16)).lines).toEqual([2]);
    for (const before of ["\u3000", "\u4100", "\u6100"]) {
      const text = `\ufeffdeploy key:${before}ghp_0123456789abcdefghijklmnopqrstuvwxyz\n`;
      const le = Buffer.from(text, "utf16le");
      expect((await scanBinary("key.txt", le)).lines, `LE ${before}`).toEqual([1]);
      expect((await scanBinary("key.txt", Buffer.from(le).swap16())).lines, `BE ${before}`).toEqual([1]);
    }
    // UTF-32 with a CJK character against the key, and UTF-16 from an odd byte (inside a container).
    const cjk = "deploy key:\u4e00ghp_0123456789abcdefghijklmnopqrstuvwxyz\n";
    const u32 = (t: string, le: boolean) =>
      Buffer.concat(
        [...t].map((c) => {
          const b = Buffer.alloc(4);
          if (le) b.writeUInt32LE(c.codePointAt(0)!);
          else b.writeUInt32BE(c.codePointAt(0)!);
          return b;
        }),
      );
    expect((await scanBinary("notes32.txt", u32(cjk, true))).lines).toEqual([1]);
    expect((await scanBinary("notes32.txt", u32(cjk, false))).lines).toEqual([1]);
    const odd = Buffer.concat([
      Buffer.from([7]),
      Buffer.from("deploy key:\u3000ghp_0123456789abcdefghijklmnopqrstuvwxyz\n", "utf16le"),
    ]);
    expect((await scanBinary("notes16.dat", odd)).lines).toEqual([1]);
    // UTF-32 in either byte order, and a NUL byte inside the key itself.
    const key = "token: ghp_0123456789abcdefghijklmnopqrstuvwxyz\n";
    const utf32le = Buffer.concat([...key].map((c) => Buffer.from([c.charCodeAt(0), 0, 0, 0])));
    const utf32be = Buffer.concat([...key].map((c) => Buffer.from([0, 0, 0, c.charCodeAt(0)])));
    expect((await scanBinary("key.bin", utf32le)).lines).toEqual([1]);
    expect((await scanBinary("key.bin", utf32be)).lines).toEqual([1]);
    expect(
      (await scanBinary("key.bin", Buffer.from("token: ghp_0123456789\0abcdefghijklmnopqrstuvwxyz\n"))).lines,
    ).toEqual([1]);
    // Bytes past what the board scans in a run are only hashed, and the check leaves them to a person.
    expect(
      secretsCheck(binary("big.bin"), undefined, [await scanBinary("big.bin", text, false)]),
    ).toMatchObject({
      ok: false,
      title:
        "1 binary file was not scanned (its bytes came under another spelling of its name, or past what the board scans in a run: 64 MB, 100 files): a person approves it: big.bin",
      detail: { binaries: [{ path: "big.bin", sha256: sha(text) }], unscanned: ["big.bin"] },
    });
    // Clean bytes pass, named as files the review cannot show.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(secretsCheck(binary("logo.png"), undefined, [await scanBinary("logo.png", png)])).toMatchObject({
      ok: true,
      title:
        "No credential values in the diff's text; the review cannot show 1 binary file, read only as text, which a pull request takes only with a person's approval: logo.png",
      detail: { binaries: [{ path: "logo.png", sha256: sha(png) }], unshown: ["logo.png"] },
    });
    // One the run sent no bytes for has nothing delivered: it passes, unbound, and a pull request refuses it.
    expect(
      secretsCheck(binary("logo.png", "gone.bin"), undefined, [
        await scanBinary("logo.png", png),
        await scanBinary("gone.bin", null),
      ]),
    ).toMatchObject({
      ok: true,
      detail: { binaries: [{ path: "logo.png" }], unshown: ["logo.png", "gone.bin"] },
    });
  });
});

describe("scanning a run's binary files", () => {
  const stanza = (p: string) =>
    `diff --git a/${p} b/${p}\nnew file mode 100644\nBinary files /dev/null and b/${p} differ\n`;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  /** A run's artifacts by path, and every query in the order the database saw it. */
  const fakeDb = (runs: Record<string, Record<string, Buffer>>, seen: string[] = []) => ({
    async query(sql: string, params: unknown[]) {
      const [runId, path] = params as [string, string];
      seen.push(runId);
      const bytes = runs[runId]!;
      if (sql.includes("kind = 'diff'"))
        return {
          rows: [
            {
              content: Object.keys(bytes)
                .map((p) => stanza(p.toLowerCase()))
                .join(""),
              object_key: null,
            },
          ],
        };
      if (sql.includes("lower(path)")) {
        const hit = Object.keys(bytes).some((p) => p.toLowerCase() === path.toLowerCase());
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      const b = bytes[path];
      // One kept in the store (its name says so), which the store in the test never gives.
      const stored = path.startsWith("stored-");
      return {
        rows: b
          ? [
              {
                content: stored ? null : b.toString("base64"),
                object_key: stored ? `k/${path}` : null,
                encoding: "base64",
                sha256: sha(b),
                bytes: b.length,
              },
            ]
          : [],
      };
    },
  });

  it("scans each before the review opens, up to the bytes and files it reads in a run, then binds by sha256", async () => {
    const a = Buffer.from([0, ...Buffer.from('\napi_key = "not-a-real-value-123"\n')]);
    const b = Buffer.from(Array.from({ length: 24 }, (_, i) => i));
    const c = Buffer.from([0, 1]);
    const d = Buffer.from([0, 2]);
    // 40 bytes: a.bin (34) is scanned; stored-b.bin (24) would pass it, and is bound by its sha256, never
    // fetched; c.bin (2) still fits; D.bin's bytes came under another spelling of its name (the diff: d.bin).
    const db = fakeDb({ "run-1": { "a.bin": a, "stored-b.bin": b, "c.bin": c, "D.bin": d } });
    const refusing = { get: async () => Promise.reject(new Error("fetched past the budget")) };
    const scanned = await scanRunBinaries(db as never, refusing as never, "run-1", 40, 10);
    expect([...scanned.values()].map((s) => [s.path, s.scanned, s.lines, s.sha256])).toEqual([
      ["a.bin", true, [2], sha(a)],
      ["stored-b.bin", false, [], sha(b)],
      ["c.bin", true, [], sha(c)],
      ["d.bin", false, [], null],
    ]);
    // A file with no artifact at all has nothing delivered: nothing to scan, and a pull request refuses it.
    const none = await scanRunBinaries(fakeDb({ "run-2": {} }) as never, null, "run-2");
    expect(none.size).toBe(0);
    const absent = { "run-3": { "x.bin": a } };
    const db3 = fakeDb(absent);
    const orig = db3.query.bind(db3);
    db3.query = async (sql, params) =>
      sql.includes("kind = 'diff'")
        ? { rows: [{ content: stanza("gone.bin"), object_key: null }] }
        : orig(sql, params);
    expect([...(await scanRunBinaries(db3 as never, null, "run-3")).values()]).toEqual([
      { path: "gone.bin", sha256: null, lines: [], chars: 0, scanned: true },
    ]);
    // No more files than it reads in a run.
    const capped = await scanRunBinaries(
      fakeDb({ "run-4": { "a.bin": a, "c.bin": c } }) as never,
      null,
      "run-4",
      1000,
      1,
    );
    expect([...capped.values()].map((s) => [s.path, s.scanned])).toEqual([
      ["a.bin", true],
      ["c.bin", false],
    ]);
  });

  it("scans one run's binary files at a time on the board, whichever run asks", async () => {
    const seen: string[] = [];
    const bytes = { "a.bin": Buffer.from([0, 1, 2]), "b.bin": Buffer.from([0, 3, 4]) };
    const db = fakeDb({ "run-a": bytes, "run-b": bytes }, seen);
    await Promise.all([
      scanRunBinaries(db as never, null, "run-a"),
      scanRunBinaries(db as never, null, "run-b"),
    ]);
    expect(seen).toEqual([...seen.filter((r) => r === "run-a"), ...seen.filter((r) => r === "run-b")]);
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
    // Sent under git's spelling by a worker whose file system ignores case.
    expect(outputsCheck(["Report.md"], ["report.md"], []).ok).toBe(true);
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
