# OAuth fixtures

The documents of an MCP server's authorization flow, written from the specifications the Model Context
Protocol's authorization spec (revision 2025-06-18) cites, with placeholder hosts, ids and values:
`protected-resource.json` is the server's protected resource metadata (RFC 9728), naming its
authorization server and scopes; `authorization-server.json` is that server's metadata (RFC 8414), with
the endpoints, PKCE S256 and a registration endpoint; `registration.json` is a dynamic client
registration response (RFC 7591); `token.json` is a token response (RFC 6749) with a refresh token.

`test/oauth-fake.ts` replays them over an injected fetch in front of the MCP fake: it rewrites the hosts
to the test's issuer and MCP URL, registers clients, issues codes from the authorize URL the board built
(checked for PKCE, the state and the resource), exchanges and refreshes tokens, and lets an MCP request
through only with a bearer it issued that has not expired (else 401 with a `WWW-Authenticate` naming the
metadata). No real authorization server is involved anywhere in the suite.
