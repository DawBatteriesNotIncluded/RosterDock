# Lighthouse: a demo company that ships real work

Lighthouse is the company that makes RosterDock, run on RosterDock. It launches RosterDock: research maps the
market from the web and a CRM export, engineering builds the landing page and a digest script, marketing
writes the launch kit, finance closes the month. Every output is a file you can open, and everything that
lands in the company drive went through your approval. It runs on one machine; nothing leaves it but the
teammates' model calls and Research's web searches.

## The company

| Department  | Write policy | Lead  | Makers                                                                    | Reviewer           |
| ----------- | ------------ | ----- | ------------------------------------------------------------------------- | ------------------ |
| Research    | drafts       | Ricky | Scout (market analyst), Quinn (customer researcher), Brody (requirements) | Edie (editor)      |
| Engineering | drafts       | Archy | Fern (frontend), Dex (automation, **on Codex**), Cody (n8n)               | Tess (QA, browser) |
| Marketing   | ask          | Mara  | Sage (short copy, publishing), Reporter (digests)                         | Edie (editor)      |
| Finance     | ask          | Finn  | Bookkeeper, Penny (planning)                                              | Verifier           |

Peter plans goals that span departments; each lead plans its own department's goals. Brains are mixed on
purpose: Opus for Archy, Edie and Verifier, Sonnet for most makers, Haiku for Quinn, Sage, Reporter and
Bookkeeper, and Codex for Dex, so Costs shows spend by model. Research's sandbox adds `WebSearch` and
`WebFetch`; no other department reaches the web.

## The connections (all local processes)

| Connection | What it is                                                          | Reads | Writes                                                |
| ---------- | ------------------------------------------------------------------- | ----- | ----------------------------------------------------- |
| `drive`    | `~/Lighthouse/drive` through the MCP filesystem server              | free  | `write_file` needs your approval; `move_file` is off  |
| `staging`  | `~/Lighthouse/staging`, the same server                             | free  | free (a person reclassified them: staging is scratch) |
| `notes`    | The MCP memory server: one knowledge graph the whole company shares | free  | adding is free; every delete is off                   |
| `browser`  | Playwright, headless, allowed only `http://127.0.0.1:4178`          | free  | only navigation and viewport tools, granted to Tess   |

Toolboxes: makers hold `drive` in ask mode with only the read tools and `write_file`; leads and
reviewers read it. Only Tess holds the browser. The drive holds the inputs: `company/rosterdock-fact-sheet.md`
(the one source of product claims), `company/brand-voice.md`, a CRM export in `crm/` and September's
transactions in `finance/`. All companies, deals and transactions in it are fictional.

## Set it up

Once, on the machine:

```bash
claude update                     # Opus 5.5 (Archy, Edie, Verifier) needs Claude Code 2.1.280 or later
claude auth login                 # teammates on Claude Code, and Peter, use this sign-in
codex login                       # Dex runs on Codex
cp apps/worker/.env.example apps/worker/.env
```

`apps/board/.env` needs these three lines (next to `ROSTERDOCK_DEV_LOGIN=1`), then restart the board. The
last lists the demo's servers, on its own folders, as the only commands the board may run for a connection:

```bash
ROSTERDOCK_PETER_CLAUDE_BIN=claude    # Peter and the leads plan through the CLI, no API key
ROSTERDOCK_SECRET_STORE=file:.data/secrets
ROSTERDOCK_STDIO_COMMANDS=npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Lighthouse/drive,npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Lighthouse/staging,npx -y @modelcontextprotocol/server-memory@2026.8.31,npx -y @playwright/mcp@0.0.83 --headless --isolated --browser chromium --allowed-origins http://127.0.0.1:4178
```

With `--browser` (below) the browser's path goes into the Playwright server's arguments, and a path with a
space cannot be listed: end that entry at `npx -y @playwright/mcp@0.0.83 *` instead, which lets the
company choose its arguments, fine for a board only you reach.

Then, with `pnpm db:up && pnpm db:migrate && pnpm dev` running and a company named Lighthouse created on
the board by your account:

```bash
node deploy/scripts/demo-lighthouse.mjs --email you@example.com
python3 -m http.server 4178 --bind 127.0.0.1 --directory ~/Lighthouse
pnpm dev:worker
ROSTERDOCK_WORKER_ID=worker-2 pnpm dev:worker
```

The script copies the drive into `~/Lighthouse` (it never overwrites a file), imports
`deploy/templates/lighthouse-company.json` (anything that exists by name is left alone), discovers each
connection's tools and sets `MEMORY_FILE_PATH` for Lighthouse in the secret store. Playwright needs a
Chromium: `npx @playwright/mcp@0.0.83 install-browser chrome-for-testing`, or pass
`--browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"` (any Chromium) to the script.
Each worker runs one teammate at a time; two or three make the office busy.

## On Kubernetes

The same company runs on a local kind cluster (`deploy/scripts/local-cluster.sh`, `docs/install.md`). The
drive lives in the board pod's volume at `/home/node/Lighthouse` (`examples/local.yaml`), the stdio
connections run in the board pod, and there is no Chromium there, so the browser is off and Tess reviews the
diff. Codex needs `OPENAI_API_KEY` in a pod, so without one move Dex to Claude Code. After the install:

```bash
kubectl --context kind-rosterdock -n rosterdock port-forward svc/rosterdock-web 8080:80
BOARD=$(kubectl --context kind-rosterdock -n rosterdock get pod -l app.kubernetes.io/component=board -o name | cut -d/ -f2)
kubectl --context kind-rosterdock -n rosterdock cp ~/Lighthouse/. "$BOARD":/home/node/Lighthouse
node deploy/scripts/demo-lighthouse.mjs --board http://127.0.0.1:8080 --email you@example.com \
  --no-seed --board-root /home/node/Lighthouse --no-browser
```

## The goals

Hand these to Peter from the company page (**New goal**). Pick the department where one is named, so its
lead plans it. Run 1 first: 2 and 3 build on what it publishes.

1. **Research**: "Map the five closest alternatives to RosterDock: what each is, how it is deployed, how it
   governs agents and what it costs. Write our positioning against them from drive
   company/rosterdock-fact-sheet.md, and add what the CRM export in drive crm/ says about who buys and why.
   Cite every source. Publish the positioning to the drive's published folder."
   Ricky splits it for Scout, Quinn and Brody. Scout searches the web and records each competitor in
   `notes`; Edie reviews each document against the sources check; the publish waits in Approvals.
2. **Engineering**: "Build a one-page landing site for RosterDock as index.html from drive
   published/positioning.md and drive company/brand-voice.md. Put it in staging for QA, then publish it
   to the drive's site folder."
   Fern builds and stages the page; Tess opens it in the browser, in dark mode and at 375 px, and
   comments on lines; after your approval it is at `http://127.0.0.1:4178/drive/site/index.html`.
3. **Marketing**: "Write the RosterDock launch kit from drive published/positioning.md and the fact sheet: a
   launch blog post, a LinkedIn post and a launch email. Review each, then publish them to the drive."
4. **No department (Peter plans across the company)**: "Every Monday the team needs a pipeline digest
   from the latest CRM export in drive crm/: stage counts, value by stage, deals quiet for 30 days and the
   top objections. Write this week's digest, build a small script that produces it from any export, and
   an inactive n8n workflow that would run it weekly and post it to Slack."
   Reporter, Dex (on Codex) and Cody; the n8n JSON imports into any n8n, credentials by name only.
5. **Finance**: "Close September: categorise every transaction in drive finance/transactions-2026-09.csv
   against the chart of accounts, list what needs a person and why, and draft a three-month launch
   budget from the run rate. Publish the categorised ledger and the budget to the drive."
   The ledger has a duplicated ad charge, a personal-looking purchase and a cloud bill spike to find.

## What to show while it runs

- **Board**: tasks created by Peter and the leads, dependencies holding later tasks in To do.
- **Office**: who is at a desk, who is talking to whom.
- **A review**: the diff by hunk, comments anchored to lines, the checks (secret scan, outputs,
  sources, evaluation), a request for changes and the second round.
- **Approvals**: the exact file a teammate wants to write, with its sha256; approve one, reject one and
  watch Peter re-plan the rejected task.
- **Veto**: open a Done task and veto its review; it goes back to In review.
- **Design from a brief** (Company page): "I need a customer support function that answers product
  questions from the fact sheet and escalates anything about pricing to a person." Accept the draft.
- **Audit the company**, and **Costs** by model after a few runs.
- **Settings**: the four connections, the tools a person switched off, and the toolbox editor.

## What it costs

Goal 1, run on this company with the brains above, took 23.85M tokens over seven tasks, US$22.72 at the
API's list prices, reviews and restarts included; most of the tokens are cache reads. The Cirrus demo's
goals took 7.1M to 12.4M tokens (US$6.77 to US$11.91) each. A task with its reviews averaged 1.4M to 3.4M
tokens across those goals, so the five goals here come to roughly US$35 to US$115 at list prices, more when a
reviewer sends work back for several rounds. Set a company budget in Settings before you start. On a Claude
subscription (the CLI's own sign-in) the same runs count against its usage limits instead of a bill.
