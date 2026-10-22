# Security notes

What RosterDock guarantees, how, and what it needs from you. Written for the person who approves running
model output on their cluster.

## The rules that never soften

- **Humans gate only merges and live external writes.** Everything else is autonomous by design. A merge
  happens on your git host by your hand; a write to a live system happens only through an approval.
- **Secrets are names.** Every credential the platform uses is an env var NAME or a Secret reference on a
  row, in an event, in a file, in the UI. Values live in your secret store and reach exactly one process:
  the board resolves a connection's credential at call time, for the connection's company (below), and
  hands it to the HTTP client or the child process; the worker hands the engine's key to the engine
  process. `assertNoRawSecrets` runs on every request body, every imported file and every artifact: a
  value where a name belongs is refused. A connection that authorises by OAuth is the one case where the
  board obtains a value itself: it keeps it in the secret store you turned on (`board.oauth.enabled`),
  under the connection's name, and the row keeps the name.
- **A value set from Settings goes to the store, not the database.** Settings > Connections > Secrets takes a
  name and a value from an owner or admin. The value goes write-only into the secret store you turned on
  (`board.oauth.enabled`; files under compose), under `rosterdock-company-<id>` with one key per name; the
  row keeps the name, when and by whom; the event carries the name; no route returns a value, and the
  panel never shows one again. That company's connections and notifications resolve the name there
  first, then among the names the operator shares, so a value set in Settings wins over a shared one.
  Without a store the route refuses.

- **External writes are propose, approve, execute.** A teammate proposes the exact payload; the board
  stores it with its sha256; a person approves; the executor re-hashes the stored payload and sends those
  bytes or nothing. There is one door (`callConnectionTool`) with two callers: the broker's read path and
  the approval executor. The worker starts every engine with the board as its only MCP server.
- **Teammates never mark Done.** An approved review does; a person can veto any review. While a blocking
  check of the round has failed (the credential scan of the diff, the repository's tests), a teammate
  reviewer cannot approve: a person may, and the approval's event names each check they approved over.
- **Policy only narrows.** A teammate's toolbox is the ceiling (a connection with a mode, and optionally
  only some of its tools: the rest are never listed to that teammate and refused if called); the
  department's write policy and the project's client policy tighten it and never widen it. Files import
  grants only on connections the company already has. A grant is what a person saved: in the teammate's
  editor each tool allowed or set to never is a change to save, kept until Save while the board updates.
  The department and the client are those of the teammate's own task: in a run, the run's task; outside
  one, a task assigned to the teammate. A tool call or listing that names any other task is refused, so
  no task lends its policy to another.
- **One event stream, per company.** Every mutation appends an event in the same transaction, with the
  actor (a person or a teammate). Activity, the Office, notifications, metrics and traces are projections
  of it. Every row carries `company_id`; every company route goes through one role guard, and every board
  tool a teammate calls over MCP is checked against the same role matrix.

## Companies on one board

Every company on a board is a tenant. Its owners and admins manage the company; the operator (whoever sets
the chart values and the board's environment) manages the board, decides what a company can reach, and
decides who may found one (Identity, below). A person who signs in belongs to no company until an owner
invites their email.

What an owner or admin of one company can reach:

- Everything in their company: its rows, events, teammates, connections, approvals, and its secrets by
  name.
- The values of their company's secrets, through the connections they configure. A connection sends its
  credential to the server it names, so whoever manages connections can send a company secret anywhere;
  that is theirs to do.
- The values of the names the operator shares (`ROSTERDOCK_SHARED_ENV_NAMES`, chart `board.sharedEnvNames`),
  the same way. A shared name is a credential handed to every company's owners and admins: share one only
  when you would. Per-company credentials belong in each company's secrets (Settings > Connections >
  Secrets, which needs `board.oauth.enabled`).
- Public addresses, through the board, and the private destinations the operator lists. An HTTP or OpenAPI
  connection, the OAuth endpoints its server names, and the company's own webhook and SMTP server are
  requests from the board pod to an address the company chose, so each is checked before it is sent: a
  loopback, private, link-local (cloud metadata) or other non-public address is refused, a name that
  resolves to one included, unless `ROSTERDOCK_PRIVATE_DESTINATIONS` lists it (What a company's connections
  reach, below).
- The command lines the operator lists for stdio connections (`ROSTERDOCK_STDIO_COMMANDS`, chart
  `board.stdioCommands`; none by default). Such a server runs inside the board pod as the board, so a
  server that reads files or runs commands reaches what the board can: the board process's environment
  through `/proc` (its database URL and every other value), every company's secrets when the store is
  files (`ROSTERDOCK_SECRET_STORE=file:`), and with `board.oauth.enabled` the pod's service account token,
  which reads every Secret in the namespace. A line that ends in `*` lets the company choose the further
  arguments, such as the folders a filesystem server serves, which can then be any of those. List only
  servers you would let every company's owners and admins run, pinned to a version, with their
  arguments pinned: one line per folder for a filesystem server, never a `*` after it.

What they cannot reach:

- Another company's rows, events, connections, secrets or teammate templates. Every company route checks
  the caller's role in the company it names, and a route that names no company returns nothing of a
  company the caller is not in: the teammate templates there are the built-in ones, and a company's own
  come only through the company. A company's names resolve from its own secrets. A stdio child the board
  keeps between calls serves the company that started it, with the values it started with, and no other.
- The board's own environment: its database URL, its worker token, the object store's keys, its model keys,
  its sign-in client secret, or any other variable on the board pod the operator has not shared. A name a
  company writes (a connection's credential, the env var names handed to a stdio command, an OAuth client
  secret, a notification webhook or SMTP URL) resolves from the company's secrets and the shared names and
  nothing else. A name that is set where the board runs, not shared, and not one of the company's own
  secrets is refused when it is written (403), and a templates file that carries one has that connection
  skipped with a note. A row written before this rule that names one simply does not resolve. The board
  refuses to start when `ROSTERDOCK_SHARED_ENV_NAMES` lists one of its own names: `DATABASE_URL`, the
  `S3_` keys, `OTEL_EXPORTER_OTLP_HEADERS`, and anything under `ROSTERDOCK_`, `ANTHROPIC_`, `CLAUDE_`,
  `CODEX_` or `OPENAI_`. On the board, the one way around this is a stdio server the operator lists that
  reads files or runs commands (above), which is why none is listed by default. The worker pods hold the
  same database URL and the worker token, and a company's runs can read them there (below).
- Any other command inside the board. A stdio connection starts only a command line the operator lists,
  matched exactly up to a final `*`. One that is not listed is refused when it is written (on create, on a
  change of its command or arguments, and on discovery: 403), skipped with a note in an imported file, and
  never started, whatever an older row says: the check runs again before every start.

The worker fleet is shared, and it is not a boundary between companies. Every company's runs go to the
same worker pods: a department's sandbox picks the pool (`worker.pools`), and any company's department may
name any pool. The pods are hardened (Workers run model output, below): a read-only root filesystem, the
repository's tests without the engine's keys, Claude Code with only the built-in tools its list names, and
a run's outputs read only as files, never through a link. What they do not do is keep a company's code
away from the worker process. Code a company controls runs in those pods as the worker's user:

- The repository's own `test` script. When the engine finishes, the worker runs it in the workspace
  (`ROSTERDOCK_RUN_REPO_TESTS`, on by default), outside any engine sandbox. It gets PATH, HOME, the temp
  directory, the locale and `CI=1`, and no key or token. Whoever can push to a project's repository, or
  ask its teammates to change the tests, writes that script.
- The commands an engine runs in a shell. Codex always has one; its sandbox (`ROSTERDOCK_CODEX_SANDBOX`)
  limits what the commands write, not what they read. Claude Code has one when the worker's list names
  Bash (`worker.claudeAllowedTools`, per pool too); a department's list only narrows that one.

The worker process still holds the board's `DATABASE_URL`, the worker token (`ROSTERDOCK_WORKER_TOKEN`),
the git token (`worker.gitSecret`) and the model keys, and code running as the same user can read them
from its environment (`/proc/1/environ`). The database URL is the board's own and the worker's network
policy lets the pod reach Postgres, so with it that code reads and writes every company's rows,
memberships and tokens included. The worker token claims any company's queued run (the queue names them
all), and with it that run's pack and run token. The worker ends the engine it starts, not what the
engine starts in turn, and the repository's tests with their whole process group, not a process that
leaves the group (`setsid`, a daemon): a process a run leaves running carries on beside the next runs the
pod takes, whichever company they are for, and so does whatever a run leaves in the pod's home and temp
directories.

So host on one board only companies that trust each other with all of that. Where that is not so, keep
company code off the worker's user: turn the tests off (`ROSTERDOCK_RUN_REPO_TESTS=0`, chart
`worker.extraEnv`), put no Codex key (`OPENAI_API_KEY`, `CODEX_API_KEY`) in `worker.engineEnvNames`, and
leave Bash out of `worker.claudeAllowedTools` in every pool. That takes away the shells; the database URL
and the worker token stay in the pods, so companies that must not reach each other still need boards of
their own, each with its own database and workers.

## Identity

- Production sign-in is OpenID Connect with PKCE against your provider. The board verifies each id_token
  (signature against the provider's JWKS, issuer, audience, expiry, nonce) and keeps only the subject,
  email and name. No provider token is stored. `ROSTERDOCK_OIDC_ALLOWED_DOMAINS` narrows who may sign in. At a
  public provider anyone holds an account (Google, Microsoft's `common`, `consumers` and `organizations`
  endpoints, GitLab.com, Apple), so the board will not start there with no domains listed, and the chart
  will not render: list your domains, or `*` to let every account in on purpose. The board knows those
  providers by their issuer; at another that anyone can join, list the domains yourself.
- Who may found a company is the operator's call: `ROSTERDOCK_COMPANY_CREATORS` (chart
  `board.companyCreators`) lists emails and `@domain`s, or `*` for anyone who signs in. Without a list, the
  first person to create a company on an empty board owns it and nobody creates another; with the dev login
  on, anyone may, since the dev login lets anyone sign in as anyone. A company's owner pays for what its
  teammates run on your workers and keys, so keep the list to the people you would give that to.
- Sessions are random tokens stored as sha256, in an httpOnly, SameSite=Lax, Secure cookie. One lasts 30 days
  from sign-in (`ROSTERDOCK_SESSION_TTL_SECONDS`, chart `board.extraEnv`).
- A teammate acts on the board with a bearer token stored as sha256, of one of two kinds. A run token is
  minted when a worker claims the run and deleted when the run ends or is claimed again (eight hours at
  most). An owner or admin can also mint one for a teammate
  (`POST /api/companies/:companyId/teammates/:teammateId/tokens`, shown once, recorded as an event): it
  lasts a day by default and up to 30 days, and with the `manager` scope it also reaches the board's MCP
  server outside a run, naming the task in each call. No route revokes a minted token; it stops working
  when it expires or the teammate is deleted. Either kind is the teammate on its company's REST API, not
  only in a run: it may do whatever the teammate role may (below). The worker routes take a run token for
  its own run only. The worker fleet presents a shared claim token (`ROSTERDOCK_WORKER_TOKEN`) compared in
  constant time.
- Roles: owner, admin, reviewer, viewer, teammate. Owners and admins manage the company, connections,
  toolboxes, templates and approvals; reviewers decide reviews; viewers read. A teammate, with either kind
  of token and in its own company only, reads the company and its events, files and updates tasks, posts
  messages and review comments, decides the reviews it is assigned, and opens and renames projects; it never
  sets a project's repository, default branch or client policy, on a project or on a goal that opens one (a
  request that names one is refused whole), never manages connections, departments, teammates or members,
  and never decides an approval.
- Only an owner grants owner, or changes or removes an owner, and a company always keeps one: neither an
  admin nor the last owner can leave it with none.
- The dev login (`ROSTERDOCK_DEV_LOGIN=1`) signs anyone in as anyone. Never in production; the chart warns.
  `docker-compose.yml`, which runs with it on, publishes its ports (the web, the board, Postgres, MinIO) on
  127.0.0.1 only, so another machine on your network reaches none of them.

## Workers run model output

- Each run gets a fresh directory on an ephemeral volume that dies with the pod; the next run sees
  nothing of it, and only what the board stores (artifacts, checkpoints, usage) outlives the run. The
  pod's home and temp directories last as long as the pod, so runs the pod takes in turn share them.
- git in the worker gets PATH, the temp directory and the locale, none of the worker's credentials, and
  reads no system or global config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` empty), so a
  `~/.gitconfig` an earlier run left behind changes nothing. It runs no hook and no fsmonitor, and the
  diff runs no textconv. Before the worker reads a run's changes back, it puts the clone's `.git/config`
  back as the clone wrote it, so a filter the run added never runs; a run that replaced `.git` gets no
  review of its changes.
- The git token (`worker.gitSecret`) goes into a clone's URL only over https and only to the hosts it is
  for (`worker.gitSecret.hosts`, `ROSTERDOCK_GIT_TOKEN_HOSTS`; github.com by default), and the clone's
  remote is set back without it. A clone that fails, or that Stop, the time limit or a shutdown ends
  part-way, is removed at once, so no `.git/config` with the token in its URL stays on disk. A project
  whose repository is on any other host is cloned with no token, so whoever sets a project's repository
  cannot send the fleet's token somewhere else.
- An artifact over 512 KB goes to the object store as bytes the board has already scanned for raw
  secrets, under a key of the company, the run and its hash; the board signs each request itself with a
  key pair it reads by name, and the worker never holds that pair.
- Worker pods run as non-root with a read-only root filesystem, all capabilities dropped, the default
  seccomp profile, and no service account token. The one exception is `worker.podMetrics.enabled`: the
  worker then has an account of its own with one Role, get pod metrics in the namespace, and its token
  mounted, so it can read its pod's CPU and memory from the metrics API; that account is never bound to
  the board's Secrets Role. It also opens every worker pod's egress on ports 443 and 6443 to any address,
  for the API server: private ranges and the rest of the cluster included, and in every pool, the ones
  that otherwise reach only the board and Postgres too.
- With `networkPolicy.enabled`, a worker reaches DNS, the board, Postgres and public HTTPS (the model
  API, the git host), with every private range excluded; nothing reaches it. Postgres is any address on
  `postgres.port` until `postgres.cidr` names it. A pool (`worker.pools`) narrows further, down to the
  board and Postgres only, and a department's sandbox chooses the pool.
- The engine sees only the env var names the worker was told to pass, narrowed again by the department's
  sandbox, which also sets a time limit. A department's tool list narrows the worker's Claude Code
  allowlist (`ROSTERDOCK_CLAUDE_ALLOWED_TOOLS`, chart `worker.claudeAllowedTools`, per pool too) and never
  widens it: a tool the worker does not allow is left out of the run, and the run log says which. The
  narrowed list is the whole of Claude Code's built-in tools for the run (`--tools`), not only the ones it
  may use without asking, so a list without Bash leaves the engine no shell, read-only commands
  included; the rules on it (`Read(./**)`) are what it may do with them without asking. Codex
  has no per-tool list, so the worker holds it to the department's with Codex's own controls, which only
  narrow the worker's Codex sandbox (`ROSTERDOCK_CODEX_SANDBOX`): without Write or Edit it runs
  read-only, without WebFetch its commands get no network (a worker on `danger-full-access` comes down
  to `workspace-write`, so Codex's own sandbox has to work in that pod), and without WebSearch its web
  search is off. Codex reads files and runs commands only through its shell, so it does not run under a
  list that leaves out Bash or allows only some commands (`Bash(npm test:*)`): the worker fails the run
  before it clones anything, and the board refuses to seat a Codex teammate in such a department, to set
  such a list where one sits, or to move a teammate who sits there to Codex.
- A run cannot file its way out of its department. A task a teammate files from a run, in any project,
  takes the department of the run's task, so its run gets the same sandbox, pool and write policy; the
  board refuses another department, or none, over MCP and REST alike. Outside a run a teammate names only
  a department it belongs to.
- Claude Code starts with no settings file (`--setting-sources` empty): not the operator's, and not the
  cloned repository's `.claude/settings.json`, so a repository cannot allow itself a tool or add a hook.
  Codex starts with `--ignore-user-config` and `--ignore-rules`, so no rules file in its home or the
  repository lets a command out of its sandbox (a rule that allows a command runs it unsandboxed), and with
  its ChatGPT apps and plugins off, so a worker signed in to ChatGPT brings none of that account's
  connectors into a run.
- After the engine, the worker runs the repository's own `test` script in the workspace
  (`ROSTERDOCK_RUN_REPO_TESTS`, on by default), once the diff is captured. That script is the
  repository's code and the run may have rewritten it, so it gets PATH, HOME, the temp directory, the
  locale and `CI=1`, and no model key, board token or git token. It still runs as the worker's user in
  the worker's pod, so it reaches what that user reaches, the worker process's own environment under
  `/proc` included, and its output becomes the review's tests check as written. Turn the step off on a
  fleet that runs repositories you would not run yourself. The script leads a process group of its own,
  which the step ends (SIGTERM, then SIGKILL two seconds later) past its time limit, on Stop and when the
  script ends by itself, so a server or a watcher it starts does not outlive the step; a process that
  leaves the group (`setsid`, a daemon) is not reached.
- The engine reaches no external MCP server. Every tool call goes to the board (`board_tool_call`),
  where the broker decides: run a read, propose a write, or refuse. A tool is a read only when the
  connector's catalog lists it as one, a person classified it so, or its name starts with a reading verb
  (get, list, search, read and the like) and joins no second verb to it (`get_or_create` writes). Export,
  preview and check are not reading verbs. A server's own read-only label (`readOnlyHint`) counts only with
  the catalog's list or such a name: a tool the label alone calls a read is a write until an owner or admin
  confirms it under Settings > Connections, a decision recorded under their name that discovery keeps. A
  server's word that a tool writes or destroys outweighs the catalog and the name. Anything else is a write.
- A run's diff is scanned for secret-shaped values before review, anywhere in an added line (a key after
  `NAME=`, in a string, behind `Bearer`), and for values given to secret-named keys, quoted or as
  `NAME=value`; a hit fails the check.
- A run delivers files, never links. The worker reads a declared output, a changed file, the handover and
  `blocked.md` only as a regular file inside the run's directory, reached without a symbolic link. A link
  (`report.md -> /proc/self/environ`, a linked directory on the way) or a path out of the directory is never
  opened, so the worker's own environment never becomes an artifact; a completed run's summary names what was
  refused. In a repository, the diff carries such a link as the path it points at, as git stores it. With no
  outputs declared, the changed files are those git status lists, but never a path it calls deleted: a file
  the run took out of the index and kept there (a local `.env` that `.gitignore` matches) is not delivered,
  whatever it holds. Where git cannot stage the changes (a lock a git the time limit ended left behind), the
  run fails rather than send part of them for review.
- A run sent back with changes requested starts from that round only as its diff, checked against the
  sha256 the review recorded and applied with `git apply`, which writes nothing outside the clone, into
  `.git` or through a link. A round that would leave a link in the clone is undone, and the run starts
  from the clean clone instead. The worker finds such a link by reading the whole clone, a submodule's
  folder included, where git status and git clean never look; the undo empties those folders again, as
  the clone left them. A round that copies or renames a file is refused before it is applied: the
  harvest's diffs never do, and a copy could carry a link the repository holds into such a folder. A round
  that git apply fails to write whole (it checks first, but a write can still fail) is undone the same way.
- A worker run natively on Windows (`pnpm dev:worker` there, not in Docker or WSL2) keeps the rules above by
  other means. git's global config is `/dev/null`, which Git for Windows reads as its NUL device, and git
  looks for hooks under that device (`\\.\nul`), where no file can be. git there checks a link out as a plain
  file holding its target, so a rework round is refused by its diff alone: by a link it makes, or a change to
  one the repository holds, which HEAD's tree names whatever mode the diff spells and in whatever case it
  names the path. A round that deletes such a link or replaces it with a file carries over, as on Linux, and
  the harvest records a link the run changed as the file it now is, staged by the run or not (changed again
  since, too), at a path `.gitignore` matches as well: git add would keep it a link. A link the run took out
  of the index itself is not forced back in, so at a path `.gitignore` matches it and the file kept there stay
  out of the review. Windows looks for a program in the directory it starts in before PATH; the worker turns
  that off (`NoDefaultCurrentDirectoryInExePath`), so a `git.exe` or `claude.exe` in a clone never runs in
  place of the real one. Windows has no `O_NOFOLLOW`: a symbolic link or a junction anywhere on a file's way
  is refused, and the file is read only when the one opened has the file id of the one checked, compared
  whole, on the workspace's volume as a handle reads it. A file without an id is refused: 0, or the all-ones
  id ReFS gives a file whose own does not fit in 64 bits, so on a Dev Drive such a file is not delivered. By
  path, libuv 1.49 and 1.50 (Node 22.12 to 22.16, 23.1 to 23.11 and 24.0 to 24.1) misread the volume on
  Windows 11 24H2 and Server 2025. A stopped git ends with the helpers it started that still run
  (`taskkill /t`, where Linux has the process group). The repository's tests run in a job object, which ends
  every process they started, one whose parent has already ended included (not a program started for them by a
  service, WMI or the task scheduler). The worker asks once when it starts whether the job works there, and
  its log says so (no answer within 30 s is asked again at the next tests, and that wait counts against the
  tests' time limit). Without the job (Windows PowerShell blocked, or in the Constrained Language mode
  AppLocker and WDAC put it in, and the tests run under cmd.exe as before; or a Windows that cannot nest
  jobs), taskkill ends what it can still walk to past the time limit or on Stop, and what the tests leave
  running when they end by themselves carries on. File modes do nothing there: the MCP config that carries the
  run token is written to the temp directory and is private only while that directory is, as `%TEMP%` in your
  profile is by default. A `TEMP` outside the profile (`C:\Temp`) takes its folder's permissions, which under
  a drive's root let other users read it: keep the worker's `TEMP` in its profile. What does not carry over is
  the pod: the engine, its shell and the repository's tests run as your Windows user, with your files, your
  credentials and your other programs within reach, and nothing the engine leaves running ends with the run.
  Run anything but your own repositories in Docker or WSL2.

## The board

- Runs as non-root, read-only root filesystem, all capabilities dropped; reads every credential from a
  Secret by name; logs redact the headers that carry tokens; nothing logs a value.
- The board's egress is wide by design (model API, git host, MCP servers, webhooks); narrow
  `networkPolicy.board.egressTo` to the destinations you use. What a company chooses is also checked by the
  board itself, public addresses only unless you list a private one (What a company's connections reach,
  below). With `board.oauth.enabled` the board also
  reaches any address on ports 443 and 6443, for the API server, whatever `egressTo` lists: private
  ranges and the rest of the cluster included.
- `/metrics` is served on the board's own port and never proxied by the web; keep the board's Service
  internal (the default) and reach it with a scraper inside the cluster, or put a bearer on it
  (`board.metricsSecret`) where the port is reachable.
- Migrations run on boot from the image; the board needs no cluster credentials and mounts no service
  account token, unless `board.oauth.enabled` is on. Then the board pod gets its token and one Role: get,
  create, update and delete Secrets in the release namespace, so it can keep the tokens a connection's
  OAuth flow obtains (one Secret per connection, `rosterdock-connection-<id>`, written and read by the board
  alone; the row keeps the name). A Role cannot name Secrets that do not exist yet, so it reaches every
  Secret in the namespace: keep RosterDock in a namespace of its own, as the install guide does. Outside a
  cluster the same store is a directory of files (`ROSTERDOCK_SECRET_STORE=file:<dir>`); without either, no
  connection authorises by OAuth.
- When a research review opens, the board fetches the public http(s) links the documents cite so the reviewer
  can read them. Literal addresses, localhost and internal-looking names are refused on every hop, and so is a
  name that resolves to any address that is not public: loopback, private, link-local (where cloud metadata
  lives), unique-local, shared and the other special-purpose ranges, an IPv4 written as IPv6 included. The
  board connects only to the addresses it checked, so a name cannot pass the check with one address and send
  the connection to another. A source gets five seconds and half a megabyte, only text is kept, secret-shaped
  strings in it are redacted, and what a page says reaches the reviewer as quoted material.
  `ROSTERDOCK_FETCH_SOURCES=0` (chart `board.fetchSources: false`) keeps the board off the web.

## What a company's connections reach

- **What is checked.** Every destination a company chooses: an MCP server over HTTP and an OpenAPI service
  (their checks, discovery and every call), the OAuth endpoints an MCP server names (its resource metadata,
  its authorization server's metadata, registration, the code exchange and every refresh), and the
  company's own webhook and SMTP server from Settings. A style pack's download, from RosterDock's own
  catalog, goes the same way.
- **The rule.** A connection, its OAuth and a webhook are http or https, with no credentials in the URL; an
  SMTP server's `smtp://` or `smtps://` URL carries its credentials by design. An address written in the URL
  is checked as it is, so a public one is reached (the web connection, unlike this, refuses every written
  address). A name is resolved and every address it gets is checked, and one address the board may not
  reach refuses the name whole. Loopback, private, link-local (where cloud metadata lives), unique-local,
  shared (carrier-grade NAT) and the other special-purpose ranges are refused, an IPv4 written as IPv6 by
  its IPv4, as for the web connection (Reading the web, below). The board connects only to the addresses its
  own lookup admitted, so a name cannot pass the check with one address and send the connection to
  another; the SMTP connection's socket takes the same lookup. The board sets the Host header and the
  body's framing itself, so no header a company names (a credential header called Host) reaches another
  server behind a shared ingress. A refusal reads "refused: ... which this board's operator has not
  allowed" on the connection's check, in Activity and in the call's result, and names the kind of address
  a name resolves to, never the address. An SMTP server's errors quote only what is shaped like an SMTP
  reply, so another service's banner is never repeated.
- **OAuth's endpoints.** The authorization server an MCP server names, and the authorization, token and
  registration endpoints that server's metadata names, must be https, or plain http to a destination the
  operator lists (by name, or an address or a name whose every address is in a listed range: a server on
  this machine in development); a script or data URL never reaches a person's browser, and the web checks
  the consent page's scheme again before it goes there. An issuer and a token endpoint a connection kept
  from before these checks are held to them too. The resource an MCP server declares must be on its own
  origin, so the board never asks for a token named for another service; which authorization server it
  names stays the server's choice, and a person consents on that server's page before any token is issued.
- **Redirects.** An MCP server is followed within its own server (`/mcp` to `/mcp/`, or http to https on
  the same host and the default ports), its credential kept and every hop checked again, when the call
  arrives as it was sent: a 307 or 308. A 301, 302 or 303 would turn its POST into a GET without its body,
  so it is refused, and the refusal names the address to use (the same server's, without its query). A
  redirect to another server is refused. An OpenAPI operation, a webhook, OAuth registration and the token requests follow none: the
  credential and the call go to the URL the company gave, or nowhere. A refusal names the server it pointed
  to (scheme, host and port), or the kind of URL, never a path, which may carry a token. An OpenAPI
  connection's check takes a redirect as its answer and follows nothing. OAuth discovery and a style pack's
  download follow three at most, every hop checked again, and a hop to another origin keeps only the
  headers that say what is wanted (no credential, whatever it is called).
- **Size.** The board reads no more of an answer than its call site's cap, decoded, so a small compressed
  body cannot fill the board's memory: an MCP answer 8 MB (an event stream counts every event on it),
  OAuth metadata and token answers 256 KB, an OpenAPI operation its manifest's response cap (the answer is
  cut there and read no further), a style pack 256 KB, an SMTP reply's line 1,000 characters and a reply
  100 lines. A webhook's answer and an OpenAPI check's body are never read.
- **Time.** One deadline per request, looking names up included: an MCP request's is the call's timeout
  (30 seconds) up to the answer's headers, after which an event stream stays open until the call ends;
  an OpenAPI operation takes its manifest's timeout, OAuth 15 seconds, a webhook 15, and an SMTP exchange
  15, connecting and its TLS handshake included. A connection kept between requests closes after four idle
  seconds.
- **The operator's list.** `ROSTERDOCK_PRIVATE_DESTINATIONS` (chart `board.privateDestinations`) names the
  private destinations companies may use: host names (`*.tools.svc.cluster.local` for the names under
  one), addresses and ranges (`10.20.0.0/16`). A name is matched as the connection's URL writes it, without
  search domains. A listed address or range is reached whatever name led to it; a listed name is trusted
  with whatever it resolves to, so list only names whose DNS you control. Not a wildcard over the cluster's
  domain: cluster DNS answers `a-b-c-d.<namespace>.pod.cluster.local` with the address a.b.c.d (CoreDNS's
  `pods insecure`, the kubeadm, kind and EKS default), so `*.cluster.local` or `*.pod.cluster.local` hands
  every company `169-254-169-254.default.pod.cluster.local`, the cloud's metadata; and an ExternalName
  service is a CNAME to anywhere. List each service, or a namespace only you create services in. Every
  company on the board may use what is listed, except an entry given to one company (`<company id>=<entry>`):
  only that company reaches it, through a lookup and kept connections of its own, so another company's
  request never rides a connection opened for it or a name that answers differently between the check and
  the socket; and only that company's owners and admins see it in Settings. A stdio server is not held to
  any of this (What is not checked, below): one the operator lists with free arguments that fetches or
  proxies reaches whatever the board pod reaches, for any company. Unset, nothing private is: the
  board refuses to start on an entry it cannot read rather than guess. `apps/board/.env.example` lists
  loopback for development only.
- **What is not checked.** What the operator configures: the git hosts' APIs, the OIDC provider, the OTLP
  collector, the object store, the Kubernetes API, the model API, the board's own webhook
  (`ROSTERDOCK_NOTIFY_WEBHOOK_URL`) and SMTP server (`ROSTERDOCK_NOTIFY_SMTP_URL`). Those are often
  internal on purpose, and no company can change them. A stdio server (the operator's commands) and the
  worker's git clones are outside the board's check too (Workers run model output, above, and Reading the
  web, below).
- **What the check cannot see.** An address is judged by its range alone, so these look public to the board
  and pass: pod or service IPv6 that is globally routable; a NAT64 prefix of the cluster's own; IPv4 pod or
  service ranges outside the private and shared ranges (GKE's privately used public IPs, an on-premises
  cluster on squatted space); and public addresses that lead inside (Azure's platform endpoint
  168.63.129.16, a node's public IP with a NodePort, the cluster's own load balancer). Narrow
  `networkPolicy.board.egressTo` to keep companies from those: the check is the board's, the network policy
  is the cluster's.

## Reading the web

- **The web connection** is the board's own fetch. An owner or admin adds it under Settings > Connections (a
  company has one) and grants it in a teammate's toolbox like any connection. Its one tool, `fetch`, reads a
  page and never writes: the broker takes it as a read whatever its row says, nobody can make it a write, and
  nothing it does is proposed or approved. The board fetches; the worker never does.
- **What it can reach.** http and https pages at public addresses, nothing else. A URL with credentials in it,
  a literal address, localhost or an internal-looking name is refused. The name is resolved and every address
  it gets must be public: loopback, private, link-local (where cloud metadata lives), unique-local, shared
  (carrier-grade NAT) and the other special-purpose ranges are refused, an IPv4 written as IPv6 by its IPv4.
  The board connects only to the addresses it checked, so a name cannot pass the check with one address and
  send the connection to another. Every redirect hop is checked the same way, three at most. An address is
  judged by its range alone: where a cluster gives pods or services globally routable IPv6 addresses, or
  translates through a NAT64 prefix of its own, those look public to the board, so narrow
  `networkPolicy.board.egressTo` there. A page gets 15 seconds (looking its names up included) and 1 MB, only
  text is read, HTML is turned into text by the converter the research review uses (one pass, whatever the
  page holds), secret-shaped strings in it are redacted, and a call returns 30,000 characters of it at most.
- **Which sites.** The web connection may carry a list of domains, each with the sites under it; without one
  it reads any public site. A department (its sandbox's `webDomains`) and a project's client policy
  (`webDomains`) may each name a list, and a list only narrows: a page must be on every list there is, on
  every hop. A client policy that caps the connection at off switches it off for that client's work.
- **What it records.** Every page the broker lets a teammate ask for is a `tool.called` event, appended in
  its own transaction when the fetch ends: the teammate, the task, the run, the URL and where its redirects
  ended (without the fragment or credentials, and with the values of secret-named query parameters such as
  `token`, `key` or `X-Amz-Signature` redacted, 2,000 characters at most), the status, the bytes read and why
  it failed, a redirect named the same way. A refused address or site is recorded the same way. Never what
  the page says, and never a header beyond a non-text page's media type. The run's own log keeps the start of
  each tool call's arguments as the engine sent them, as it does for every tool, so a URL shows there as
  asked.
- What a page says reaches the teammate as material for its task, and the brief says it is not
  instructions. A page can still try to talk a model into something; the toolbox, the department's write
  policy and approvals bound what the teammate can do about it.
- `ROSTERDOCK_FETCH_SOURCES=0` (chart `board.fetchSources: false`) keeps the board off the web: the web
  connection fetches nothing and its check says why. The research review's source check is the board's own,
  not a teammate's: it reads the links a document cites through the same guard, whatever a company's list
  says.
- **A web tool a company brings** (search, a browser, a fetch server: the catalog's Web entries, or any MCP
  server or OpenAPI service) is a connection like any other. The broker decides each call and records each
  read with its argument names; what the tool fetches, and from where, is the tool's. A hosted search
  service fetches from its own network. A stdio server runs in the board pod as the board, so a fetcher or a
  browser there reaches what the board reaches: the cluster, the board's own port and, with
  `board.oauth.enabled`, the API server. The reference fetch server refuses private addresses by default but
  checks a name before it connects, not as it connects, so a name that changes its answer between the two
  gets through; a browser's origin lists are not a boundary at all. Run those as a service of their own,
  with a network policy that reaches public addresses only, list the service in
  `ROSTERDOCK_PRIVATE_DESTINATIONS`, and connect over HTTP.
- **The engines' own web tools** bypass the board. Claude Code's WebFetch and WebSearch run only when the
  operator lists them in the worker's tool list (`ROSTERDOCK_CLAUDE_ALLOWED_TOOLS`, chart
  `worker.claudeAllowedTools`), and a department's list only narrows that. Codex keeps its own web search (a
  cached index; live, with network for its commands, under `danger-full-access`) unless the department's list
  leaves out WebSearch (Workers run model output, above). WebFetch fetches from the worker pod, and what it
  reaches is what the pod reaches (with `networkPolicy.enabled` the default fleet reaches public HTTPS only,
  every private range excluded); a web search runs at the model's provider. None of it has the board's
  address check, a site list or a `tool.called` record: the run log shows the URL or query asked, like any
  tool input, and the brief tells the teammate it has them.

## What you own

- Postgres: its access, its backups, its encryption at rest. Every row is in it.
- The Secrets: their store, their rotation. Rotate by changing the Secret and restarting the deployment
  that reads it.
- TLS at the ingress; the cookie is marked Secure and the OIDC redirect uses the public URL.
- Who may reach the web (the ingress and `networkPolicy.webIngressFrom`), and which email domains may
  sign in.
- The private destinations you list for companies (`ROSTERDOCK_PRIVATE_DESTINATIONS`): every company on the
  board may make the board reach each one you list for all of them, so list a service for all only when every
  company may use it, give it to one company (`<company id>=<entry>`) when it is that company's, and list a
  name only when you control its DNS. The board's own destinations (the git hosts, OIDC, OTLP, the bucket,
  the API server, the model API, its webhook and SMTP server) are yours to point at what you trust.
- Rate limiting. The board limits only its sign-in routes (the dev login and the OpenID Connect start and
  callback): `ROSTERDOCK_SIGNIN_RATE_LIMIT` requests a minute from one client address to each, 60 by default
  (chart `board.signInRateLimit`, 0 for none), counted in each board replica's memory. Every other route takes
  a session or a token, or is a cheap public read (health, readiness, the sign-in options, metrics), and a
  limit across all of them belongs at the ingress (with ingress-nginx, the `limit-rps` and `limit-connections`
  annotations, through `ingress.annotations`). The board takes a client's address from the proxies in front of
  it (Fastify's `trustProxy`), the first entry of `X-Forwarded-For`, so the ingress must overwrite that header
  with the address it sees, never append to one the client sent; otherwise a client names its own address and
  leaves the sign-in limit behind. Behind a load balancer, have the ingress read the client's address from it
  (PROXY protocol, or the balancer's header from the balancer's range only), or every client counts as the
  balancer and shares one limit.
- The model's behaviour. The platform bounds what a teammate can touch (its toolbox, the write policy, the
  client policy, the sandbox, the pool) and what it costs (budgets, drift alerts); it does not make the
  model right. Reviews and approvals are where a person sees the work.
- The house style you switch on. A style pack (Settings > Style) is someone else's published rule file that
  every teammate's brief then carries. RosterDock pins each to a commit and the file's sha256, and the board
  uses a file only if it hashes to the pin, so the upstream cannot change what teammates read; RosterDock's
  own rules are stated as coming first. The board image built from this repository does not carry the pinned
  files: a company's first switch-on downloads the file once from `raw.githubusercontent.com` and keeps its
  text, and Settings says where each pack came from. For a board that cannot reach GitHub, run
  `node --import tsx scripts/vendor-styles.mts` in `apps/board` before building the image: it writes the
  files with their licences to `apps/board/styles/vendor`, which the image copies, and switching one on
  then downloads nothing.

## Reporting

A security concern goes to the repository's owners through a private channel, not an issue.
