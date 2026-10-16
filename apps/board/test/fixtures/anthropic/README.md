# Anthropic Messages API fixtures

Response shapes of `POST /v1/messages` with a structured output (`output_config.format`), as documented for
the Messages API: the plan is the JSON in the first text block. Written from the API documentation, not
recorded from a live call (the tests never reach the network). `plan-questions.json` is Peter asking two
clarifying questions; `plan-tasks.json` the same goal planned after the answers; `plan-invalid.json` a plan
that names a teammate who is not on the roster (the board refuses it and plans by heuristic);
`refusal.json` a refusal stop reason.
`replan.json` is Peter's note after a failed run; `replan-needs-person.json` the same call deciding a person must act.
`org-proposal.json` is Peter's org proposal for a research agency brief.
