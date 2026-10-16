# Backlog

Things noticed while building that are outside the current milestone. Move a line into the plan when it is
scheduled; delete it when it ships.

- Peter (M4): the plan's Claude Agent SDK loop against the board MCP server was not adopted (Peter is a deterministic
  board loop with one-shot structured model calls, see `docs/m4.md`); revisit if a decision ever needs tools.
- Governed tools (M5): the plan's `auto` tool mode was dropped (a live write never skips the gate; see `docs/m5.md`);
  the stub engine's `[stub:tool]` marker is a demo device, not an engine feature. (OAuth on MCP connections
  shipped from the backlog, with a secret store the board may write to.)
- pnpm 10.32 ignores `pnpm.onlyBuiltDependencies` in the root `package.json` and says so on every command; the
  setting belongs in `pnpm-workspace.yaml` now.
- A run's claim reads object-store text (a review's diff, and since m13 its dependencies' outputs) inside the
  claim's transaction; with a bucket that answers slowly the transaction waits on the network. Read first, then
  claim, if it ever shows.
