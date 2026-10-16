# Codex CLI fixtures

Real recordings of what `codex exec --json --output-schema answer-schema.json ...` prints for one of Peter's
planning calls, made by `scripts/record-codex-cli.mts` with the arguments, schema file and prompt the board
sends (`codexCliArgs`, `codexPrompt`) and the request in `scripts/planner-recording.mts`, `thread_id`
normalised. JSONL, one event a line, as the CLI printed it.

- `plan.jsonl`: recorded 2026-09-30, CLI 0.157.1 on macOS, signed in with a ChatGPT account, Codex's own
  default model (the user config left out). `thread.started`, `turn.started`, one `agent_message` whose text
  is the plan as JSON, `turn.completed` with usage (`input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`).
- `error.jsonl`: recorded 2026-09-30 with a model the account cannot use: an `error` item (a warning, not the
  failure), a top-level `error` carrying the API's JSON envelope, and `turn.failed`; the CLI exited 1.

Re-record, from `apps/board` (after `codex login`):

```bash
node --import tsx scripts/record-codex-cli.mts [model]
```

Check the file for anything that looks like a secret before committing it.
