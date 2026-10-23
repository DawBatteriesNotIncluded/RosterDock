# Claude Code CLI fixtures

Real recordings of what `claude -p --output-format json --json-schema ...` prints for one of Peter's
planning calls, made by `scripts/record-claude-cli.mts` with the arguments the board sends
(`claudeCliArgs`) and the request in `scripts/planner-recording.mts`, `session_id` and `uuid`
normalised. One line each, as the CLI printed it (Prettier leaves them alone).
`test/claude-cli-replay.mjs` plays them in place of the CLI.

- `plan.json`: recorded 2026-09-30, CLI 2.1.220 on macOS, signed in with a claude.ai account,
  `claude-opus-5`. Peter's system prompt for a roster of Ricky (researcher), Brody (requirements), Cody
  (n8n engineer) and Verifier (reviewer), and the goal in the recorder, with the question round already
  used (`mayAsk: false`) so the answer is a plan. What the parser relies on: `structured_output` holds the
  plan, `result` holds the same JSON as text, `stop_reason` is `tool_use` (the CLI answers through its own
  structured-output tool, three turns), `modelUsage` is keyed by the model asked for. The recording predates
  the prompt's line on the project's repository: its build task changes code and names no outputs, which
  the board accepts only on a repository, so the tests replay it for a goal that names one.
- `error.json`: recorded 2026-09-30, CLI 2.1.220, not signed in. `is_error: true` with
  `subtype: success`, `terminal_reason: api_error`, zero usage and the reason in `result`; the CLI
  exited 1.

Re-record, from `apps/board` (after `claude auth login` for a plan):

```bash
node --import tsx scripts/record-claude-cli.mts [model]
```

Check the file for anything that looks like a secret before committing it.
