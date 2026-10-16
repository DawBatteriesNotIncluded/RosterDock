# OpenAPI fixtures

`crm-openapi.yaml` is the same document as YAML (written from the JSON with the `yaml` package, so the two
parse to equal objects). `crm-openapi.json` is a small OpenAPI 3.1 document for a sample CRM (contacts and lists) with operationIds
on every operation, written from the OpenAPI 3.1 specification; one operation has no operationId and is
skipped, one GET is a query that the test forces to a write. `contacts-list.json`, `contact.json` and
`contact-created.json` are the response bodies its endpoints answer, with a secret-shaped key the runtime
must redact. `test/openapi-fake.ts` replays them by method and path over an injected fetch and records every
request (URL, headers, body) so tests can assert the exact bytes that left the board.
