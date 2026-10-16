# RosterDock fact sheet

What RosterDock is and does, for anyone at Lighthouse writing about it. Every claim in a page, a post or a
comparison must be one of these, or come from a cited source. If something is not here, it is not a
feature: write it as a gap or leave it out.

## In one sentence

RosterDock is a self-hosted, Kubernetes-native platform for running an AI company: departments staffed by AI
teammates, a project manager teammate that plans and re-plans the work, a shared kanban, agent-to-agent
messaging and line-by-line review, with people approving only merges and writes to live systems.

## Who it is for

Teams that want AI agents doing real work across several functions (engineering, research, marketing,
finance) on their own infrastructure, with a record of every action and a person in charge of anything
that leaves the building.

## How it runs

- Ships as a Helm chart; runs on your Kubernetes cluster. A Docker Compose file runs the whole thing on
  one machine for trials.
- Three parts: the board (the API; owns all state and the event stream, on Postgres), the web app, and
  workers that run the teammates' engines in ephemeral, sandboxed pods.
- Open source under the Apache 2.0 licence.
- Sign-in with OpenID Connect against your own identity provider.

## Teammates

- A teammate is a brain (an engine and a model), a persona, playbooks, and a toolbox.
- Engines: Claude Code, Codex and OpenCode, per teammate. One company can mix them.
- Teammates are first-class actors: they author tasks, send messages, review each other's work, and
  appear in the activity feed and the office view by name.

## Peter, the project manager

- Give Peter a goal in plain words. He writes the background, the outcome and a done definition, splits
  the goal into tasks with dependencies, criteria and expected files, and assigns them by role and load.
- He may ask up to four questions once, before planning.
- When a run fails he re-plans it with a note; after repeated failures he asks a person.
- Each department can have its own lead who plans that department's goals the same way.
- Peter can also propose a new department from a brief, and audit the company for idle teammates,
  missing reviewers and risky sandboxes.

## Work and review

- A shared kanban per company: To do, In progress, In review, Blocked, Done.
- Every finished run opens a review of its diff, file by file and hunk by hunk. Reviewers (teammates or
  people) comment on lines, score against the task's weighted criteria, request changes or approve.
- Automatic checks on every review: a secret scan, the declared outputs exist, the repository's tests,
  the evaluation score, and sources for research.
- Teammates never mark work Done. An approved review does, and a person can veto any review.
- On GitHub an approved review opens a pull request; on GitLab a merge request. Merging is a person's job.

## Tools and approvals

- Teammates reach outside systems through MCP connections (over HTTP or as a local process) and OpenAPI
  services, including OAuth sign-in for MCP servers that use it.
- Each teammate's toolbox names connections with a mode: off, read or ask. It can grant only some of a
  connection's tools. A department's write policy and a project's client policy only ever narrow it.
- Reads run at once. A write is proposed with its exact payload and a sha256 of it; a person approves;
  the board sends exactly those bytes or nothing.
- Secrets are names, never values, in every row, event, log and response.

## Running the company

- Roles: owner, admin, reviewer, viewer, teammate. Everything is per company.
- Budgets per company, department, project and teammate; costs by model, teammate and department with
  a forecast.
- Needs-you notifications by webhook or email when something waits for a person.
- One event stream: the activity feed, the office (a pixel view of who is working on what), metrics
  and traces are all views of it.
- Company shapes (teammates, departments, connections, policies) export and import as one JSON file.

## Not decided or not built

- Pricing: not decided. Do not state a price, a tier or a free plan.
- A hosted version: none. RosterDock is self-hosted only.
- Customers and logos: none may be named.
- Certifications (SOC 2, ISO 27001): none. Do not claim any.
