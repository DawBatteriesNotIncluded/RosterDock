// Plays a recorded model CLI answer for the tests, in place of the CLI (Claude Code or Codex):
//   node claude-cli-replay.mjs <fixture | hang> <exit code | answer> <record file> ...the CLI's arguments
// Writes what it was called with (arguments, stdin, working directory, the names of its environment and
// the schema file it was handed, if any) to the record file, then prints the fixture and exits with the
// code. With `answer` the fixture is a recorded { code, stdout, stderr } and is played as it was; `hang`
// never answers.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [fixture, code, record, ...args] = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const schemaFile = path.join(process.cwd(), "answer-schema.json");
  const schema = existsSync(schemaFile) ? readFileSync(schemaFile, "utf8") : null;
  writeFileSync(
    record,
    JSON.stringify({ args, stdin, cwd: process.cwd(), env: Object.keys(process.env), schema }),
  );
  if (fixture === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (code === "answer") {
    const answer = JSON.parse(readFileSync(fixture, "utf8"));
    process.stdout.write(answer.stdout);
    process.stderr.write(answer.stderr ?? "");
    process.exit(answer.code ?? 0);
  }
  process.stdout.write(readFileSync(fixture, "utf8"));
  process.exit(Number(code));
});
