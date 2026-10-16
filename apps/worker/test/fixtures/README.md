# Worker fixtures

`pod-metrics.json` is a `PodMetrics` object of the Kubernetes metrics API (`metrics.k8s.io/v1beta1`),
written from the API reference with two containers and placeholder names, since the local cluster
serves no metrics API to record one from; `test/pod-metrics.test.ts` replays it over an injected fetch.
The rest are the engine recordings below.

# Claude Code stream fixtures

All three files are real recordings from Claude Code with
`claude -p --output-format stream-json --verbose`, with `session_id` stripped, `cwd` normalised and the
Windows user name in paths replaced with `user`.

- `claude-code-auth-error.ndjson`: recorded 2026-09-12 (CLI 2.1.226) with an expired OAuth session.
  An error result: `system/init`, one `assistant` text block, `result` with `is_error: true` and zero usage.
- `claude-code-success.ndjson`: recorded 2026-09-12 (CLI 2.1.269, haiku) with a two-file prompt.
  Shows what the parser must tolerate: `thinking` blocks with opaque signatures, `system` subtypes
  (`thinking_tokens`, `task_summary`, `post_turn_summary`), `rate_limit_event`, tool results, and a
  `result` whose usage carries about 37k cache-written tokens for the CLI's own system prompt.
- `claude-code-model-error.ndjson`: recorded by 2026-09-30 (CLI 2.1.285, the version the worker image pins)
  with the model written the way people say it, `claude-opus-5.5`, which the CLI refuses.
  `system/init` naming that model, one synthetic `assistant` text block with the CLI's message, and a
  `result` with `is_error: true`: what a teammate with a mistyped model gets.

Re-record after `claude login` with:

```bash
node apps/worker/scripts/record-claude-fixture.mjs [model]
node apps/worker/scripts/record-claude-fixture.mjs --unknown-model claude-opus-5.5
```

Check the file for anything that looks like a secret before committing it.

# Codex JSONL fixtures

Both files are real recordings from Codex (`codex exec --json --sandbox workspace-write
-c approval_policy="never" --skip-git-repo-check --ephemeral --ignore-user-config --color never
--output-last-message ... -`), CLI 0.144.5 on Windows, signed in with a ChatGPT account, with `thread_id`
normalised.

- `codex-success.jsonl`: recorded 2026-09-12. A prompt asking for one shell command and a file read:
  `thread.started`, `turn.started`, `agent_message` items, a `command_execution` item as `item.started`
  then `item.completed` (with its output, which never becomes an event), and `turn.completed` whose usage
  counts cached input inside `input_tokens`. The PowerShell path in the command is what Codex ran here.
- `codex-error.jsonl`: recorded 2026-09-12 with a model name the account cannot use: an `error` item, a
  top-level `error` carrying the API's JSON envelope, and `turn.failed`; the CLI exited 1.

Re-record after `codex login` with:

```bash
node apps/worker/scripts/record-codex-fixture.mjs [model]
```

# npm test recordings

`npm-test-pass.txt` and `npm-test-fail.txt` are real `npm test` output (npm 11, Node 22) from a one-file
package whose test script asserts `1 + 1`; the failing run had `FAIL=1` set. The machine path is replaced
with `/work/run`. The repository test runner (`src/tests.ts`) is tested against these, never against a live npm.
