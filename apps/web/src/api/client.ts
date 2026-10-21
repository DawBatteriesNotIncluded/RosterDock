// Typed client for the board. Same-origin with cookies; the Vite dev server
// and the nginx image both proxy /api to the board.
import type {
  ActorRef,
  BudgetInput,
  CreateConnectionInput,
  CreateDepartmentInput,
  CreateGoalInput,
  UpdateGoalCapsInput,
  CreateOpenApiConnectionInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTeammateInput,
  ModelPriceInput,
  MoveTaskInput,
  ReviewCommentInput,
  ReviewScoreInput,
  UpdateConnectionInput,
  UpdateDepartmentInput,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateTeammateInput,
} from "@rosterdock/shared";
// The event types alone, not the package's index: that carries zod and node:crypto into the bundle.
import { EVENT_TYPES } from "@rosterdock/shared/events";
import type {
  Approval,
  Artifact,
  AuthProviders,
  Budget,
  BudgetWindow,
  CatalogEntry,
  Company,
  CompanySecret,
  Connection,
  CostReport,
  Department,
  Draft,
  EventRecord,
  Features,
  Goal,
  GoalDetail,
  GoalResult,
  TaskDeliverable,
  Inbox,
  ListPricesResult,
  Me,
  Member,
  Message,
  ModelPrice,
  MonthlyReport,
  OpenApiScan,
  PlannerInfo,
  Project,
  Review,
  ReviewComment,
  ReviewDetail,
  Run,
  RunDetail,
  RunStatus,
  StylePackInfo,
  Task,
  Teammate,
  TeammateTemplate,
  TemplatesImportReport,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

/**
 * The field problems behind a refused body, folded into the message, so a form says which field and why
 * ("invalid request body: name: lowercase letters, digits and dashes") instead of only that it was refused.
 */
export function messageWithIssues(message: string, details: unknown): string {
  if (!Array.isArray(details)) return message;
  const issues = details
    .filter(
      (d): d is { path?: unknown[]; message: string } =>
        !!d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string",
    )
    .map((d) => `${Array.isArray(d.path) && d.path.length ? `${d.path.join(".")}: ` : ""}${d.message}`);
  return issues.length ? `${message}: ${issues.join("; ")}` : message;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; details?: unknown };
    throw new ApiError(
      res.status,
      messageWithIssues(err.error ?? `request failed (${res.status})`, err.details),
      err.details,
    );
  }
  return json as T;
}

export interface Client {
  me(): Promise<Me>;
  authProviders(): Promise<AuthProviders>;
  devLogin(email: string, name?: string): Promise<void>;
  /** Ends the session; with a URL, the browser should go there to sign out of the identity provider too. */
  logout(): Promise<{ ok: boolean; signOutUrl: string | null }>;
  companies(): Promise<Company[]>;
  createCompany(input: { name: string; template?: string }): Promise<Company>;
  members(companyId: string): Promise<Member[]>;
  departments(companyId: string): Promise<Department[]>;
  createDepartment(companyId: string, input: CreateDepartmentInput): Promise<Department>;
  deleteDepartment(companyId: string, departmentId: string): Promise<void>;
  setDepartmentMember(
    companyId: string,
    departmentId: string,
    teammateId: string,
    isLead: boolean,
  ): Promise<Department>;
  removeDepartmentMember(companyId: string, departmentId: string, teammateId: string): Promise<Department>;
  updateDepartment(
    companyId: string,
    departmentId: string,
    input: UpdateDepartmentInput,
  ): Promise<Department>;
  teammates(companyId: string): Promise<Teammate[]>;
  templates(companyId: string): Promise<TeammateTemplate[]>;
  /** Where the browser downloads the company's templates file from. */
  templatesExportUrl(companyId: string): string;
  importTemplates(companyId: string, file: unknown): Promise<TemplatesImportReport>;
  createTeammate(companyId: string, input: CreateTeammateInput): Promise<Teammate>;
  updateTeammate(companyId: string, teammateId: string, input: UpdateTeammateInput): Promise<Teammate>;
  projects(companyId: string): Promise<Project[]>;
  createProject(companyId: string, input: CreateProjectInput): Promise<Project>;
  updateProject(companyId: string, projectId: string, input: UpdateProjectInput): Promise<Project>;
  tasks(companyId: string): Promise<Task[]>;
  createTask(companyId: string, input: CreateTaskInput): Promise<Task>;
  updateTask(companyId: string, taskId: string, input: UpdateTaskInput): Promise<Task>;
  moveTask(companyId: string, taskId: string, input: MoveTaskInput): Promise<Task>;
  /** Close a task that will not be done (owners and admins); reopen puts it back in To do. */
  cancelTask(companyId: string, taskId: string, note?: string): Promise<Task>;
  reopenTask(companyId: string, taskId: string): Promise<Task>;
  messages(companyId: string, taskId: string): Promise<Message[]>;
  postMessage(companyId: string, taskId: string, body: string): Promise<Message>;
  events(companyId: string, limit?: number): Promise<EventRecord[]>;
  runs(companyId: string, taskId: string): Promise<Run[]>;
  run(companyId: string, runId: string, afterSeq?: number): Promise<RunDetail>;
  startRun(companyId: string, taskId: string): Promise<Run>;
  stopRun(companyId: string, runId: string): Promise<Run>;
  taskArtifacts(companyId: string, taskId: string): Promise<Artifact[]>;
  /** The ticket's deliverable and where its review stands. */
  taskDeliverable(companyId: string, taskId: string): Promise<TaskDeliverable>;
  artifact(companyId: string, runId: string, artifactId: string): Promise<Artifact>;
  /** Runs in any of the given statuses, newest first. */
  runsByStatus(companyId: string, statuses: RunStatus[]): Promise<Run[]>;
  costs(companyId: string, window: BudgetWindow): Promise<CostReport>;
  monthlyCosts(companyId: string, month?: string): Promise<MonthlyReport>;
  /** Where the browser downloads the usage CSV for a window, or the chargeback CSV for a month. */
  usageCsvUrl(companyId: string, window: BudgetWindow): string;
  chargebackCsvUrl(companyId: string, month: string): string;
  prices(companyId: string): Promise<ModelPrice[]>;
  savePrice(companyId: string, input: ModelPriceInput): Promise<ModelPrice>;
  deletePrice(companyId: string, priceId: string): Promise<void>;
  /** Price every model the company uses and has not priced at the API list price. */
  fillListPrices(companyId: string): Promise<ListPricesResult>;
  styles(companyId: string): Promise<StylePackInfo[]>;
  setStyle(
    companyId: string,
    pack: string,
    input: { enabled: boolean; level?: string },
  ): Promise<StylePackInfo[]>;
  budgets(companyId: string): Promise<Budget[]>;
  saveBudget(companyId: string, input: BudgetInput): Promise<Budget>;
  deleteBudget(companyId: string, budgetId: string): Promise<void>;
  reviews(companyId: string): Promise<Review[]>;
  review(companyId: string, reviewId: string): Promise<ReviewDetail>;
  taskReview(companyId: string, taskId: string): Promise<ReviewDetail>;
  addReviewComment(companyId: string, reviewId: string, input: ReviewCommentInput): Promise<ReviewComment>;
  resolveReviewComment(companyId: string, reviewId: string, commentId: string): Promise<ReviewComment>;
  scoreReview(companyId: string, reviewId: string, input: ReviewScoreInput): Promise<ReviewDetail>;
  approveReview(companyId: string, reviewId: string, summary?: string): Promise<ReviewDetail>;
  requestChanges(companyId: string, reviewId: string, summary?: string): Promise<ReviewDetail>;
  vetoReview(companyId: string, reviewId: string, note: string): Promise<ReviewDetail>;
  assignReviewer(
    companyId: string,
    reviewId: string,
    reviewer: ActorRef | null,
  ): Promise<ReviewDetail & { started: { runId: string | null; reason: string | null } | null }>;
  teammateInbox(companyId: string, teammateId: string): Promise<Inbox>;
  // Peter (M4)
  goals(companyId: string): Promise<Goal[]>;
  goal(companyId: string, goalId: string): Promise<GoalDetail>;
  /** Hand Peter a goal; he plans it before answering. */
  createGoal(companyId: string, input: CreateGoalInput): Promise<GoalDetail>;
  answerGoal(companyId: string, goalId: string, answers: string[]): Promise<GoalDetail>;
  stopGoal(companyId: string, goalId: string): Promise<GoalDetail>;
  /** What a goal produced, and links to save it: every file as a zip, or one file. */
  goalResult(companyId: string, goalId: string): Promise<GoalResult>;
  goalResultZipUrl(companyId: string, goalId: string): string;
  artifactDownloadUrl(companyId: string, runId: string, artifactId: string): string;
  /** Raise or lower a goal's caps; the token cap is the project's lifetime budget. */
  updateGoalCaps(companyId: string, goalId: string, caps: UpdateGoalCapsInput): Promise<GoalDetail>;
  drafts(companyId: string): Promise<Draft[]>;
  proposeOrg(companyId: string, brief: string): Promise<Draft>;
  auditCompany(companyId: string): Promise<Draft>;
  acceptDraft(companyId: string, draftId: string): Promise<Draft>;
  rejectDraft(companyId: string, draftId: string): Promise<Draft>;
  // Governed tools (M5)
  approvals(companyId: string): Promise<Approval[]>;
  approval(companyId: string, approvalId: string): Promise<Approval>;
  /** Approve: the hash is verified and the bound bytes are sent; the proposer continues. */
  approveApproval(
    companyId: string,
    approvalId: string,
    note?: string,
  ): Promise<Approval & { restarted: { runId: string | null; reason: string | null } }>;
  rejectApproval(companyId: string, approvalId: string, note?: string): Promise<Approval>;
  catalog(): Promise<CatalogEntry[]>;
  connections(companyId: string): Promise<Connection[]>;
  createConnection(companyId: string, input: CreateConnectionInput): Promise<Connection>;
  /** The spec as text (JSON or YAML) or parsed; the board reads either. */
  previewOpenApi(companyId: string, spec: string | Record<string, unknown>): Promise<OpenApiScan>;
  createOpenApiConnection(companyId: string, input: CreateOpenApiConnectionInput): Promise<Connection>;
  updateConnection(
    companyId: string,
    connectionId: string,
    input: UpdateConnectionInput,
  ): Promise<Connection>;
  discoverConnection(companyId: string, connectionId: string): Promise<Connection>;
  /** A health check: the outcome lands on the connection's lastCheck. */
  checkConnection(companyId: string, connectionId: string): Promise<Connection>;
  /** Where to send the browser to authorise the connection; it comes back to the board's callback. */
  startOAuth(companyId: string, connectionId: string): Promise<{ url: string }>;
  features(): Promise<Features>;
  /** Company secrets: names only; the PUT body is the one value the board accepts, write-only. */
  secrets(companyId: string): Promise<CompanySecret[]>;
  setSecret(companyId: string, name: string, value: string): Promise<CompanySecret>;
  deleteSecret(companyId: string, name: string): Promise<void>;
  deleteConnection(companyId: string, connectionId: string): Promise<void>;
  updateCompany(companyId: string, input: { settings?: Record<string, unknown> }): Promise<Company>;
  /** One image of the office pack, as base64 PNG; the board keeps it and names it in settings.officePack. */
  putOfficeImage(companyId: string, name: string, contentBase64: string): Promise<Company>;
  deleteOfficeImage(companyId: string, name: string): Promise<Company>;
  /** Where the browser fetches a pack image; content-addressed, so the hash rides in the query. */
  officeImageUrl(companyId: string, name: string, sha256: string): string;
  /** Send a test to the company's webhook; says whether it went and which NAME it came from. */
  testNotify(companyId: string): Promise<{ sent: boolean; target: string | null; error: string | null }>;
  /** How Peter thinks for the company; `refresh` asks the CLIs again now. */
  planner(companyId: string, refresh?: boolean): Promise<PlannerInfo>;
  /** Live tail. Returns a stop function. */
  subscribe(companyId: string, afterSeq: number | null, onEvent: (ev: EventRecord) => void): () => void;
}

const c = (id: string) => `/api/companies/${id}`;

export const httpClient: Client = {
  me: () => request("GET", "/api/auth/me"),
  authProviders: () => request("GET", "/api/auth/providers"),
  devLogin: (email, name) => request("POST", "/api/auth/dev-login", { email, name }),
  logout: () => request("POST", "/api/auth/logout", {}),
  companies: () => request("GET", "/api/companies"),
  createCompany: (input) => request("POST", "/api/companies", input),
  members: (id) => request("GET", `${c(id)}/members`),
  departments: (id) => request("GET", `${c(id)}/departments`),
  createDepartment: (id, input) => request("POST", `${c(id)}/departments`, input),
  deleteDepartment: (id, d) => request("DELETE", `${c(id)}/departments/${d}`),
  setDepartmentMember: (id, d, t, isLead) =>
    request("PUT", `${c(id)}/departments/${d}/members/${t}`, { isLead }),
  removeDepartmentMember: (id, d, t) => request("DELETE", `${c(id)}/departments/${d}/members/${t}`),
  updateDepartment: (id, d, input) => request("PATCH", `${c(id)}/departments/${d}`, input),
  teammates: (id) => request("GET", `${c(id)}/teammates`),
  templates: (id) => request("GET", `${c(id)}/templates/teammates`),
  templatesExportUrl: (id) => `${c(id)}/templates/export`,
  importTemplates: (id, file) => request("POST", `${c(id)}/templates/import`, file),
  createTeammate: (id, input) => request("POST", `${c(id)}/teammates`, input),
  updateTeammate: (id, t, input) => request("PATCH", `${c(id)}/teammates/${t}`, input),
  projects: (id) => request("GET", `${c(id)}/projects`),
  createProject: (id, input) => request("POST", `${c(id)}/projects`, input),
  updateProject: (id, p, input) => request("PATCH", `${c(id)}/projects/${p}`, input),
  tasks: (id) => request("GET", `${c(id)}/tasks`),
  createTask: (id, input) => request("POST", `${c(id)}/tasks`, input),
  updateTask: (id, t, input) => request("PATCH", `${c(id)}/tasks/${t}`, input),
  moveTask: (id, t, input) => request("POST", `${c(id)}/tasks/${t}/move`, input),
  cancelTask: (id, t, note) => request("POST", `${c(id)}/tasks/${t}/cancel`, note ? { note } : {}),
  reopenTask: (id, t) => request("POST", `${c(id)}/tasks/${t}/reopen`, {}),
  messages: (id, t) => request("GET", `${c(id)}/tasks/${t}/messages`),
  postMessage: (id, t, body) => request("POST", `${c(id)}/tasks/${t}/messages`, { body }),
  events: (id, limit = 100) => request("GET", `${c(id)}/events?limit=${limit}`),
  runs: (id, t) => request("GET", `${c(id)}/tasks/${t}/runs`),
  run: (id, r, afterSeq = 0) => request("GET", `${c(id)}/runs/${r}?afterSeq=${afterSeq}`),
  startRun: (id, t) => request("POST", `${c(id)}/tasks/${t}/runs`, {}),
  stopRun: (id, r) => request("POST", `${c(id)}/runs/${r}/stop`, {}),
  taskArtifacts: (id, t) => request("GET", `${c(id)}/tasks/${t}/artifacts`),
  taskDeliverable: (id, t) => request("GET", `${c(id)}/tasks/${t}/deliverable`),
  artifact: (id, r, a) => request("GET", `${c(id)}/runs/${r}/artifacts/${a}`),
  runsByStatus: (id, statuses) => request("GET", `${c(id)}/runs?status=${statuses.join(",")}&limit=100`),
  costs: (id, window) => request("GET", `${c(id)}/costs?window=${window}`),
  monthlyCosts: (id, month) => request("GET", `${c(id)}/costs/monthly${month ? `?month=${month}` : ""}`),
  usageCsvUrl: (id, window) => `${c(id)}/costs/export.csv?window=${window}`,
  chargebackCsvUrl: (id, month) => `${c(id)}/costs/monthly.csv?month=${month}`,
  prices: (id) => request("GET", `${c(id)}/prices`),
  savePrice: (id, input) => request("PUT", `${c(id)}/prices`, input),
  deletePrice: (id, p) => request("DELETE", `${c(id)}/prices/${p}`),
  fillListPrices: (id) => request("POST", `${c(id)}/prices/list`, {}),
  styles: (id) => request("GET", `${c(id)}/styles`),
  setStyle: (id, pack, input) => request("PUT", `${c(id)}/styles/${encodeURIComponent(pack)}`, input),
  budgets: (id) => request("GET", `${c(id)}/budgets`),
  saveBudget: (id, input) => request("PUT", `${c(id)}/budgets`, input),
  deleteBudget: (id, b) => request("DELETE", `${c(id)}/budgets/${b}`),
  reviews: (id) => request("GET", `${c(id)}/reviews`),
  review: (id, r) => request("GET", `${c(id)}/reviews/${r}`),
  taskReview: (id, t) => request("GET", `${c(id)}/tasks/${t}/review`),
  addReviewComment: (id, r, input) => request("POST", `${c(id)}/reviews/${r}/comments`, input),
  resolveReviewComment: (id, r, cm) => request("POST", `${c(id)}/reviews/${r}/comments/${cm}/resolve`, {}),
  scoreReview: (id, r, input) => request("POST", `${c(id)}/reviews/${r}/scores`, input),
  approveReview: (id, r, summary) =>
    request("POST", `${c(id)}/reviews/${r}/approve`, summary ? { summary } : {}),
  requestChanges: (id, r, summary) =>
    request("POST", `${c(id)}/reviews/${r}/request-changes`, summary ? { summary } : {}),
  vetoReview: (id, r, note) => request("POST", `${c(id)}/reviews/${r}/veto`, { note }),
  assignReviewer: (id, r, reviewer) => request("POST", `${c(id)}/reviews/${r}/reviewer`, { reviewer }),
  teammateInbox: (id, t) => request("GET", `${c(id)}/teammates/${t}/inbox`),
  goals: (id) => request("GET", `${c(id)}/goals`),
  goal: (id, g) => request("GET", `${c(id)}/goals/${g}`),
  createGoal: (id, input) => request("POST", `${c(id)}/goals`, input),
  answerGoal: (id, g, answers) => request("POST", `${c(id)}/goals/${g}/answers`, { answers }),
  stopGoal: (id, g) => request("POST", `${c(id)}/goals/${g}/stop`, {}),
  goalResult: (id, g) => request("GET", `${c(id)}/goals/${g}/result`),
  goalResultZipUrl: (id, g) => `${c(id)}/goals/${g}/result.zip`,
  artifactDownloadUrl: (id, r, a) => `${c(id)}/runs/${r}/artifacts/${a}/download`,
  updateGoalCaps: (id, g, caps) => request("PATCH", `${c(id)}/goals/${g}/caps`, caps),
  drafts: (id) => request("GET", `${c(id)}/drafts`),
  proposeOrg: (id, brief) => request("POST", `${c(id)}/drafts/org`, { brief }),
  auditCompany: (id) => request("POST", `${c(id)}/drafts/audit`, {}),
  acceptDraft: (id, d) => request("POST", `${c(id)}/drafts/${d}/accept`, {}),
  rejectDraft: (id, d) => request("POST", `${c(id)}/drafts/${d}/reject`, {}),
  approvals: (id) => request("GET", `${c(id)}/approvals`),
  approval: (id, a) => request("GET", `${c(id)}/approvals/${a}`),
  approveApproval: (id, a, note) => request("POST", `${c(id)}/approvals/${a}/approve`, note ? { note } : {}),
  rejectApproval: (id, a, note) => request("POST", `${c(id)}/approvals/${a}/reject`, note ? { note } : {}),
  catalog: () => request("GET", "/api/catalog/connectors"),
  connections: (id) => request("GET", `${c(id)}/connections`),
  createConnection: (id, input) => request("POST", `${c(id)}/connections`, input),
  previewOpenApi: (id, spec) => request("POST", `${c(id)}/connections/openapi/preview`, { spec }),
  createOpenApiConnection: (id, input) => request("POST", `${c(id)}/connections/openapi`, input),
  updateConnection: (id, cn, input) => request("PATCH", `${c(id)}/connections/${cn}`, input),
  discoverConnection: (id, cn) => request("POST", `${c(id)}/connections/${cn}/discover`, {}),
  checkConnection: (id, cn) => request("POST", `${c(id)}/connections/${cn}/check`, {}),
  startOAuth: (id, cn) => request("POST", `${c(id)}/connections/${cn}/oauth/start`, { returnTo: "/" }),
  features: () => request("GET", "/api/features"),
  secrets: (id) => request("GET", `${c(id)}/secrets`),
  setSecret: (id, name, value) => request("PUT", `${c(id)}/secrets/${encodeURIComponent(name)}`, { value }),
  deleteSecret: (id, name) => request("DELETE", `${c(id)}/secrets/${encodeURIComponent(name)}`),
  deleteConnection: (id, cn) => request("DELETE", `${c(id)}/connections/${cn}`),
  updateCompany: (id, input) => request("PATCH", c(id), input),
  putOfficeImage: (id, name, content) => request("PUT", `${c(id)}/office/images/${name}`, { content }),
  deleteOfficeImage: (id, name) => request("DELETE", `${c(id)}/office/images/${name}`),
  officeImageUrl: (id, name, sha256) => `${c(id)}/office/images/${name}?v=${sha256}`,
  testNotify: (id) => request("POST", `${c(id)}/notify/test`, {}),
  planner: (id, refresh) => request("GET", `${c(id)}/planner${refresh ? "?refresh=1" : ""}`),
  subscribe(companyId, afterSeq, onEvent) {
    const qs = afterSeq !== null ? `?afterSeq=${afterSeq}` : "?replay=0";
    const source = new EventSource(`${c(companyId)}/events/stream${qs}`, { withCredentials: true });
    const handler = (e: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(e.data) as EventRecord);
      } catch {
        // ignore malformed frames
      }
    };
    // Events are sent with `event: <type>`, and EventSource hands a named event only to a listener of
    // that name, so listen on every type the board can append.
    for (const type of EVENT_TYPES) source.addEventListener(type, handler as EventListener);
    source.addEventListener("message", handler as EventListener);
    return () => source.close();
  },
};
