<!-- What changes and why, in a sentence or two. Link the issue it closes, if there is one. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` pass locally
- [ ] A new route, setting or concept has its doc line in this pull request
- [ ] Mutating routes declare `config.action` and append an event in the same transaction
- [ ] No secret values, personal data or local paths in code, fixtures or docs (env var names only)
- [ ] New fixtures are recordings, not hand-written echoes, and no test needs a model, a git host or an MCP server
- [ ] Text on screen uses manager language: no lanes, leases, run specs or blocker codes
