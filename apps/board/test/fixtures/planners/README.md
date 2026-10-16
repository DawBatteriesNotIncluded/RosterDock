# Model CLI sign-in fixtures

What the board's planner probe gets back when it asks the CLIs whether they are signed in, recorded by
`scripts/record-planner-status.mts` on 2026-09-30 (Claude Code 2.1.285, Codex 0.157.1, macOS), each as
`{ code, stdout, stderr }` so the replayer plays it as it was.

- `claude-signed-in.json`: `claude auth status` signed in with a claude.ai Max account: JSON on stdout,
  exit 0. The email, organisation and directories are normalised.
- `claude-signed-out.json`: the same command without the user name the CLI finds its sign-in by on macOS:
  `loggedIn: false`, exit 1.
- `codex-signed-in.json`: `codex login status`: `Logged in using ChatGPT` on stderr, nothing on stdout, exit 0.
- `codex-signed-out.json`: the same with an empty `CODEX_HOME`: `Not logged in` on stderr, exit 1.

Re-record, from `apps/board`, with both CLIs signed in:

```bash
node --import tsx scripts/record-planner-status.mts
```
