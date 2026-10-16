// A stdio MCP server that replays the recorded fixtures in this directory,
// newline-delimited JSON-RPC over stdin and stdout, for the board's stdio
// transport tests. Not a server anyone would run: it answers `whoami` with the
// error fixture unless the env var named in ROSTERDOCK_FIXTURE_AUTH_ENV reached it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const authEnv = process.env.ROSTERDOCK_FIXTURE_AUTH_ENV;

function answer(req) {
  const id = req.id;
  if (req.method === "initialize") return { ...fixture("initialize.json"), id };
  if (req.method === "tools/list") return { ...fixture("tools-list.json"), id };
  if (req.method === "tools/call") {
    const name = req.params?.name;
    if (name === "whoami" && authEnv && !process.env[authEnv])
      return { ...fixture("tools-call-error.json"), id };
    try {
      return { ...fixture(`tools-call-${name}.json`), id };
    } catch {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
    }
  }
  if (req.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined || msg.id === null) continue; // a notification
    process.stdout.write(`${JSON.stringify(answer(msg))}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
