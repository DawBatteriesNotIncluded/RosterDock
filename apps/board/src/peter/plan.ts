// Intake and decomposition. A goal becomes a plan: background, outcome, done
// definition, at most a few clarifying questions, and tasks with briefs,
// acceptance criteria, expected outputs, dependencies (a DAG by construction)
// and an assignee chosen by role and load. The model produces the plan when
// Peter has one; the heuristic produces it otherwise, and whenever the model's
// plan does not validate. Both are pure functions of the goal and the roster.
// The intake shape is the v1 planner's task pack (agent-board planner.ts),
// with lanes replaced by teammates and departments.

import { z } from "zod";

export const MAX_PLAN_TASKS = 12;
export const MAX_QUESTIONS = 4;
/** Peter asks once; after the answers he plans. */
export const MAX_QUESTION_ROUNDS = 1;

export interface RosterMate {
  id: string;
  name: string;
  handle: string;
  role: string;
  /** Tasks not done that are assigned to this teammate. */
  load: number;
  departmentIds: string[];
}

export interface RosterDepartment {
  id: string;
  name: string;
  writePolicy: string;
}

export interface Roster {
  teammates: RosterMate[];
  departments: RosterDepartment[];
  /** The manager planning; never assigned work. */
  managerId: string;
}

export interface PlanInput {
  goal: string;
  /** Answered questions so far: [{text, answer}]. */
  answers: { text: string; answer: string }[];
  /** False once Peter has used his question round. */
  mayAsk: boolean;
  maxTasks: number;
  /** Route to this department only (a lead planning its own department). */
  departmentId: string | null;
  repoUrl: string | null;
  /** Why the board did not accept the model's first plan; the second try reads it. */
  refused?: string[];
}

export const PlanTaskSchema = z.object({
  title: z.string().min(1).max(300),
  brief: z.string().max(20_000),
  /** @handle of the teammate to assign. */
  assignee: z.string().min(1).max(64),
  workKind: z.enum(["build", "research"]),
  /** Flat file names the run must produce. */
  outputs: z.array(z.string().min(1).max(200)).max(20),
  criteria: z.array(z.object({ text: z.string().min(1).max(500), weight: z.number() })).max(10),
  /** Zero-based indexes of EARLIER tasks this one waits on. */
  dependsOn: z.array(z.number().int()).max(10),
});

export const PlanSchema = z.object({
  /** Short project name. */
  title: z.string().min(1).max(120),
  background: z.string().max(4000),
  outcome: z.string().max(2000),
  doneDefinition: z.string().max(1000),
  /** Questions for the person; empty when the goal is clear enough to plan. */
  questions: z.array(z.string().min(1).max(500)).max(MAX_QUESTIONS),
  /** Department name the goal belongs to, or null. */
  department: z.string().nullable(),
  tasks: z.array(PlanTaskSchema).max(MAX_PLAN_TASKS),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;

const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/**
 * A plan must name teammates that exist (never the manager, never a
 * reviewer), form a DAG, stay within the cap, and use flat output names.
 * Returns the reasons it does not, empty when it does.
 */
export function validatePlan(plan: Plan, roster: Roster, maxTasks: number): string[] {
  const errors: string[] = [];
  const handles = new Map(roster.teammates.map((t) => [t.handle, t]));
  if (plan.questions.length === 0 && plan.tasks.length === 0) errors.push("no tasks and no questions");
  if (plan.tasks.length > maxTasks) errors.push(`${plan.tasks.length} tasks is over the cap of ${maxTasks}`);
  plan.tasks.forEach((t, i) => {
    const mate = handles.get(t.assignee.replace(/^@/, "").toLowerCase());
    if (!mate) errors.push(`task ${i + 1} names @${t.assignee.replace(/^@/, "")}, who is not on the roster`);
    else if (mate.id === roster.managerId) errors.push(`task ${i + 1} is assigned to the manager`);
    else if (isReviewer(mate.role)) errors.push(`task ${i + 1} is assigned to a reviewer`);
    for (const d of t.dependsOn) {
      if (d < 0 || d >= i) errors.push(`task ${i + 1} depends on task ${d + 1}, which is not earlier`);
    }
    for (const o of t.outputs)
      if (!OUTPUT_NAME.test(o)) errors.push(`task ${i + 1} output "${o}" is not a flat file name`);
    for (const c of t.criteria)
      if (!(c.weight > 0) || c.weight > 100)
        errors.push(`task ${i + 1} has a criterion with weight ${c.weight}`);
  });
  if (plan.department && !roster.departments.some((d) => d.name === plan.department))
    errors.push(`department "${plan.department}" does not exist`);
  return errors;
}

export function isReviewer(role: string): boolean {
  return /(review|verif|\bqa\b|quality)/i.test(role);
}
export function isManager(role: string): boolean {
  return /(project manager|\bpm\b|manager)/i.test(role);
}
function isResearcher(role: string): boolean {
  return /(research|analyst)/i.test(role);
}
function isRequirements(role: string): boolean {
  return /(requirement|product)/i.test(role);
}
function isBuilder(role: string): boolean {
  return /(engineer|developer|build|architect|programmer|ops)/i.test(role);
}

/** Fewest open tasks first, then seniority. Never the manager, never a reviewer. */
export function pickByLoad(
  mates: RosterMate[],
  roster: Roster,
  departmentId: string | null,
): RosterMate | null {
  const eligible = mates.filter(
    (m) => m.id !== roster.managerId && !isReviewer(m.role) && !isManager(m.role),
  );
  const inDept = departmentId ? eligible.filter((m) => m.departmentIds.includes(departmentId)) : [];
  const pool = inDept.length ? inDept : eligible;
  return [...pool].sort((a, b) => a.load - b.load)[0] ?? null;
}

function shortTitle(goal: string): string {
  const first = goal.split(/[.\n]/)[0]?.trim() ?? goal;
  return (first.length > 80 ? `${first.slice(0, 77)}…` : first) || "Goal";
}

/**
 * The model-free plan: research when there is a researcher, requirements when
 * there is one, then the build, each waiting on the previous. One task per
 * stage, assigned by load. A goal with no one to do it yields a question.
 */
export function heuristicPlan(input: PlanInput, roster: Roster): Plan {
  const title = shortTitle(input.goal);
  const dept = input.departmentId
    ? (roster.departments.find((d) => d.id === input.departmentId) ?? null)
    : null;
  const byKind = (pred: (role: string) => boolean) =>
    pickByLoad(
      roster.teammates.filter((m) => pred(m.role)),
      roster,
      input.departmentId,
    );
  const researcher = byKind(isResearcher);
  const requirements = byKind(isRequirements);
  const builder = byKind(isBuilder);
  const anyone = pickByLoad(roster.teammates, roster, input.departmentId);
  const tasks: PlanTask[] = [];
  const answers = input.answers.length
    ? `\n\nAnswers from the owner:\n${input.answers.map((a) => `- ${a.text}\n  ${a.answer}`).join("\n")}`
    : "";
  const brief = (what: string) => `${what}\n\nGoal: ${input.goal}${answers}`;
  if (researcher) {
    tasks.push({
      title: `Research: ${title}`,
      brief: brief(
        "Find out what is already there and what the constraints are. Write research.md with findings, options and a Sources section that cites every source.",
      ),
      assignee: researcher.handle,
      workKind: "research",
      outputs: ["research.md"],
      criteria: [
        { text: "Findings answer the goal's questions with evidence", weight: 2 },
        { text: "Every claim cites a source", weight: 1 },
      ],
      dependsOn: [],
    });
  }
  if (requirements) {
    tasks.push({
      title: `Requirements: ${title}`,
      brief: brief(
        "Write requirements.md: the format, schedule, inputs, outputs and acceptance criteria a builder needs, with open questions listed at the end.",
      ),
      assignee: requirements.handle,
      workKind: "research",
      outputs: ["requirements.md"],
      criteria: [
        { text: "A builder can implement from this without asking", weight: 2 },
        { text: "Acceptance criteria are observable", weight: 1 },
      ],
      dependsOn: tasks.length ? [tasks.length - 1] : [],
    });
  }
  const worker = builder ?? (tasks.length ? null : anyone);
  if (worker) {
    tasks.push({
      title: `Build: ${title}`,
      brief: brief(
        input.repoUrl
          ? "Implement the goal in the repository. Keep the change small and reviewable; do not commit, your diff is captured."
          : "Produce the deliverable for the goal in your working directory and describe it in the handover.",
      ),
      assignee: worker.handle,
      workKind: "build",
      outputs: input.repoUrl ? [] : ["deliverable.md"],
      criteria: [
        { text: "The goal's outcome is met", weight: 3 },
        { text: "No credential values anywhere", weight: 1 },
      ],
      dependsOn: tasks.length ? [tasks.length - 1] : [],
    });
  }
  // Route the goal to the one department every assignee sits in, so its lead tends it from here on.
  const assigned = tasks
    .map((t) => roster.teammates.find((m) => m.handle === t.assignee))
    .filter((m): m is RosterMate => !!m);
  const shared = assigned.length
    ? roster.departments.find((d) => assigned.every((m) => m.departmentIds.includes(d.id)))
    : undefined;
  // The heuristic never asks: with nobody to do the work, the goal escalates to a person instead.
  return {
    title,
    background: `Handed to Peter as a goal: ${input.goal}`,
    outcome: input.answers[0]?.answer ?? `The goal is delivered and reviewed: ${title}`,
    doneDefinition: "Every task is approved in review; the last review's outputs answer the goal.",
    questions: [],
    department: dept?.name ?? shared?.name ?? null,
    tasks: tasks.slice(0, input.maxTasks),
  };
}

// --- Prompts for the model path ---------------------------------------------

export function plannerSystemPrompt(roster: Roster): string {
  const team = roster.teammates
    .filter((m) => m.id !== roster.managerId)
    .map(
      (m) =>
        `- @${m.handle} (${m.name}), ${m.role}, ${m.load} open task${m.load === 1 ? "" : "s"}${m.departmentIds.length ? `, in ${m.departmentIds.map((d) => roster.departments.find((x) => x.id === d)?.name ?? d).join("/")}` : ""}`,
    )
    .join("\n");
  const depts =
    roster.departments.map((d) => `- ${d.name} (write policy: ${d.writePolicy})`).join("\n") || "- none";
  return [
    "You are Peter, the project manager of an AI company on the RosterDock board. You plan; you never execute.",
    "Turn the owner's goal into a plan the team can run without you: background, the required outcome, a verifiable done definition, and tasks.",
    "",
    "The team (assign by role, prefer the least loaded; never assign a reviewer, they review every task automatically; never assign yourself):",
    team || "- nobody yet",
    "",
    "Departments:",
    depts,
    "",
    "Rules:",
    `- At most ${MAX_PLAN_TASKS} tasks. Each task has a brief the assignee can act on alone, 1 to 4 weighted acceptance criteria the reviewer scores, and expected outputs as flat file names (research and documents as .md; code tasks in a repository leave outputs empty, their diff is reviewed).`,
    "- workKind is research for documents with sources, build for code or deliverables.",
    "- dependsOn lists zero-based indexes of EARLIER tasks only; the first task has none. Keep chains short so work runs in parallel where it can.",
    `- Ask at most ${MAX_QUESTIONS} clarifying questions, and only when the answer changes the plan. When you ask, leave tasks empty. When you have enough, questions is empty and tasks is full.`,
    "- Never include credential values; refer to credentials by name.",
    "- department is one of the department names above, or null.",
  ].join("\n");
}

export function plannerUserPrompt(input: PlanInput): string {
  const lines = [`Goal from the owner:\n${input.goal}`];
  if (input.repoUrl) lines.push(`\nThe project's repository: ${input.repoUrl}`);
  if (input.answers.length) {
    lines.push("\nYou asked, and the owner answered:");
    for (const a of input.answers) lines.push(`Q: ${a.text}\nA: ${a.answer}`);
  }
  lines.push(
    input.mayAsk
      ? "\nIf something essential is missing, ask now (questions non-empty, tasks empty). Otherwise plan."
      : "\nYou have asked your questions. Plan now with what you have; questions must be empty.",
  );
  lines.push(`\nPlan at most ${input.maxTasks} tasks.`);
  if (input.refused?.length) {
    lines.push(
      "\nThe board did not accept your last plan for this goal:",
      ...input.refused.map((p) => `- ${p}`),
      "Plan again with exactly that put right; keep what was sound.",
    );
  }
  return lines.join("\n");
}
