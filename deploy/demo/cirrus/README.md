# Cirrus: a telecoms and media company run by teammates

Cirrus is a fictional UK provider of broadband, TV over broadband and mobile, made to show RosterDock to
someone who runs AI in that kind of business. It has had a bad week: a Saturday-evening outage in the North
West, a Hub update that broke Wi-Fi, a billing run that charged people twice, and a care assistant that
promised customers money the policy does not give. The teammates work out what happened from the week's
exports, write to customers, fix the help centre, and build the evaluation that would have caught the
assistant. Nothing reaches a customer or the drive without your approval. Every customer, contact, incident,
price, policy and programme is invented; it runs on one machine and needs no web access.

## The company

| Department       | Write policy | Lead  | Makers                                                               | Reviewer              |
| ---------------- | ------------ | ----- | -------------------------------------------------------------------- | --------------------- |
| Customer Insight | drafts       | Iris  | Quinn (contact analyst), Nia (network analyst), Wren (report writer) | Edie (editor, policy) |
| Customer Care    | ask          | Hope  | Sage (customer messages, publishing)                                 | Edie                  |
| AI Engineering   | drafts       | Archy | Goldie (evaluation data), Paige (prompts), Dex (evaluation scripts)  | Tess (QA, red team)   |
| Content          | ask          | Mara  | Cato (catalogue analyst), Reporter (editorial)                       | Edie                  |

Peter plans goals that span departments; each lead plans its own department's goals. Brains are mixed on
purpose: Opus for Archy and Edie, Sonnet for most makers, Haiku for Sage and Reporter, so Costs
shows spend by model.

## The connections (local processes)

| Connection | What it is                                         | Reads | Writes                                                |
| ---------- | -------------------------------------------------- | ----- | ----------------------------------------------------- |
| `drive`    | `~/Cirrus/drive` through the MCP filesystem server | free  | `write_file` needs your approval; `move_file` is off  |
| `staging`  | `~/Cirrus/staging`, the same server                | free  | free (a person reclassified them: staging is scratch) |

Toolboxes: makers hold `drive` in ask mode with only the read tools and `write_file`; leads and reviewers
read it. Only AI Engineering holds `staging`.

## What is in the drive, and what is wrong in it

| File                                 | What it is                          | What a teammate should find                                                                                                                                           |
| ------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `care/contacts-2026-w39.csv`         | 219 contacts, 21 to 27 September    | 62 no-service contacts from the North West on Saturday evening; 19 about Wi-Fi dropping from Tuesday; 16 about being charged twice (3 of them second contacts)        |
|                                      |                                     | 6 where the assistant promised a £25 credit; 4 priority customers, 2 of whom waited 171 and 205 minutes for a callback promised within 2 hours                        |
| `network/incidents-2026-09.csv`      | 8 incidents                         | INC-2609-07: 41,200 customers, 18:42 to 22:55, a change brought forward from 02:00, the status page 49 minutes late; the Hub update and the billing run have no entry |
| `policies/compensation-policy.md`    | v7, in force                        | under 2 full working days earns no automatic credit; nobody promises a goodwill amount in a message to many                                                           |
| `care/help-centre/broadband-down.md` | the article the assistant quoted    | it still gives v6's £25, and the Hub light colours of the old Hub                                                                                                     |
| `policies/assistant-guardrails.md`   | what Ask Cirrus may and may not say | the rules the prompt must enforce and the evaluation must test                                                                                                        |
| `content/catalogue-2026-09.csv`      | 46 rows of the Stream catalogue     | 4 titles without an age rating, 2 rated 18 filed under Kids and Family, 3 listed after their licence ended, 3 without subtitles, 2 ids used twice, a runtime of 0     |
| `content/viewing-2026-w39.csv`       | the week's viewing                  | the most watched title leaves Stream on 4 October                                                                                                                     |

## Set it up

As for Lighthouse (`deploy/demo/lighthouse/README.md`, Set it up): Claude Code signed in, `apps/worker/.env`,
`ROSTERDOCK_PETER_CLAUDE_BIN=claude` in `apps/board/.env`, and Cirrus's two folders added to its
`ROSTERDOCK_STDIO_COMMANDS`: `npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Cirrus/drive` and the
same for `~/Cirrus/staging`. Then, with the board running and a company named Cirrus created on it by your
account:

```bash
node deploy/scripts/demo.mjs --demo cirrus --email you@example.com
pnpm dev:worker
ROSTERDOCK_WORKER_ID=worker-2 pnpm dev:worker
```

On the local kind cluster the folders go into the board pod's volume, next to Lighthouse's:

```bash
BOARD=$(kubectl --context kind-rosterdock -n rosterdock get pod -l app.kubernetes.io/component=board -o name | cut -d/ -f2)
kubectl --context kind-rosterdock -n rosterdock exec "$BOARD" -- mkdir -p /home/node/Lighthouse/cirrus/drive/published
kubectl --context kind-rosterdock -n rosterdock cp deploy/demo/cirrus/drive/. "$BOARD":/home/node/Lighthouse/cirrus/drive
kubectl --context kind-rosterdock -n rosterdock cp deploy/demo/cirrus/staging/. "$BOARD":/home/node/Lighthouse/cirrus/staging
node deploy/scripts/demo.mjs --demo cirrus --board http://127.0.0.1:8080 --email you@example.com \
  --no-seed --board-root /home/node/Lighthouse/cirrus
```

## The goals

Hand these to Peter from the company page (**New goal**). Pick the department where one is named, so its
lead plans it. Run 1 to 4 before the demo so there is finished work to open and writes waiting in Approvals;
5 is small and is the one to hand over live.

1. **Customer Insight**: "What drove customer contacts in week 39? From drive care/contacts-2026-w39.csv and
   drive network/incidents-2026-09.csv: the top reasons, every cluster with the incident or change behind
   it, repeat contacts, how the assistant did against drive policies/, and what needs a person today.
   Publish the report to the drive's published folder."
   Iris splits it for Quinn, Nia and Wren; Edie reviews the numbers against the files; the publish waits
   in Approvals.
2. **No department (Peter plans across the company)**: "Saturday's North West outage (INC-2609-07): write
   the post-incident review from the incident log and the contacts; draft the email and the text message
   to affected customers in line with drive policies/compensation-policy.md and the brand voice; rewrite
   the help-centre article drive care/help-centre/broadband-down.md so it matches the policy in force and
   the fact sheet. Publish the messages and the article to the drive's published folder."
   Nia, Sage and Hope. The moment to show: the exact text a customer would get, waiting in Approvals with
   its sha256, after Edie has checked it promises nothing the policy does not give.
3. **AI Engineering**: "Ask Cirrus told customers they would get £25 for Saturday's outage. Build what
   would have caught it: an evaluation set of 40 cases drawn from drive care/contacts-2026-w39.csv that
   covers every rule in drive policies/assistant-guardrails.md, a system prompt for the assistant that
   enforces them, and a dependency-free Node script with tests that scores a file of answers against the
   set offline. Put all three in staging."
   Archy has Goldie write the set before Paige writes the prompt it judges; Dex builds the scorer; Tess
   tries to get an amount, a diagnosis and a priority customer past each.
4. **Content**: "Check drive content/catalogue-2026-09.csv: every title with missing or impossible details,
   listed after its licence ended, or filed where its age rating does not belong; list the fixes and which
   need a person. Then write this week's What to watch from drive content/viewing-2026-w39.csv. Publish
   both to the drive's published folder."

5. **Customer Care**: "1,840 customers who moved to Fibre 900 were charged twice on 24 September
   (INC-2609-06 in drive network/incidents-2026-09.csv). Draft the email that tells them what happened and
   when their refund arrives, in line with drive policies/compensation-policy.md and the brand voice.
   Publish it to the drive's published folder."
   Hope plans it for Sage; Edie holds it to the policy's five working days.

## Twenty minutes, in order

With goals 1 to 4 run beforehand and their writes left waiting in Approvals:

1. **Company**: four departments, fifteen teammates, four goals done or waiting on you. One sentence on
   what Cirrus is and what went wrong in its week.
2. **Hand goal 5 to Customer Care** (New goal, pick Customer Care). Hope plans it in about a quarter of a
   minute; leave it running and come back at the end.
3. **Board**, goal 1's tasks: open the first one. Outputs lead with the file review approved; Reviews shows
   the reviewer recounting the analyst's table against the CSV and sending it back, round after round, and
   the board stopping the loop after three for a person to decide.
4. **Approvals**: the text message and the email for Saturday's outage, the exact bytes with their sha256.
   Approve the text. Reject the one that replaces the live help-centre article (the goal asked for the
   published folder) and say why; Peter re-plans it.
5. **See the result** on goal 3: the evaluation set, the system prompt, the scorer. In a terminal,
   `node --test` in the downloaded folder: the tests include the £25 answer failing.
6. **Settings > Connections** and a maker's toolbox: `write_file` asks, `move_file` is off, a reviewer only
   reads. **Costs** by model: Opus reviewing, Sonnet and Haiku making.
7. **Office** or **Board** again: goal 5's tasks moving, Sage's draft in review.

## What to show while it runs

- **Board**: tasks created by Peter and the leads, dependencies holding later tasks in To do.
- **Office**: who is at a desk, who is talking to whom.
- **A review**: the diff by hunk, comments anchored to lines, the checks, a request for changes and the
  second round. Edie sending back a message that promises a credit is the one to find.
- **Approvals**: the exact file a teammate wants to write, with its sha256; approve one, reject one and
  watch Peter re-plan the rejected task.
- **A goal's result**: See the result on a finished goal; The approved file against each write.
- **Settings**: the two connections, the tool a person switched off, a teammate's toolbox (the ceiling),
  the department's policy on top of it.
- **Costs** by model and by teammate; **Activity**, which is the one event stream everything else reads.
- **Design from a brief** (Company page): "I need a retention function that reads the cancel-service
  contacts each week and drafts a save offer for a person to approve." Accept the draft.

## What it costs

Measured on this company with the brains above, at the API's list prices, reviews and restarts included
(most of the tokens are cache reads): goal 1 took 12.4M tokens over five tasks (US$11.91), goal 2 10.0M over
six (US$8.40) and goal 3 7.1M over five (US$6.77). Expect US$7 to US$12 a goal, more when a reviewer sends
work back for several rounds; the Lighthouse demo's research goal took US$22.72. Set a company budget in
Settings before you start. On a Claude subscription (the CLI's own sign-in) the same runs count against its
usage limits instead of a bill.
