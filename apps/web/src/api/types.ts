// Shapes the board returns. Kept in one place so the store and views agree.
import type {
  ActorRef,
  BlockerRecord,
  Criterion,
  DiffHunk,
  DiffLine,
  EventRecord,
  PlannerKind,
  PlannerSettings,
  ReviewStatus,
  Role,
  SandboxPreset,
  TaskStatus,
  ToolboxEntry,
  ToolMode,
  WritePolicy,
} from "@rosterdock/shared";

export type {
  ActorRef,
  BlockerRecord,
  Criterion,
  DiffHunk,
  DiffLine,
  EventRecord,
  ReviewStatus,
  Role,
  TaskStatus,
  ToolboxEntry,
  ToolMode,
  WritePolicy,
};

/** What the sign-in page can offer: the identity provider by label, and the dev login when the board allows it. */
export interface AuthProviders {
  devLogin: boolean;
  oidc: { name: string; startUrl: string } | null;
}

/** One brain Peter could plan with on this board, and whether it works here. */
export interface PlannerOption {
  kind: PlannerKind;
  label: string;
  available: boolean;
  /** Signed in and how, not installed, or not signed in and what to run. */
  detail: string;
}

/** How Peter thinks for the company: its choice, what that comes to on this board, and every option. */
export interface PlannerInfo {
  choice: PlannerSettings;
  effective: PlannerKind | null;
  reason: string;
  options: PlannerOption[];
}

/** A style pack in Settings: someone else's published rules for how teammates write. */
export interface StylePackInfo {
  id: string;
  label: string;
  what: string;
  /** What it governs in a brief: the code teammates write, or what they say. */
  applies: "code" | "replies";
  levels: string[] | null;
  level: string | null;
  enabled: boolean;
  source: { home: string; repo: string; commit: string; path: string; license: string; url: string };
  /** The board's build carries the pinned file, so switching on downloads nothing. */
  bundled: boolean;
  /** When the file was kept for this company; null until it first is. */
  fetchedAt: string | null;
}

/** What filling the price table with list prices did. */
export interface ListPricesResult {
  /** Models priced now. */
  added: string[];
  /** Models in use with no published list price (a person prices them). */
  unknown: string[];
}

/** What an import of a templates file did. */
export interface TemplatesImportReport {
  created: { teammateTemplates: string[]; teammates: string[]; departments: string[]; connections: string[] };
  /** Projects whose client policy the file set. */
  clientPolicies: string[];
  skipped: string[];
  notes: string[];
}

/** What the identity provider last said about the person; empty for a dev login. */
export interface UserProfile {
  picture?: string;
  preferredUsername?: string;
  givenName?: string;
  familyName?: string;
  locale?: string;
}

export interface Me {
  actor: ActorRef;
  user?: { id: string; email: string; name: string; profile?: UserProfile };
  teammate?: { id: string; name: string; handle: string; companyId: string };
  memberships: { companyId: string; role: Role; companyName?: string }[];
  /** Whether the board lets this person found a company now (the operator's list, or the first company). */
  mayCreateCompany?: boolean;
}

export interface Company {
  id: string;
  name: string;
  template: string | null;
  budgetTokensWeek: number | null;
  settings: Record<string, unknown>;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  userId: string;
  role: Role;
  email: string;
  name: string;
  since: string;
}

export interface DepartmentMember {
  teammateId: string;
  isLead: boolean;
  name: string;
  handle: string;
  role: string;
}

export interface Department {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  writePolicy: WritePolicy;
  /** The worker sandbox: tool allowlist, env names, a time limit, and the worker pool (M6). */
  sandbox: SandboxPreset;
  leadTeammateId: string | null;
  members: DepartmentMember[];
  createdAt: string;
  updatedAt: string;
}

export interface Teammate {
  id: string;
  companyId: string;
  templateId: string | null;
  name: string;
  handle: string;
  role: string;
  personaMd: string;
  playbooks: string[];
  engine: string;
  model: string;
  /** How hard the model thinks (low to max); null: the engine's default. */
  effort: string | null;
  avatar: string | null;
  /** Connections this teammate may use, with a mode each: the ceiling policy narrows from. */
  toolbox: ToolboxEntry[];
  departments: { id: string; name: string; isLead: boolean }[];
  createdAt: string;
  updatedAt: string;
}

export interface TeammateTemplate {
  id: string;
  companyId: string | null;
  name: string;
  role: string;
  personaMd: string;
  playbooks: string[];
  engine: string;
  model: string;
  avatar: string | null;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  client: string;
  goal: string;
  status: string;
  repoUrl: string | null;
  defaultBranch: string;
  /** What this project's client lets any teammate do with each connection, and the web sites it lets the web connection read. Only narrows. */
  clientPolicy: { default: ToolMode | null; caps: Record<string, ToolMode>; webDomains?: string[] };
  /** A cost centre, client code or invoice reference the monthly cost report groups by. */
  chargebackTag: string | null;
  counts: { open: number; running: number; blocked: number; review: number; done: number };
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  companyId: string;
  projectId: string;
  departmentId: string | null;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: ActorRef | null;
  createdBy: ActorRef;
  blocker: BlockerRecord | null;
  doneBy: Record<string, unknown> | null;
  messageCount: number;
  dependsOn: string[];
  declaredOutputs: string[];
  criteria: Criterion[];
  activeRunId: string | null;
  /** research: documents with sources, reviewed against a checklist. build: the diff is reviewed. */
  workKind: "build" | "research";
  parentTaskId: string | null;
  /** The goal the task serves; null for work outside any goal. */
  goalId: string | null;
  /** How many times Peter re-planned it after a failed run. */
  replans: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  taskId: string;
  author: ActorRef & { name: string | null };
  body: string;
  mentions: { kind: "teammate"; id: string; handle: string; name: string }[];
  createdAt: string;
}

export interface CompanyData {
  company: Company;
  members: Member[];
  departments: Department[];
  teammates: Teammate[];
  projects: Project[];
  tasks: Task[];
  events: EventRecord[];
  reviews: Review[];
  goals: Goal[];
  drafts: Draft[];
  approvals: Approval[];
  connections: Connection[];
}

export interface ConnectionTool {
  name: string;
  description: string;
  write: boolean;
  /** What classified it. "unconfirmed": only the server calls it read-only, so it writes until a person confirms it. */
  source: "annotation" | "catalog" | "name" | "default" | "person" | "method" | "unconfirmed";
  /** Switched off by a person: refused for every teammate, whatever the toolbox grants. */
  off?: boolean;
}

/** An external system the company can reach: an MCP server (http or stdio) or an OpenAPI service. */
/** What the board says about a connection's OAuth authorisation: nothing secret. */
export interface ConnectionOAuth {
  authorizationServer: string | null;
  clientId: string | null;
  /** With a given client id: the env var NAME of its secret (a company secret, or a name the board shares). */
  clientSecretEnvName?: string | null;
  registered: boolean;
  scopes: string[];
  authorizedAt: string | null;
}

/** What this board can do beyond the basics (GET /api/features). */
/** A company secret: a value set from Settings into the board's secret store. Only ever the name and when. */
export interface CompanySecret {
  name: string;
  updatedAt: string;
  updatedBy: { kind: string; id: string };
}

export interface Features {
  /** A secret store the board may write to: connections may authorise by OAuth. */
  oauth: boolean;
  /** An object store: large artifacts and office images. */
  objectStore: boolean;
  /** Env var NAMES the operator shares with every company; any other name is one of the company's secrets. Only for people who manage connections. */
  sharedEnvNames?: string[];
  /** The command lines a stdio connection may run inside the board, as the operator wrote them; a final `*` lets more arguments follow. Only for people who manage connections. */
  stdioCommands?: string[];
  /** Whether the board reads the web (the web connection's pages, research sources); false: its operator keeps it off. */
  web?: boolean;
}

export interface Connection {
  id: string;
  companyId: string;
  name: string;
  catalogId: string | null;
  /** web: the board's own fetch; its manifest keeps the company's list of web domains. */
  kind: "mcp" | "openapi" | "web";
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  /** Env var NAME of the credential: one of the company's secrets, or a name the board shares. Never a value. */
  authEnvName: string | null;
  envNames: string[];
  enabled: boolean;
  tools: ConnectionTool[];
  manifest: Record<string, unknown> | null;
  discoveredAt: string | null;
  /** The last health check from Settings, or null before the first. */
  lastCheck: ConnectionCheck | null;
  /** Set when the connection authorises by OAuth instead of a credential by name. */
  oauth: ConnectionOAuth | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionCheck {
  ok: boolean;
  at: string;
  latencyMs: number;
  error: string | null;
  tools: { seen: number; missing: string[]; extra: string[] };
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: "mcp" | "openapi";
  transport: "http" | "stdio";
  urlExample?: string;
  commandExample?: string;
  /** Absent when the server takes no token at all. */
  authEnvExample?: string;
  /** "oauth": the server authorises by OAuth only. */
  auth?: "oauth";
  docsUrl?: string;
  reads: string[];
  writes: string[];
}

export interface OpenApiScan {
  operations: {
    operationId: string;
    name: string;
    method: string;
    path: string;
    summary: string;
    write: boolean;
  }[];
  errors: string[];
}

// --- Governed tools (M5) -----------------------------------------------------

/** superseded: a newer proposal of the same write replaced it while it waited. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "superseded";

/** A proposed write to a live system: the exact arguments, bound by sha256, waiting for a person. */
export interface Approval {
  id: string;
  companyId: string;
  taskId: string;
  taskNumber: number | null;
  taskTitle: string | null;
  projectId: string | null;
  departmentId: string | null;
  runId: string | null;
  teammate: { kind: "teammate"; id: string; name: string | null; handle: string | null } | null;
  connection: string;
  tool: string;
  title: string;
  why: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  status: ApprovalStatus;
  decidedBy: ActorRef | null;
  decidedAt: string | null;
  note: string | null;
  result: unknown | null;
  error: string | null;
  executedAt: string | null;
  /** What it writes to (a path, an id), when its arguments name one. */
  target: string | null;
  /** The newer proposal that replaced it. */
  supersededBy: string | null;
  /** A rejected write's: who takes the task from there; null once it moved on another way. */
  afterRejection: AfterRejection | null;
  createdAt: string;
  updatedAt: string;
}

/** Who takes a task from a rejected write. */
export type AfterRejection =
  /** The task's manager re-planned it since the rejection. */
  | { kind: "replanned"; by: string }
  /** The task waits with the rejection, and its manager re-plans it on his next pass. */
  | { kind: "replan"; by: string }
  /** Another proposal on the task still waits for a decision. */
  | { kind: "proposal" }
  /** The task waits with the rejection for its assignee, a person, or for any person (null). */
  | { kind: "person"; name: string | null };

// --- Peter (M4) ---------------------------------------------------------------

export type GoalStatus = "planning" | "needs_you" | "active" | "done" | "stopped";

export interface GoalQuestion {
  text: string;
  answer: string | null;
}

export interface GoalPlanTask {
  title: string;
  brief: string;
  assignee: string;
  workKind: "build" | "research";
  outputs: string[];
  criteria: Criterion[];
  dependsOn: number[];
}

export interface GoalPlan {
  title: string;
  background: string;
  outcome: string;
  doneDefinition: string;
  questions: string[];
  department: string | null;
  tasks: GoalPlanTask[];
}

/** A file a goal's task delivered, from the run its review approved. */
export interface GoalFile {
  artifactId: string;
  runId: string;
  path: string;
  bytes: number;
  sha256: string;
  binary: boolean;
}

/** What a goal produced: the files it delivered, and what its live writes left behind. */
export interface GoalResult {
  goalId: string;
  title: string;
  status: GoalStatus;
  /** Final tasks: Done, and nothing else depends on them. */
  delivered: { taskId: string; number: number; title: string; files: GoalFile[] }[];
  /** Done tasks the final ones were built on. */
  supporting: { taskId: string; number: number; title: string; files: GoalFile[] }[];
  published: {
    connection: string;
    tool: string;
    target: string | null;
    approvalId: string;
    title: string;
    number: number;
    executedAt: string;
    /** A later write to the same target (from any task), when there was one. */
    now: { approvalId: string; title: string; number: number; executedAt: string } | null;
    content: { sha256: string; chars: number } | null;
    /** Whether what the target holds now is the delivered file of the same name. */
    matchesDelivered: { number: number; path: string; same: boolean } | null;
  }[];
}

/** What a person handed Peter. One goal, one project. */
export interface Goal {
  id: string;
  companyId: string;
  projectId: string;
  departmentId: string | null;
  text: string;
  title: string;
  status: GoalStatus;
  plan: GoalPlan | null;
  questions: GoalQuestion[];
  caps: { maxTasks: number; maxDepth: number; tokens: number | null };
  planningUsage: { inputTokens: number; outputTokens: number; calls: number };
  /** Why the goal needs a person, while it does. */
  attention: string | null;
  planner: string | null;
  /** The goal opened its project; false: it went into a project that existed. */
  openedProject: boolean;
  createdBy: ActorRef;
  plannedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the goal has cost so far: its tasks' runs and Peter's planning. */
  spend: GoalSpend;
}

export interface GoalSpend {
  runTokens: number;
  runs: number;
  planningTokens: number;
  planningCalls: number;
  totalTokens: number;
  costMinorUnits: number | null;
  currency: string | null;
  tokensCap: number | null;
}

export interface GoalDetail extends Goal {
  tasks: Task[];
}

export interface ProposedTeammate {
  name: string;
  role: string;
  template: string | null;
  personaMd: string;
  lead: boolean;
}

export interface ProposedDepartment {
  name: string;
  writePolicy: WritePolicy;
  policy: string;
  /** MCP servers by name: a recommendation, granted by nobody until approvals (M5). */
  toolbox: string[];
  teammates: ProposedTeammate[];
}

export interface OrgProposal {
  summary: string;
  departments: ProposedDepartment[];
}

export interface AuditFinding {
  kind: string;
  subject: { kind: "teammate" | "department" | "company"; id: string; name: string } | null;
  text: string;
  suggestion: string;
}

export interface AuditReport {
  summary: string;
  findings: AuditFinding[];
}

/** What Peter proposes as architect; a person accepts it. */
export interface Draft {
  id: string;
  companyId: string;
  kind: "org" | "audit";
  status: "proposed" | "accepted" | "rejected";
  brief: string;
  proposal: OrgProposal | AuditReport;
  planner: string | null;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  createdBy: ActorRef;
  decidedBy: ActorRef | null;
  decidedAt: string | null;
  outcome: { departments: { id: string; name: string }[]; teammates: { id: string; name: string }[] } | null;
  createdAt: string;
  updatedAt: string;
}

// --- Reviews (M3) -------------------------------------------------------------

export type Named = ActorRef & { name: string | null };

export interface CriterionScore {
  index: number;
  text: string;
  weight: number;
  score: number;
  note: string | null;
}

/** One review per task, advanced a round each time the author's run completes. */
export interface Review {
  id: string;
  companyId: string;
  taskId: string;
  taskNumber: number | null;
  taskTitle: string | null;
  taskStatus: TaskStatus | null;
  projectId: string | null;
  runId: string;
  round: number;
  author: Named;
  reviewer: Named | null;
  status: ReviewStatus;
  diffSha256: string;
  baseSha: string | null;
  scores: CriterionScore[] | null;
  summary: string | null;
  decidedAt: string | null;
  decidedBy: ActorRef | null;
  fileCount: number;
  additions: number;
  deletions: number;
  openComments: number;
  openedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  id: string;
  seq: number;
  type: string;
  at: string;
  text: string;
  unread: boolean;
  taskId: string | null;
  reviewId: string | null;
}
export interface Inbox {
  since: string | null;
  unread: number;
  items: InboxItem[];
}

export interface ReviewFile {
  id: string;
  path: string;
  status: "added" | "modified" | "deleted";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ReviewComment {
  id: string;
  round: number;
  file: string;
  hunk: number;
  line: number | null;
  oldLine: number | null;
  author: Named;
  body: string;
  resolved: boolean;
  createdAt: string;
}

export interface ReviewCheck {
  id: string;
  round: number;
  kind: "secrets" | "outputs" | "tests" | "evaluation" | "sources";
  ok: boolean | null;
  title: string;
  detail: Record<string, unknown>;
}

export interface ReviewDecision {
  id: string;
  round: number;
  by: Named;
  decision: "approve" | "request_changes" | "veto";
  note: string | null;
  createdAt: string;
}

export interface PullRequest {
  id: string;
  reviewId: string;
  provider: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  payloadSha256: string;
  status: "proposed" | "opened" | "failed" | "closed";
  number: number | null;
  url: string | null;
  error: string | null;
  createdAt: string;
  closedAt?: string | null;
  executedAt: string | null;
}

export interface ReviewDetail extends Review {
  criteria: Criterion[];
  declaredOutputs: string[];
  workKind: "build" | "research";
  files: ReviewFile[];
  comments: ReviewComment[];
  checks: ReviewCheck[];
  decisions: ReviewDecision[];
  pullRequests: PullRequest[];
}

export type RunStatus = "queued" | "running" | "interrupted" | "completed" | "failed" | "stopped" | "blocked";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Run {
  id: string;
  companyId: string;
  taskId: string;
  teammateId: string;
  engine: string;
  model: string;
  status: RunStatus;
  attempt: number;
  workerId: string | null;
  currentStep: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  stopRequested: boolean;
  summary: string | null;
  error: string | null;
  blocker: BlockerRecord | null;
  usage: RunUsage;
  totalTokens: number;
  costMinorUnits: number | null;
  durationMs: number | null;
  runSpecHash: string | null;
  createdBy: ActorRef;
  /** Why this run was started: a person's note, a re-plan, an answer. */
  note: string | null;
  /** task: the assignee working the task. turn: a teammate answering a mention. */
  kind: "task" | "turn" | "review";
  triggerMessageId: string | null;
  baseSha: string | null;
  /** The worker pod's last sample: CPU in millicores, memory in bytes (M6). */
  resources: { cpuMillis: number; memoryBytes: number } | null;
  createdAt: string;
}

export interface RunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface Artifact {
  id: string;
  runId: string;
  taskId: string;
  path: string;
  kind: string;
  sha256: string;
  bytes: number;
  inline: boolean;
  /** base64: a binary file; content, when present, is its base64. */
  encoding?: "utf8" | "base64";
  content?: string | null;
  createdAt: string;
}

/** A ticket's deliverable: its declared files from the run its review approved (or its latest run). */
export interface TaskDeliverable {
  runId: string | null;
  state: "approved" | "in_review" | "changes_requested" | "unreviewed" | "none";
  round: number | null;
  files: Artifact[];
  /** Declared outputs no run has kept. */
  missing: string[];
}

export type BudgetWindow = "day" | "week" | "month";
export type BudgetScopeKind = "company" | "department" | "project" | "teammate";

export interface Budget {
  id: string;
  /** "goal": a goal's token cap, a lifetime budget Peter sets from the goal; nobody sets one by hand. */
  scopeKind: BudgetScopeKind | "goal";
  scopeId: string;
  tokensLimit: number;
  window: BudgetWindow | "goal";
  used: number;
  percent: number;
  updatedAt: string;
}

/** Prices in minor units (pence, cents) per million tokens; seat price per month. */
export interface ModelPrice {
  id: string;
  model: string;
  currency: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  seatPriceMonth: number | null;
  updatedAt: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostLine {
  tokens: TokenTotals;
  costMinorUnits: number | null;
  runs: number;
  /** A manager's own model calls in the line: planning a goal, a re-plan note, an org proposal. */
  calls: number;
}

export interface BudgetLine {
  tokensLimit: number;
  used: number;
  percent: number;
}

export interface CostReport {
  window: BudgetWindow;
  from: string;
  to: string;
  currency: string;
  elapsedFraction: number;
  totals: CostLine & { seatMinorUnits: number };
  forecast: { costMinorUnits: number | null; seatMinorUnits: number; tokens: number };
  budget: (BudgetLine & { window: BudgetWindow }) | null;
  byDepartment: (CostLine & {
    id: string | null;
    name: string;
    teammates: number;
    seatMinorUnits: number;
    budget: BudgetLine | null;
  })[];
  byProject: (CostLine & { id: string; name: string; client: string })[];
  byTeammate: (CostLine & {
    id: string;
    name: string;
    handle: string;
    model: string;
    engine: string;
    departmentName: string | null;
    seatMinorUnits: number;
  })[];
  byModel: (CostLine & { model: string; teammates: number })[];
  bySeat: { key: string; teammates: number; seatMinorUnits: number }[];
  daily: { day: string; tokens: number; costMinorUnits: number | null }[];
  prices: number;
}

/** The monthly cost report: a calendar month, by project with chargeback tags. */
export interface MonthlyReport {
  month: string;
  from: string;
  to: string;
  currency: string;
  totals: CostLine & { seatMinorUnits: number; teammates: number };
  byProject: (CostLine & { id: string; name: string; client: string; chargebackTag: string | null })[];
  byChargebackTag: (CostLine & { tag: string | null; projects: number })[];
  byDepartment: (CostLine & { id: string | null; name: string; seatMinorUnits: number })[];
  byTeammate: (CostLine & {
    id: string;
    name: string;
    handle: string;
    model: string;
    engine: string;
    seatMinorUnits: number;
  })[];
  byModel: (CostLine & { model: string })[];
  daily: { day: string; tokens: number; costMinorUnits: number | null }[];
}

export interface RunDetail extends Run {
  events: RunEvent[];
  artifacts: Artifact[];
}
