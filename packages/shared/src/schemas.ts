// Request schemas shared by the board (validation) and the web (typed client).
// Names only for anything secret-shaped; the board runs assertNoRawSecrets on
// every body after these parse.

import { z } from "zod";
import { BLOCKER_CODES } from "./blockers.js";
import { TOOL_MODES } from "./policy.js";
import { POOL_RE } from "./queue.js";
import { ACTOR_KINDS, ROLES } from "./roles.js";
import { normalizeDomain } from "./web.js";

/**
 * A model id as an engine takes it. Claude's are all dashes (`claude-opus-5-5`); written the way people say
 * it (`claude-opus-5.5`) Claude Code refuses it and every run fails at once, so a dotted version is put right.
 * Other ids (Codex's, a provider's `anthropic.claude-…`) are left as they are.
 */
export const modelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .transform((m) => (m.startsWith("claude-") ? m.replace(/(\d)\.(?=\d)/g, "$1-") : m));

/**
 * The model a teammate gets when nothing names one, and the one Peter plans on: the current Sonnet and Opus.
 * The built-in templates name the same two.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MANAGER_MODEL = "claude-opus-5-5";

// Cancelled closes a task that will not be done (a person dropped it, or its goal was stopped). It is never Done.
export const TASK_STATUSES = ["todo", "doing", "blocked", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Nothing more happens on a task that is Done or Cancelled; every other status is open. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];
export const isOpenTask = (status: TaskStatus): boolean => !CLOSED_TASK_STATUSES.includes(status);
/** Statuses a caller may move a task to. Done is reached only through an approved review. */
export const MOVABLE_STATUSES = ["todo", "doing", "blocked", "review"] as const;

/** build: the run's diff is reviewed. research: documents with sources are reviewed against a checklist. */
export const WORK_KINDS = ["build", "research"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WRITE_POLICIES = ["readonly", "drafts", "ask"] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

/** Engines a teammate can run on. `stub` calls no model: demos, CI and tests. */
export const ENGINES = ["claude_code", "codex", "opencode", "stub"] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * How hard a teammate's model thinks: Claude Code's --effort, Codex's model_reasoning_effort, the API's
 * output_config.effort. Null or absent: the engine's own default.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
const effort = z.enum(EFFORT_LEVELS).nullable().optional();

const name = z.string().trim().min(1).max(120);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");
const uuid = z.string().uuid();
const longText = z.string().max(20_000);
/** A domain on a web list, as typed (`docs.example.com`, `*.example.com`, a URL) and kept normalised (web.ts). */
const webDomain = z
  .string()
  .trim()
  .max(300)
  .refine((v) => normalizeDomain(v) !== null, "a domain, such as example.com")
  .transform((v) => normalizeDomain(v)!);
/**
 * Web domains, each with the sites under it. Empty or absent says nothing: on the company's web connection,
 * any public site; on a department or a client, no narrowing.
 */
export const WebDomainsSchema = z.array(webDomain).max(100);
const outputName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/, "a flat file name, no paths");

export const ActorRefSchema = z.object({ kind: z.enum(ACTOR_KINDS), id: uuid });
export type ActorRefInput = z.infer<typeof ActorRefSchema>;

export const RoleSchema = z.enum(ROLES);

export const CreateCompanySchema = z.object({
  name,
  template: z.string().trim().max(64).optional(),
  budgetTokensWeek: z.number().int().nonnegative().optional(),
});
/** What counts as behavioural drift for this company's teammates; each optional, the board's defaults otherwise. */
export const DriftSettingsSchema = z.object({
  /** A run must cost or last at least this many times the teammate's median (default 1.5). */
  ratioFloor: z.number().min(1).max(20).optional(),
  /** And be beyond this many median absolute deviations (default 3). */
  madFactor: z.number().min(0).max(20).optional(),
  /** A rejection rate over the last ten decisions at or above this (default 0.5)... */
  rejectionRateFloor: z.number().min(0).max(1).optional(),
  /** ...and this much above what it was before (default 0.3). */
  rejectionRateDelta: z.number().min(0).max(1).optional(),
});
export type DriftSettingsInput = z.infer<typeof DriftSettingsSchema>;
/** Where this company's needs-you notifications go, by env var NAME; never a URL. */
export const NotifySettingsSchema = z.object({
  /** Env var NAME holding a webhook URL (a Slack incoming webhook works as is). */
  webhookEnvName: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an env var NAME")
    .nullable()
    .optional(),
  /** Email: the env var NAME holding an SMTP URL (smtp:// or smtps://, credentials inside), and the addresses. */
  email: z
    .object({
      smtpUrlEnvName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an env var NAME"),
      to: z.array(z.string().trim().email()).min(1).max(10),
      from: z.string().trim().email().optional(),
    })
    .nullable()
    .optional(),
});
export type NotifySettingsInput = z.infer<typeof NotifySettingsSchema>;
/** Where the office's rooms and desks stand. The rooms are the departments and the desks the teammates; only their places are settings. */
export const OfficeSettingsSchema = z.object({
  /** By department id ("none" for the room of teammates in no department): the room's place in the grid, and its colour. */
  rooms: z
    .record(
      z.string().max(64),
      z.object({
        slot: z.number().int().min(0).max(99).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "a hex colour")
          .optional(),
      }),
    )
    .optional(),
  /** By teammate id: the desk's column and row inside its room. */
  desks: z
    .record(
      z.string().max(64),
      z.object({ col: z.number().int().min(0).max(9), row: z.number().int().min(0).max(9) }),
    )
    .optional(),
});
export type OfficeSettingsInput = z.infer<typeof OfficeSettingsSchema>;
/** The office's sprite modes, one image each in a pack. */
export const OFFICE_SPRITE_MODES = ["typing", "reading", "blocked", "waiting", "idle"] as const;
export type OfficeSpriteMode = (typeof OFFICE_SPRITE_MODES)[number];
/** An image name in the pack: `sprite.<mode>`, or `room.<department id>` (`room.none` for the room of teammates in no department, `room.default` for any room without its own). */
export const OFFICE_IMAGE_NAME_RE = /^(sprite\.(typing|reading|blocked|waiting|idle)|room\.[a-z0-9-]{1,64})$/;
/** A pack image is a PNG of at most this many bytes. */
export const OFFICE_IMAGE_MAX_BYTES = 512 * 1024;
/** What the company settings keep per image: the object's hash (its key in the store) and its size. */
export const OfficeImageSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
});
export type OfficeImage = z.infer<typeof OfficeImageSchema>;
/** `settings.officePack`: by image name. Written only by the office image routes; a company PATCH keeps what is there. */
export const OfficePackSchema = z.record(z.string().regex(OFFICE_IMAGE_NAME_RE), OfficeImageSchema);
export type OfficePack = z.infer<typeof OfficePackSchema>;
/** One image in: base64, a PNG once decoded. */
export const PutOfficeImageSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(OFFICE_IMAGE_MAX_BYTES * 2),
});
/**
 * How Peter thinks for a company (`settings.planner`): the Claude Code CLI or the Codex CLI where the board
 * runs, each on its own sign-in, the Anthropic API with the board's key, or no model (he plans by role).
 * `auto`, the default, takes the first of those that works on the board.
 */
export const PLANNER_KINDS = ["claude_cli", "codex_cli", "api"] as const;
export type PlannerKind = (typeof PLANNER_KINDS)[number];
export const PLANNER_CHOICES = ["auto", ...PLANNER_KINDS, "none"] as const;
export const PlannerSettingsSchema = z.object({
  via: z.enum(PLANNER_CHOICES).default("auto"),
  /** The Codex CLI's model; unset, Codex's own default. Claude and the API use the model on the manager's row. */
  model: z.string().trim().min(1).max(120).optional(),
});
export type PlannerSettings = z.infer<typeof PlannerSettingsSchema>;

export const CompanySettingsSchema = z
  .object({
    planner: PlannerSettingsSchema.optional(),
    drift: DriftSettingsSchema.optional(),
    notify: NotifySettingsSchema.optional(),
    office: OfficeSettingsSchema.optional(),
  })
  .passthrough();
export const UpdateCompanySchema = z.object({
  name: name.optional(),
  budgetTokensWeek: z.number().int().nonnegative().nullable().optional(),
  settings: CompanySettingsSchema.optional(),
});

export const GrantMembershipSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["owner", "admin", "reviewer", "viewer"]),
});

/**
 * Sandbox preset applied to the worker for runs in a department. Every field
 * narrows what the worker already allows; nothing here can widen it.
 */
export const SandboxPresetSchema = z.object({
  /** Engine tool allowlist, e.g. ["Read(./**)", "Write(./**)"]. Empty = the worker default. */
  allowedTools: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** Env var NAMES the engine may see; intersected with the worker's own list. */
  envNames: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an env var NAME"))
    .max(50)
    .optional(),
  /** Hard limit on one run, in seconds. */
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(6 * 3600)
    .optional(),
  /**
   * The worker pool this department's runs go to (M6): a fleet the operator runs with its own network
   * policy (the chart's worker.pools). Empty: the default fleet.
   */
  pool: z.string().regex(POOL_RE, "a pool name: lowercase letters, digits and dashes").optional(),
  /**
   * The web domains this department's runs may read through the company's web connection. Narrows the
   * company's list, never widens it; empty or absent: the company's list.
   */
  webDomains: WebDomainsSchema.optional(),
});
export type SandboxPreset = z.infer<typeof SandboxPresetSchema>;

export const CreateDepartmentSchema = z.object({
  name,
  slug: slug.optional(),
  writePolicy: z.enum(WRITE_POLICIES).default("ask"),
  leadTeammateId: uuid.optional(),
  memberTeammateIds: z.array(uuid).max(200).default([]),
  sandbox: SandboxPresetSchema.default({}),
});
export const UpdateDepartmentSchema = z.object({
  name: name.optional(),
  writePolicy: z.enum(WRITE_POLICIES).optional(),
  leadTeammateId: uuid.nullable().optional(),
  sandbox: SandboxPresetSchema.optional(),
});
export const DepartmentMemberSchema = z.object({
  teammateId: uuid,
  isLead: z.boolean().default(false),
});

/**
 * One line of a toolbox: a connection by name, the mode granted on it (M5) and, optionally, only some of
 * its tools by name. Absent: every tool on the connection. Present: exactly those; the rest are never listed
 * to the teammate and refused when called.
 */
export const ToolboxEntrySchema = z.object({
  connection: slug,
  mode: z.enum(TOOL_MODES),
  tools: z.array(z.string().trim().min(1).max(128)).max(200).nullish(),
});
export type ToolboxEntryInput = z.infer<typeof ToolboxEntrySchema>;

export const CreateTeammateSchema = z.object({
  name,
  role: z.string().trim().min(1).max(80),
  engine: z.enum(ENGINES).default("claude_code"),
  model: modelId,
  personaMd: longText.default(""),
  playbooks: z.array(z.string().max(20_000)).max(50).default([]),
  avatar: z.string().trim().max(32).optional(),
  effort,
  templateId: uuid.optional(),
  /** Connections this teammate may use, with a mode each. The ceiling policy narrows from. */
  toolbox: z.array(ToolboxEntrySchema).max(50).default([]),
});
/** Explicit, without the create defaults: a partial update must never reset a field it did not name. */
export const UpdateTeammateSchema = z.object({
  name: name.optional(),
  role: z.string().trim().min(1).max(80).optional(),
  engine: z.enum(ENGINES).optional(),
  model: modelId.optional(),
  personaMd: longText.optional(),
  playbooks: z.array(z.string().max(20_000)).max(50).optional(),
  avatar: z.string().trim().max(32).optional(),
  /** null resets to the engine's default. */
  effort,
  toolbox: z.array(ToolboxEntrySchema).max(50).optional(),
});

/** What a project's client lets teammates do with each connection; only ever narrows (M5). */
export const ClientPolicySchema = z.object({
  default: z.enum(TOOL_MODES).nullable().default(null),
  caps: z.record(slug, z.enum(TOOL_MODES)).default({}),
  /** The web domains this client lets the company's web connection read; narrows, never widens. */
  webDomains: WebDomainsSchema.optional(),
});
export type ClientPolicyInput = z.infer<typeof ClientPolicySchema>;

/**
 * Git URL the worker clones. Credentials come from the worker environment by name, never from here: a URL
 * with a password, or with a user on http(s), where the user is the token, is refused.
 */
const repoUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return !u.password && !(/^https?:$/.test(u.protocol) && u.username);
    } catch {
      return true; // not a URL at all, which the check above reports
    }
  }, "a repository URL carries no credentials: the worker's git token is named in its environment");
/** The branch the board opens a task's pull request from (a merge request on GitLab). */
export const boardBranch = (taskNumber: number): string => `rosterdock/task-${taskNumber}`;
/**
 * `rosterdock` or under `rosterdock/`, however it is written: the board's own branches, the only ones it
 * writes. `rosterdock` itself counts: git cannot hold it beside `rosterdock/task-N`.
 */
export const isBoardBranch = (name: string): boolean =>
  /^(refs\/heads\/)?rosterdock(\/|$)/i.test(name.trim());
/** A project's default branch, where its pull requests go: never one the board writes. */
const branch = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (b) => !isBoardBranch(b),
    "a default branch is never rosterdock or under rosterdock/: the board writes its own branches there",
  );

export const CreateProjectSchema = z.object({
  name,
  client: z.string().trim().max(120).default("Internal"),
  goal: longText.default(""),
  repoUrl: repoUrl.nullable().optional(),
  defaultBranch: branch.default("main"),
  clientPolicy: ClientPolicySchema.default({ default: null, caps: {} }),
  /** A cost centre, client code or invoice reference the monthly cost report groups by (M6). */
  chargebackTag: z.string().trim().max(64).nullable().optional(),
});
/** Explicit, without the create defaults: a partial update must never reset a field it did not name. */
export const UpdateProjectSchema = z.object({
  name: name.optional(),
  client: z.string().trim().max(120).optional(),
  goal: longText.optional(),
  repoUrl: repoUrl.nullable().optional(),
  defaultBranch: branch.optional(),
  clientPolicy: ClientPolicySchema.optional(),
  chargebackTag: z.string().trim().max(64).nullable().optional(),
});

/** One weighted acceptance criterion; the reviewer scores each 0..1 (M3). */
export const CriterionSchema = z.object({
  text: z.string().trim().min(1).max(500),
  weight: z.number().positive().max(100).default(1),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const CreateTaskSchema = z.object({
  projectId: uuid,
  title: z.string().trim().min(1).max(300),
  description: longText.default(""),
  departmentId: uuid.nullable().optional(),
  assignee: ActorRefSchema.nullable().optional(),
  dependsOn: z.array(uuid).max(50).default([]),
  /** Flat file names the run must produce. */
  declaredOutputs: z.array(outputName).max(50).default([]),
  criteria: z.array(CriterionSchema).max(20).default([]),
  workKind: z.enum(WORK_KINDS).default("build"),
});
export const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: longText.optional(),
  departmentId: uuid.nullable().optional(),
  assignee: ActorRefSchema.nullable().optional(),
  declaredOutputs: z.array(outputName).max(50).optional(),
  criteria: z.array(CriterionSchema).max(20).optional(),
  workKind: z.enum(WORK_KINDS).optional(),
});
export const BlockerInputSchema = z.object({
  code: z.enum(BLOCKER_CODES),
  what: z.string().trim().max(1000).optional(),
  why: z.string().trim().max(1000).optional(),
  waitingOn: z
    .object({
      kind: z.enum(["teammate", "task", "approval"]),
      id: z.string().min(1).max(64),
      name: z.string().max(120).optional(),
    })
    .optional(),
});
export const CancelTaskSchema = z.object({
  /** Why, for the task's history. */
  note: z.string().trim().max(2000).optional(),
});
export type CancelTaskInput = z.infer<typeof CancelTaskSchema>;

export const MoveTaskSchema = z.object({
  status: z.enum(MOVABLE_STATUSES),
  blocker: BlockerInputSchema.optional(),
});

export const PostMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

export const DevLoginSchema = z.object({
  email: z.string().trim().email(),
  name: name.optional(),
});

export const MintTeammateTokenSchema = z.object({
  /** Seconds until expiry; default a day, max 30 days. */
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(30 * 24 * 3600)
    .default(24 * 3600),
  label: z.string().trim().max(120).optional(),
  /**
   * api: the REST API as the teammate. manager: also the board MCP server outside a run,
   * naming the task in each call (an agent acting as the teammate from its own machine).
   */
  scope: z.enum(["api", "manager"]).default("api"),
});

// --- Runs (M1) ---------------------------------------------------------------

export const RUN_STATUSES = [
  "queued",
  "running",
  "interrupted",
  "completed",
  "failed",
  "stopped",
  "blocked",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const tokenCount = z.number().int().nonnegative();
export const RunUsageSchema = z.object({
  inputTokens: tokenCount.default(0),
  outputTokens: tokenCount.default(0),
  cacheReadTokens: tokenCount.default(0),
  cacheWriteTokens: tokenCount.default(0),
});
export type RunUsage = z.infer<typeof RunUsageSchema>;

export const DispatchRunSchema = z.object({
  model: modelId.optional(),
  note: z.string().trim().max(2000).optional(),
});

export const WorkerClaimSchema = z.object({
  runId: uuid,
  jobId: z.string().min(1).max(64),
  workerId: z.string().trim().min(1).max(120),
});

export const RunEventInputSchema = z.object({
  type: z.string().trim().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).default({}),
  at: z.string().datetime({ offset: true }).optional(),
});
export const RunEventsBatchSchema = z.object({ events: z.array(RunEventInputSchema).min(1).max(200) });

/** What the worker's pod is using right now (M6): CPU in millicores, memory in bytes. */
export const RunResourcesSchema = z.object({
  cpuMillis: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
});
export type RunResources = z.infer<typeof RunResourcesSchema>;
export const RunHeartbeatSchema = z.object({
  step: z.string().trim().max(200).optional(),
  usage: RunUsageSchema.partial().optional(),
  resources: RunResourcesSchema.optional(),
});

export const RunCheckpointSchema = z.object({ checkpoint: z.record(z.string(), z.unknown()) });
/** The commit a run's clone is at, reported right after the clone with the key its claim gave the worker. */
export const RunClonedSchema = z.object({
  sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  key: z.string().min(1).max(200),
});

/** The largest artifact a run may report when the board has an object store; an inline row stops at 512 KB. */
export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const RunArtifactSchema = z.object({
  // Never trimmed: a name with a space or a U+FEFF at an end is another file than the one without.
  path: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^\0]+$/)
    .refine((p) => !p.includes("..") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p), "relative path only"),
  kind: z.enum(["file", "diff", "document", "log", "handover"]).default("file"),
  /** Up to ARTIFACT_MAX_BYTES once decoded; base64 carries a third more. */
  content: z.string().max(12 * 1024 * 1024),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

export const RunCompleteSchema = z.object({
  status: z.enum(["completed", "failed", "stopped", "blocked"]),
  summary: z.string().trim().max(4000).optional(),
  error: z.string().trim().max(4000).optional(),
  usage: RunUsageSchema.partial().optional(),
  model: z.string().trim().max(120).optional(),
  blocker: BlockerInputSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** HEAD of the clone the diff artifact was taken against. */
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** Checks the worker ran in the workspace (the repository's own tests). */
  checks: z
    .array(z.lazy(() => WorkerCheckSchema))
    .max(10)
    .optional(),
  /**
   * A rework run: whether the review round it was sent back from carried over into its clone. When it
   * did not (the base branch moved), `reason` says why in a phrase and the board says so on the task.
   */
  rework: z
    .object({
      round: z.number().int().positive(),
      applied: z.boolean(),
      reason: z.string().trim().max(300).optional(),
    })
    .optional(),
});

export const WorkerCheckSchema = z.object({
  kind: z.enum(["tests"]),
  /** null: could not run (no test script, tooling missing). */
  ok: z.boolean().nullable(),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(20_000).optional(),
});
export type WorkerCheckInput = z.infer<typeof WorkerCheckSchema>;

export const BUDGET_SCOPES = ["company", "department", "project", "teammate"] as const;
export const BUDGET_WINDOWS = ["day", "week", "month"] as const;
export const BudgetInputSchema = z.object({
  scopeKind: z.enum(BUDGET_SCOPES),
  /** Required for every scope except company. */
  scopeId: uuid.optional(),
  tokensLimit: z.number().int().nonnegative(),
  window: z.enum(BUDGET_WINDOWS).default("week"),
});
export type BudgetInput = z.infer<typeof BudgetInputSchema>;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];
export type BudgetScopeKind = (typeof BUDGET_SCOPES)[number];

/** Prices in minor units (pence, cents) per million tokens; seat price per month. */
export const ModelPriceInputSchema = z
  .object({
    /** As the engine or the provider takes it; a Claude id on the board's own models is put Claude Code's way. */
    model: z.string().trim().min(1).max(120),
    /** The company provider whose price this is; null or absent: the board's own models. */
    providerId: uuid.nullable().optional(),
    currency: z.string().trim().length(3).toUpperCase().default("GBP"),
    inputPerMillion: z.number().int().nonnegative().nullable().optional(),
    outputPerMillion: z.number().int().nonnegative().nullable().optional(),
    cacheReadPerMillion: z.number().int().nonnegative().nullable().optional(),
    cacheWritePerMillion: z.number().int().nonnegative().nullable().optional(),
    seatPriceMonth: z.number().int().nonnegative().nullable().optional(),
  })
  .transform((v) => (v.providerId ? v : { ...v, model: modelId.parse(v.model) }));
export type ModelPriceInput = z.input<typeof ModelPriceInputSchema>;
/** Fill list prices for the models the company uses on the board's own models, or for one provider's models. */
export const ListPricesInputSchema = z.object({ providerId: uuid.nullable().optional() });

// --- Reviews (M3) -------------------------------------------------------------

export const REVIEW_STATUSES = ["open", "changes_requested", "approved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** A comment anchored to a file and hunk, and optionally to one line of it. */
export const ReviewCommentSchema = z.object({
  file: z.string().trim().min(1).max(500),
  hunk: z.number().int().nonnegative(),
  /** New-side line number. */
  line: z.number().int().positive().optional(),
  /** Old-side line number, for a deleted line. */
  oldLine: z.number().int().positive().optional(),
  body: z.string().trim().min(1).max(20_000),
});
export const ReviewDecisionSchema = z.object({
  summary: z.string().trim().max(4000).optional(),
});
/** Who reviews from here: a teammate, a person with the reviewer role or above, or nobody (people decide). */
export const AssignReviewerSchema = z.object({
  reviewer: ActorRefSchema.nullable(),
});
export type AssignReviewerInput = z.infer<typeof AssignReviewerSchema>;
export const ReviewVetoSchema = z.object({
  note: z.string().trim().min(1).max(4000),
});
export const ReviewScoreSchema = z.object({
  scores: z
    .array(
      z.object({
        /** Index into the task's criteria. */
        criterion: z.number().int().nonnegative(),
        score: z.number().min(0).max(1),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type ReviewCommentInput = z.infer<typeof ReviewCommentSchema>;
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionSchema>;
export type ReviewVetoInput = z.infer<typeof ReviewVetoSchema>;
export type ReviewScoreInput = z.infer<typeof ReviewScoreSchema>;

// --- Peter (M4) ---------------------------------------------------------------

export const GOAL_STATUSES = ["planning", "needs_you", "active", "done", "stopped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Caps Peter plans within. He cannot create tasks past them without a person. */
export const GoalCapsSchema = z.object({
  maxTasks: z.number().int().positive().max(50).default(12),
  /** Tasks teammates file from a goal's tasks may nest this deep (0: only Peter's own tasks). */
  maxDepth: z.number().int().nonnegative().max(5).default(2),
  /** Lifetime token cap for the goal's project; null for none. */
  tokens: z.number().int().positive().nullable().default(null),
});
export type GoalCaps = z.infer<typeof GoalCapsSchema>;

export const CreateGoalSchema = z
  .object({
    text: z.string().trim().min(3).max(4000),
    /** Route the goal to a department (its lead plans it). Otherwise Peter picks or keeps it.
     */
    departmentId: uuid.nullable().optional(),
    /**
     * A project that exists, for the goal's tasks to go into instead of a new one. It stays as it is: its
     * name, goal text, repository and branch.
     */
    projectId: uuid.nullable().optional(),
    /**
     * The repository of the project the goal opens, and the branch its pull requests go to (main when
     * none is named). Peter plans changes to code only in a project with a repository.
     */
    repoUrl: repoUrl.nullable().optional(),
    defaultBranch: branch.optional(),
    caps: GoalCapsSchema.partial().default({}),
  })
  .refine((g) => !g.projectId || (!g.repoUrl && !g.defaultBranch), {
    message: "a goal goes into a project that exists or opens one on a repository, not both",
    path: ["projectId"],
  })
  .refine((g) => g.repoUrl || !g.defaultBranch, {
    message: "a branch belongs to a repository: name the repository too",
    path: ["defaultBranch"],
  });
/** Change a goal's caps after creation. Explicit, no defaults: an absent key means "leave it". */
export const UpdateGoalCapsSchema = z
  .object({
    maxTasks: z.number().int().positive().max(50).optional(),
    maxDepth: z.number().int().nonnegative().max(5).optional(),
    tokens: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateGoalCapsInput = z.infer<typeof UpdateGoalCapsSchema>;
export const AnswerGoalSchema = z.object({
  /** One answer per open question, in order. */
  answers: z.array(z.string().trim().min(1).max(4000)).min(1).max(10),
});
export const DRAFT_KINDS = ["org", "audit"] as const;
export const DRAFT_STATUSES = ["proposed", "accepted", "rejected"] as const;
export const ProposeOrgSchema = z.object({
  /** What the company needs, in the owner's words. */
  brief: z.string().trim().min(3).max(4000),
});
export type ProposeOrgInput = z.infer<typeof ProposeOrgSchema>;
export type CreateGoalInput = z.infer<typeof CreateGoalSchema>;
export type AnswerGoalInput = z.infer<typeof AnswerGoalSchema>;

// --- Governed tools (M5) -----------------------------------------------------

/**
 * pending: waiting on a person. approved: a person said yes; execution follows at once.
 * executed / failed: the bound bytes were sent (or the send failed). rejected: a person said no; Peter re-plans.
 */
/** superseded: a newer proposal of the same write replaced it while it waited; it cannot be approved. */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
  "superseded",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const ApprovalDecisionSchema = z.object({
  note: z.string().trim().max(4000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionSchema>;

/**
 * mcp: an MCP server over HTTP or stdio. openapi: an OpenAPI service. web: the board's own web fetch, one per
 * company, whose one tool reads a page and never writes.
 */
export const CONNECTION_KINDS = ["mcp", "openapi", "web"] as const;
export const MCP_TRANSPORTS = ["http", "stdio"] as const;
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an env var NAME");
/** A company secret's name: the env var NAME connections resolve. */
export const SecretNameSchema = envName;
/**
 * The one body on the board that carries a value: PUT /secrets/:name. It goes
 * write-only into the secret store; never through the raw-secret guard, never
 * into a row, an event or a response.
 */
export const SetSecretSchema = z.object({ value: z.string().trim().min(1).max(8192) });
export type SetSecretInput = z.infer<typeof SetSecretSchema>;
/** One tool on a connection, whether it writes, and whether a person switched it off for every teammate. */
export const ConnectionToolSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).default(""),
  write: z.boolean(),
  /** What classified it (ToolClassSource); "method" for an OpenAPI operation. */
  source: z
    .enum(["annotation", "catalog", "name", "default", "person", "method", "unconfirmed"])
    .default("default"),
  /** Switched off by a person: refused for everyone, whatever the toolbox grants; survives discovery. */
  off: z.boolean().optional(),
});
export type ConnectionToolInput = z.infer<typeof ConnectionToolSchema>;
/**
 * Authorise by OAuth against the server's authorization server (MCP over HTTP only) instead of naming an
 * env var: the board registers itself as a client unless a client id is given, sends a person through the
 * server's consent page, and keeps the tokens in its secret store. Nothing here is a value.
 */
export const ConnectionOAuthSchema = z
  .object({
    clientId: z.string().trim().min(1).max(200).optional(),
    /** Env var NAME holding the secret of a pre-registered client, read where the board runs. Never a value. */
    clientSecretEnvName: envName.optional(),
    scopes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  })
  .refine((v) => !(v.clientSecretEnvName && !v.clientId), {
    message: "a client secret goes with a client id; without one the board registers itself",
  });
export type ConnectionOAuthInput = z.infer<typeof ConnectionOAuthSchema>;
/**
 * A connection to an external system: an MCP server over HTTP or stdio (or an
 * OpenAPI service). Credentials are env var NAMES the board resolves at call
 * time; never values.
 */
export const CreateConnectionSchema = z
  .object({
    /** Short name teammates and toolboxes use: hubspot, slack, xero. */
    name: slug,
    catalogId: slug.optional(),
    kind: z.enum(CONNECTION_KINDS).default("mcp"),
    transport: z.enum(MCP_TRANSPORTS).default("http"),
    url: z.string().trim().url().max(500).optional(),
    command: z.string().trim().min(1).max(300).optional(),
    args: z.array(z.string().max(500)).max(50).default([]),
    /** Env var NAME on the board holding the bearer token (http) or handed to the child process (stdio). */
    authEnvName: envName.optional(),
    /** More env var NAMES handed to a stdio child. */
    envNames: z.array(envName).max(50).default([]),
    enabled: z.boolean().default(true),
    /** Tools known up front (from the catalog or by hand); discovery replaces them. */
    tools: z.array(ConnectionToolSchema).max(500).optional(),
    /** Authorise by OAuth instead of a credential by name. */
    oauth: ConnectionOAuthSchema.optional(),
    /** The web connection only: the domains it may read. Empty or absent: any public site. */
    domains: WebDomainsSchema.nullable().optional(),
  })
  .refine((v) => !(v.authEnvName && v.oauth), { message: "a credential by name or OAuth, not both" });
export type CreateConnectionInput = z.input<typeof CreateConnectionSchema>;
export const UpdateConnectionSchema = z.object({
  url: z.string().trim().url().max(500).nullable().optional(),
  command: z.string().trim().min(1).max(300).nullable().optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  authEnvName: envName.nullable().optional(),
  envNames: z.array(envName).max(50).optional(),
  enabled: z.boolean().optional(),
  /** Switch to OAuth (an object; a new client id or scopes start over), or back to a credential by name (null). */
  oauth: ConnectionOAuthSchema.nullable().optional(),
  /** The web connection only: the domains it may read; empty or null for any public site. */
  domains: WebDomainsSchema.nullable().optional(),
  /** Reclassify tools by name (a person's word is recorded as the source), or switch one off or on for everyone. */
  tools: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(128),
          write: z.boolean().optional(),
          off: z.boolean().optional(),
        })
        .refine((t) => t.write !== undefined || t.off !== undefined, {
          message: "say whether the tool writes, or whether it is off",
        }),
    )
    .max(500)
    .optional(),
});
export type UpdateConnectionInput = z.infer<typeof UpdateConnectionSchema>;

/** An OpenAPI connection: operations from a spec, allowlisted; a mutating method is always a write. */
export const OPENAPI_METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;
const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, "an HTTP header name");
export const OpenApiOperationSchema = z.object({
  /** The tool name teammates use: the operationId in snake_case. */
  name: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  operationId: z.string().min(1).max(128),
  method: z.enum(OPENAPI_METHODS),
  path: z.string().min(1).max(300),
  write: z.boolean(),
  summary: z.string().max(200).default(""),
});
export type OpenApiOperationInput = z.infer<typeof OpenApiOperationSchema>;
export const OpenApiManifestSchema = z.object({
  /** The header the credential travels in; default Authorization with a Bearer scheme. */
  authHeader: headerName.optional(),
  authScheme: z.enum(["bearer", "header"]).default("bearer"),
  timeoutMs: z.number().int().positive().max(30_000).default(15_000),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024)
    .default(64 * 1024),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024)
    .default(256 * 1024),
  operations: z.array(OpenApiOperationSchema).min(1).max(100),
});
export type OpenApiManifestInput = z.infer<typeof OpenApiManifestSchema>;
/** An OpenAPI 3.x document: parsed, or as text (JSON or YAML) the board parses. */
const openApiSpec = z.union([z.record(z.string(), z.unknown()), z.string().min(1).max(4_000_000)]);
export const OpenApiPreviewSchema = z.object({
  spec: openApiSpec,
});
export const CreateOpenApiConnectionSchema = z.object({
  name: slug,
  /** The base URL operation paths are appended to. */
  url: z.string().trim().url().max(500),
  authEnvName: envName.optional(),
  authHeader: headerName.optional(),
  authScheme: z.enum(["bearer", "header"]).optional(),
  spec: openApiSpec,
  /** operationIds to expose; nothing else exists on the connection. */
  allow: z.array(z.string().min(1).max(128)).min(1).max(100),
  /** operationIds to treat as writes although their method reads. Only ever tightens. */
  writes: z.array(z.string().min(1).max(128)).max(100).default([]),
  timeoutMs: z.number().int().positive().optional(),
  maxRequestBytes: z.number().int().positive().optional(),
  maxResponseBytes: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});
export type CreateOpenApiConnectionInput = z.input<typeof CreateOpenApiConnectionSchema>;

// --- Templates as files (M6) ------------------------------------------------------

/**
 * One importable file carries a company's shape: teammate templates, teammates and departments, all by
 * name, so the same file installs into any company. Names only: a persona or a playbook that carries a
 * credential value is refused at the import boundary by the raw-secret guard.
 */
export const TEMPLATES_FORMAT = "rosterdock/templates/1";
export const TemplateTeammateTemplateSchema = z.object({
  name,
  role: z.string().trim().min(1).max(80),
  engine: z.enum(ENGINES).default("claude_code"),
  model: modelId,
  personaMd: longText.default(""),
  playbooks: z.array(z.string().max(20_000)).max(50).default([]),
  avatar: z.string().trim().max(32).optional(),
  effort,
});
export const TemplateTeammateSchema = z.object({
  name,
  role: z.string().trim().min(1).max(80).optional(),
  /** A template by name (global or the company's); persona, engine and model come from it unless given here. */
  template: z.string().trim().max(120).nullable().optional(),
  engine: z.enum(ENGINES).optional(),
  model: modelId.optional(),
  personaMd: longText.optional(),
  playbooks: z.array(z.string().max(20_000)).max(50).optional(),
  avatar: z.string().trim().max(32).optional(),
  effort,
  /** Grants on connections by name; a connection the company does not have is dropped with a note. */
  toolbox: z.array(ToolboxEntrySchema).max(50).default([]),
});
export const TemplateDepartmentSchema = z.object({
  name,
  slug: slug.optional(),
  writePolicy: z.enum(WRITE_POLICIES).default("ask"),
  sandbox: SandboxPresetSchema.default({}),
  /** Teammates by name. */
  lead: name.nullable().optional(),
  members: z.array(name).max(200).default([]),
});
/** A connection by name: where it is and which env var NAMES it needs; never a value. */
export const TemplateConnectionSchema = z.object({
  name: slug,
  catalogId: slug.nullable().optional(),
  kind: z.enum(CONNECTION_KINDS).default("mcp"),
  transport: z.enum(MCP_TRANSPORTS).default("http"),
  url: z.string().trim().url().max(500).nullable().optional(),
  command: z.string().trim().min(1).max(300).nullable().optional(),
  args: z.array(z.string().max(500)).max(50).default([]),
  authEnvName: envName.nullable().optional(),
  envNames: z.array(envName).max(50).default([]),
  enabled: z.boolean().default(true),
  tools: z.array(ConnectionToolSchema).max(500).default([]),
  /** OpenAPI: the manifest as registered (operations, auth header, caps). */
  manifest: z.record(z.string(), z.unknown()).nullable().optional(),
});
/** A project's client policy, by project name; applied to the project of that name where it exists. */
export const TemplateClientPolicySchema = z.object({
  project: name,
  policy: ClientPolicySchema,
});
export const TemplatesFileSchema = z.object({
  format: z.literal(TEMPLATES_FORMAT),
  /** A title for the file; the company's template name is taken from it when the company has none. */
  company: z
    .object({
      name: name.optional(),
      template: z.string().trim().max(64).nullable().optional(),
    })
    .optional(),
  teammateTemplates: z.array(TemplateTeammateTemplateSchema).max(50).default([]),
  teammates: z.array(TemplateTeammateSchema).max(200).default([]),
  departments: z.array(TemplateDepartmentSchema).max(50).default([]),
  /** Created before the teammates, so toolbox grants by name resolve. */
  connections: z.array(TemplateConnectionSchema).max(100).default([]),
  clientPolicies: z.array(TemplateClientPolicySchema).max(200).default([]),
});
export type TemplatesFile = z.infer<typeof TemplatesFileSchema>;
export type TemplatesFileInput = z.input<typeof TemplatesFileSchema>;

export type DispatchRunInput = z.infer<typeof DispatchRunSchema>;
export type WorkerClaimInput = z.infer<typeof WorkerClaimSchema>;
export type RunEventInput = z.infer<typeof RunEventInputSchema>;
export type RunHeartbeatInput = z.infer<typeof RunHeartbeatSchema>;
export type RunArtifactInput = z.infer<typeof RunArtifactSchema>;
export type RunCompleteInput = z.infer<typeof RunCompleteSchema>;

export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
export type GrantMembershipInput = z.infer<typeof GrantMembershipSchema>;
export type CreateDepartmentInput = z.infer<typeof CreateDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof UpdateDepartmentSchema>;
export type DepartmentMemberInput = z.infer<typeof DepartmentMemberSchema>;
export type CreateTeammateInput = z.input<typeof CreateTeammateSchema>;
export type UpdateTeammateInput = z.infer<typeof UpdateTeammateSchema>;
export type CreateProjectInput = z.input<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.input<typeof UpdateProjectSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type MoveTaskInput = z.infer<typeof MoveTaskSchema>;
export type BlockerInput = z.infer<typeof BlockerInputSchema>;
export type PostMessageInput = z.infer<typeof PostMessageSchema>;
export type DevLoginInput = z.infer<typeof DevLoginSchema>;
export type MintTeammateTokenInput = z.infer<typeof MintTeammateTokenSchema>;

/** `@name` mentions in a message body, lowercased, deduplicated, in order of appearance. */
export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9_-]{0,63})/gi)) {
    const handle = (match[2] ?? "").toLowerCase();
    if (handle) seen.add(handle);
  }
  return [...seen];
}

/** Turn a teammate name into the handle that `@mention` resolves against: "Cody 2" becomes "cody2". */
export function handleFor(teammateName: string): string {
  return teammateName.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
