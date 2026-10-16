# MCP fixtures

Response shapes of a Streamable HTTP MCP server, written from the Model Context Protocol specification
(revision 2025-06-18) for a sample CRM-like server, ids and values placeholders. `initialize.json` answers
`initialize`; `tools-list.json` answers `tools/list` (one tool annotated `readOnlyHint`, one whose name says
read, one write, one unannotated and unnamed so the default classification applies); `tools-call-<name>.json`
answers `tools/call` for that tool (`search_crm_objects` with `structuredContent`, `manage_crm_objects` as
text, `whoami` as text); `tools-call-error.json` is a tool result with `isError`.

`test/mcp-fake.ts` replays them over an injected fetch and records every JSON-RPC request. The stdio
replayer `stdio-server.mjs` speaks the same fixtures over stdin and stdout for the stdio transport; it
answers `whoami` with the error fixture unless the env var named by the test reached it, which is how the
credential-by-name plumbing is checked without a real server.
