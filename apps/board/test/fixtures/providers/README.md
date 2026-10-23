# Model provider fixtures

Real recordings of what each kind of company model provider answers to the board's Check, made by
`scripts/record-provider-checks.mts` with the board's own requests (`listModels`, `src/providers/check.ts`),
sent from the owner's machine with their own accounts. `test/provider-replay.ts` replays them in order, and
fails a check that sends a request the recording does not have; `test/provider-checks.test.ts` is the suite.

Each file is one check: the provider's settings it was made against (`provider`), then every request the
board sent (method, URL and headers, a key written as `<key>`) with the answer it got (status, content type,
and the body, parsed when it is JSON). Two per kind:

- `<kind>-models.json`: a key that works, and the models it reaches.
- `<kind>-refused.json`: a wrong key the recorder made up (never one anyone was issued), refused with 401 or 403.

| Kind                | Requests                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `anthropic`         | `GET https://api.anthropic.com/v1/models?limit=1000`, through the Anthropic SDK                |
| `openai`            | `GET https://api.openai.com/v1/models`                                                         |
| `azure_openai`      | `GET https://<resource>.openai.azure.com/openai/v1/models`, the key in `api-key`               |
| `bedrock`           | `GET https://bedrock.<region>.amazonaws.com/inference-profiles?…`, then `/foundation-models?…` |
| `openai_compatible` | `GET <base URL>/models`                                                                        |

What the recorder takes out before it writes, and checks for after: every key, in any form JSON writes it,
and any twelve characters of it in a row; a key named back in part (OpenAI's refusal does); an AWS account
number in an ARN (zeroed); the organisation or person owning an OpenAI fine-tuned model (`org-recorded`); an
Azure resource's name (`acme.openai.azure.com`) and a compatible server's host (`llm.internal.test`, which
the suite resolves to a private address the operator lists).

Recordings: not made yet. The suite's checks of each kind fail until they are.

Record again, from `apps/board`, one kind at a time, with the key in your own shell or typed when asked (it
is not shown and not saved):

```bash
node --import tsx scripts/record-provider-checks.mts anthropic
```

The kinds are `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `azure_openai`
(`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`), `bedrock` (`AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`) and
`openai_compatible` (`OPENAI_COMPATIBLE_BASE_URL`, default `http://localhost:11434/v1` for Ollama, and
`OPENAI_COMPATIBLE_API_KEY` if it takes one). A server that takes no key cannot refuse one: give
`OPENAI_COMPATIBLE_REFUSED_BASE_URL`, one that takes a key (vLLM started with `--api-key`, LiteLLM with a
master key), for the refusal. Check both files for anything that looks like a secret or names your account
before committing them.
