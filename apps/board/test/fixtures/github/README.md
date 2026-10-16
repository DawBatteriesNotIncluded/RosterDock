# GitHub API fixtures

Response shapes of the GitHub REST endpoints the provider (`src/git/github.ts`) calls, in the order it calls
them: `GET /git/commits/:sha` (commit.json), `GET /contents/:path?ref=` (contents.json; the fake fills in
`path` and base64 `content`), `POST /git/blobs` (blob.json), `POST /git/trees` (tree.json),
`POST /git/commits` (commit-created.json), `POST /git/refs` (ref.json, also the `PATCH` reply) and
`POST /pulls` (pull.json). Shapes follow the GitHub REST API 2022-11-28 documentation for a sample
repository `acme/gtm-automations`; ids and shas are placeholders. `test/github-fake.ts` replays them.
