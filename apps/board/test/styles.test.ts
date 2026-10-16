// Style packs: switched on, a pack's file is downloaded once at its pinned
// commit and kept only if it hashes to the pin; the brief then carries it under
// House style with RosterDock's framing (its front matter stripped, the level said,
// replies only for a replies pack); a new level downloads nothing; switched
// off, the brief has none. The packs' real files are their authors', in the
// build only where scripts/vendor-styles.mts put them: these tests pin stand-in
// files of their own, and check that the vendored ones still match their pins.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawUrl, STYLE_PACKS, VENDOR_DIR, vendoredPath, type StylePack } from "../src/styles/catalog.js";
import { stripFrontMatter } from "../src/styles/service.js";
import {
  addProject,
  addTeammate,
  seedCompany,
  startTestBoard,
  workerClaim,
  type Api,
  type TestBoard,
} from "./helpers.js";

const REPLIES =
  "---\nname: stand-in\ndescription: a stand-in replies style\n---\n\n# Stand-in\n\nSay less. Keep code exact.\n";
const CODE = "# Stand-in code rules\n\nReuse before you write.\n";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const catalog: StylePack[] = STYLE_PACKS.map((p) => ({
  ...p,
  sha256: sha(p.id === "caveman" ? REPLIES : CODE),
}));

let board: TestBoard;
const fetched: string[] = [];
let served: Record<string, string> = {};
// The build's copies, empty until a test puts files in it.
const vendorDir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-styles-"));

/** A fresh task's brief for a teammate of the company, as the worker would claim it. */
async function briefs(api: Api, base: string) {
  const fern = await addTeammate(api, base, "Fern", "frontend engineer");
  const project = await addProject(api, base);
  return async () => {
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Build it",
        assignee: { kind: "teammate", id: fern.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    return (await workerClaim(board, run.id)).pack as string;
  };
}

beforeAll(async () => {
  board = await startTestBoard(
    {},
    {
      styleCatalog: catalog,
      stylesVendorDir: vendorDir,
      stylesFetch: (async (input: string | URL | Request) => {
        const url = String(input);
        fetched.push(url);
        const body = Object.entries(served).find(([path]) => url.endsWith(path))?.[1];
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
      }) as typeof fetch,
    },
  );
});
afterAll(async () => {
  await board.destroy();
  rmSync(vendorDir, { recursive: true, force: true });
});

describe("style packs", () => {
  it("in the build are the pinned files, each with its licence", () => {
    for (const pack of STYLE_PACKS) {
      const file = vendoredPath(VENDOR_DIR, pack);
      if (!existsSync(file)) continue;
      // A pin moved without the script run again: run scripts/vendor-styles.mts.
      expect(sha(readFileSync(file)), pack.id).toBe(pack.sha256);
      const licence = readFileSync(vendoredPath(VENDOR_DIR, pack, "LICENSE"), "utf8");
      expect(licence.split("\n")[0]).toContain(`${pack.source.repo} at ${pack.source.commit}`);
    }
  });

  it("front matter is for the host that loads skills, not the brief", () => {
    expect(stripFrontMatter(REPLIES)).toBe("# Stand-in\n\nSay less. Keep code exact.");
    expect(stripFrontMatter(CODE)).toBe(CODE.trim());
  });

  it("are downloaded once at their pin, checked, and carried in the brief until switched off", async () => {
    const { api, base } = await seedCompany(board, "styles@example.com");
    const briefOf = await briefs(api, base);

    const listed = (await api.get(`${base}/styles`)).body as any[];
    expect(listed.map((s) => [s.id, s.enabled, s.level, s.bundled])).toEqual([
      ["ponytail", false, null, false],
      ["caveman", false, "lite", false],
    ]);
    expect(listed[1].source).toMatchObject({ license: "MIT", commit: catalog[1]!.source.commit });
    expect(await briefOf()).not.toContain("## House style");

    // On: one download, at the pinned commit.
    served = { [catalog[1]!.source.path]: REPLIES, [catalog[0]!.source.path]: CODE };
    const on = await api.put(`${base}/styles/caveman`, { enabled: true });
    expect(on.status).toBe(200);
    expect(fetched).toEqual([
      `https://raw.githubusercontent.com/${catalog[1]!.source.repo}/${catalog[1]!.source.commit}/${catalog[1]!.source.path}`,
    ]);
    expect(on.body.find((s: any) => s.id === "caveman")).toMatchObject({ enabled: true, level: "lite" });
    const brief = await briefOf();
    expect(brief).toContain("## House style");
    expect(brief).toContain("### Terse replies (Caveman)");
    expect(brief).toContain("in this style, at the lite level. Files you deliver");
    expect(brief).toContain("Say less. Keep code exact.");
    expect(brief).not.toContain("name: stand-in");
    // RosterDock's rules come first, and the house style sits before the boundaries.
    expect(brief.indexOf("## House style")).toBeLessThan(brief.indexOf("## Boundaries"));

    // Another level: nothing downloaded again.
    await api.put(`${base}/styles/caveman`, { enabled: true, level: "ultra" });
    expect(fetched).toHaveLength(1);
    expect(await briefOf()).toContain("at the ultra level");
    expect((await api.put(`${base}/styles/caveman`, { enabled: true, level: "wenyan" })).status).toBe(400);
    expect((await api.put(`${base}/styles/ponytail`, { enabled: true, level: "lite" })).status).toBe(400);
    expect((await api.put(`${base}/styles/nope`, { enabled: true })).status).toBe(404);

    // A file that is not the pinned one is refused, and the pack stays off.
    served = { [catalog[0]!.source.path]: CODE + "\nSomething else.\n" };
    const bad = await api.put(`${base}/styles/ponytail`, { enabled: true });
    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatch(
      /is not the file RosterDock pinned \(sha256 [0-9a-f]{12}…\); nothing was switched on/,
    );
    expect((await api.get(`${base}/styles`)).body.find((s: any) => s.id === "ponytail").enabled).toBe(false);

    // The pinned one goes in, framed for code.
    served = { [catalog[0]!.source.path]: CODE };
    await api.put(`${base}/styles/ponytail`, { enabled: true });
    const both = await briefOf();
    expect(both).toContain("### Minimal code (Ponytail)\nWhen you write or change code, follow this.");
    expect(both.indexOf("Minimal code (Ponytail)")).toBeLessThan(both.indexOf("Terse replies (Caveman)"));

    // Off: the brief has none, and the event says what changed.
    await api.put(`${base}/styles/caveman`, { enabled: false });
    await api.put(`${base}/styles/ponytail`, { enabled: false });
    expect(await briefOf()).not.toContain("## House style");
    const events = (await api.get(`${base}/events`)).body as any[];
    expect(
      events.filter((e) => e.type === "company.updated" && e.payload.changes?.includes("style")).length,
    ).toBe(5);
  });

  it("come from the build without a download when its copy is the pinned file", async () => {
    const { api, base } = await seedCompany(board, "styles-built@example.com");
    const briefOf = await briefs(api, base);
    fetched.length = 0;
    writeFileSync(vendoredPath(vendorDir, catalog[1]!), REPLIES);
    // A copy someone edited is not the pinned file: ignored, and the pack is downloaded as before.
    writeFileSync(vendoredPath(vendorDir, catalog[0]!), CODE + "\nEdited by hand.\n");
    served = { [catalog[0]!.source.path]: CODE };

    const listed = (await api.get(`${base}/styles`)).body as any[];
    expect(listed.map((s) => [s.id, s.bundled])).toEqual([
      ["ponytail", false],
      ["caveman", true],
    ]);
    expect((await api.put(`${base}/styles/caveman`, { enabled: true })).status).toBe(200);
    expect(fetched).toEqual([]);
    const brief = await briefOf();
    expect(brief).toContain("### Terse replies (Caveman)");
    expect(brief).toContain("Say less. Keep code exact.");
    expect(brief).not.toContain("name: stand-in");

    expect((await api.put(`${base}/styles/ponytail`, { enabled: true })).status).toBe(200);
    expect(fetched).toEqual([rawUrl(catalog[0]!)]);
    expect(await briefOf()).not.toContain("Edited by hand.");
  });
});
