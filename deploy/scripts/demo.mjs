#!/usr/bin/env node
// Set up a demo company on a local board. A demo is a folder under deploy/demo
// (its seed drive and staging folders, and the guide with the goals) and the
// file deploy/templates/<demo>-company.json: lighthouse (the default) or cirrus.
// The script copies the seed folders into ~/<Company> (never over a file that
// is there), imports the file into the company of that name (what exists by
// name is left alone, except that a department of the same name gains the
// file's missing members and a teammate its missing toolbox lines), sets
// MEMORY_FILE_PATH for the company when the file has a notes connection and
// the board a secret store, and discovers every connection's tools.
// Needs the board running with ROSTERDOCK_DEV_LOGIN=1 and the company created. Usage:
//   node deploy/scripts/demo.mjs [--demo cirrus] [--board http://127.0.0.1:3000] [--email you@example.com]
//     [--company Cirrus] [--root ~/Cirrus] [--browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
// On a cluster, where the folders live in the board pod's volume (examples/local.yaml) and no Chromium is:
//   node deploy/scripts/demo.mjs --board http://127.0.0.1:8080 --email you@example.com \
//     --no-seed --board-root /home/node/Lighthouse --no-browser
// --board-root is where the board itself finds the folders. When it is given, a connection the file starts
// on ~/<Company>/... is pointed at <board-root>/... instead (the cirrus demo on the Lighthouse volume:
// --board-root /home/node/Lighthouse/cirrus).
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const demo = arg("demo", "lighthouse");
const seed = path.join(repo, "deploy", "demo", demo);
const file = JSON.parse(
  await readFile(path.join(repo, "deploy", "templates", `${demo}-company.json`), "utf8").catch(() => {
    throw new Error(`no demo named ${demo}: deploy/templates/${demo}-company.json is not there`);
  }),
);
const board = arg("board", "http://127.0.0.1:3000").replace(/\/+$/, "");
const email = arg("email", process.env.ROSTERDOCK_DEMO_EMAIL ?? "owner@example.com");
const companyName = arg("company", file.company.name);
// The folder the file's connections are started on, as the file writes it.
const fileRoot = `~/${file.company.name}`;
const root = arg("root", fileRoot).replace(/^~(?=$|\/)/, os.homedir());
const browser = arg("browser", null);
// Where the board itself sees the folder: the same machine, or a pod's volume.
const boardRoot = arg("board-root", root).replace(/\/+$/, "");
const moved = process.argv.includes("--board-root");
const has = (name) => file.connections.some((c) => c.name === name);
const seedDrive = !process.argv.includes("--no-seed");
const noBrowser = process.argv.includes("--no-browser");

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  let copied = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copied += await copyTree(src, dst);
    else if (!(await stat(dst).catch(() => null))) {
      await copyFile(src, dst);
      copied++;
    }
  }
  return copied;
}

let token = null;
async function api(method, url, body) {
  const res = await fetch(`${board}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${json?.error ?? json?.message ?? text}`);
  return json;
}

if (seedDrive) {
  const copied = await copyTree(seed, root);
  // A site is what the browser connection opens; a demo without one publishes writing only.
  for (const dir of has("browser") ? ["drive/site", "drive/published", "staging/site"] : ["drive/published"])
    await mkdir(path.join(root, dir), { recursive: true });
  console.log(`${root}: ${copied} seed file(s) copied, existing files kept`);
}

token = (await api("POST", "/api/auth/dev-login", { email })).token;
const companies = await api("GET", "/api/companies");
const company = companies.find((c) => c.name === companyName);
if (!company) throw new Error(`no company named ${companyName} for ${email}; create it on the board first`);
const base = `/api/companies/${company.id}`;

// When the board finds the folders elsewhere, the file's connections start there: the board runs a stdio
// command only when its exact line is listed (ROSTERDOCK_STDIO_COMMANDS), and those are the lines it lists.
const startsOn = (args) =>
  (args ?? []).map((a) => (a.startsWith(`${fileRoot}/`) ? `${boardRoot}${a.slice(fileRoot.length)}` : a));
const report = await api(
  "POST",
  `${base}/templates/import`,
  moved ? { ...file, connections: file.connections.map((c) => ({ ...c, args: startsOn(c.args) })) } : file,
);
console.log("import:", JSON.stringify(report));

// What existed by name was left alone: give it what the file adds without taking anything away.
const teammates = await api("GET", `${base}/teammates`);
const byName = new Map(teammates.map((t) => [t.name, t]));
for (const want of file.teammates) {
  const have = byName.get(want.name);
  if (!have || !report.skipped.includes(`teammate ${want.name}`)) continue;
  const missing = want.toolbox.filter((w) => !have.toolbox.some((h) => h.connection === w.connection));
  if (missing.length) {
    await api("PATCH", `${base}/teammates/${have.id}`, { toolbox: [...have.toolbox, ...missing] });
    console.log(
      `${want.name}: existed; added ${missing.map((m) => `${m.connection} (${m.mode})`).join(", ")}`,
    );
  }
}
const departments = await api("GET", `${base}/departments`);
for (const want of file.departments) {
  const have = departments.find((d) => d.name === want.name);
  if (!have || !report.skipped.includes(`department ${want.name}`)) continue;
  const members = new Set((have.members ?? []).map((m) => m.id ?? m.teammateId ?? m));
  const added = [];
  for (const name of want.members) {
    const mate = byName.get(name);
    if (mate && !members.has(mate.id)) {
      await api("PUT", `${base}/departments/${have.id}/members/${mate.id}`, { isLead: false });
      added.push(name);
    }
  }
  if (added.length)
    console.log(`${want.name}: existed; added ${added.join(", ")} (lead and policy left as they are)`);
}

if (has("notes")) {
  const features = await api("GET", "/api/features");
  const notesFile = `${boardRoot}/notes.jsonl`;
  if (features.oauth) {
    await api("PUT", `${base}/secrets/MEMORY_FILE_PATH`, { value: notesFile });
    console.log(`notes: MEMORY_FILE_PATH set for ${companyName} (${notesFile})`);
  } else {
    console.log(
      `notes: the board has no secret store; add MEMORY_FILE_PATH=${notesFile} to apps/board/.env and list MEMORY_FILE_PATH in ROSTERDOCK_SHARED_ENV_NAMES`,
    );
  }
}

const connections = await api("GET", `${base}/connections`);
for (const name of file.connections.map((c) => c.name)) {
  const conn = connections.find((c) => c.name === name);
  if (!conn) {
    console.log(`${name}: not on the company`);
    continue;
  }
  if (name === "browser" && noBrowser) {
    await api("PATCH", `${base}/connections/${conn.id}`, { enabled: false });
    console.log("browser: off (no Chromium where the board runs); QA reviews the diff");
    continue;
  }
  if (moved && conn.args.some((a) => a.startsWith(`${fileRoot}/`))) {
    // A connection an earlier run imported where the file says: point it where the board finds the folders.
    const args = startsOn(conn.args);
    await api("PATCH", `${base}/connections/${conn.id}`, { args });
    console.log(`${name}: started on ${args.at(-1)}`);
  }
  if (name === "browser" && browser) {
    // A Chromium the machine already has, instead of the one Playwright would download.
    const args = conn.args.filter((a, i, all) => a !== "--browser" && all[i - 1] !== "--browser");
    const at = args.indexOf("--executable-path");
    if (at >= 0) args.splice(at, 2);
    await api("PATCH", `${base}/connections/${conn.id}`, { args: [...args, "--executable-path", browser] });
  }
  try {
    const found = await api("POST", `${base}/connections/${conn.id}/discover`);
    const writes = found.tools.filter((t) => t.write && !t.off).length;
    const off = found.tools.filter((t) => t.off).length;
    console.log(`${name}: ${found.tools.length} tools (${writes} gated writes, ${off} off)`);
  } catch (err) {
    console.log(`${name}: discovery failed: ${err.message}`);
  }
}

const guide = `deploy/demo/${demo}/README.md`;
console.log(
  !has("browser")
    ? `
Next:
  pnpm dev:worker                                                     # one per run you want at once
Then hand Peter the goals in ${guide}.`
    : noBrowser
      ? `\nThen hand Peter the goals in ${guide}.`
      : `
Next:
  python3 -m http.server 4178 --bind 127.0.0.1 --directory ${root}   # what QA's browser opens
  pnpm dev:worker                                                     # one per run you want at once
Then hand Peter the goals in ${guide}.`,
);
