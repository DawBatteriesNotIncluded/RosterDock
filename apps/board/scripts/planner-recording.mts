// The planning call the model CLI recorders send: Peter's system prompt for a
// small roster and one goal, the question round already used so the answer is
// a plan. test/claude-cli.test.ts and test/planners.test.ts replay the answers.
import {
  MAX_PLAN_TASKS,
  PlanSchema,
  plannerSystemPrompt,
  plannerUserPrompt,
  type Roster,
} from "../src/peter/plan.js";

export const RECORDED_GOAL =
  "Write a one-page competitive brief on self-hosted AI agent platforms, with sources, then a landing page draft built from it.";

const roster: Roster = {
  managerId: "peter",
  departments: [],
  teammates: [
    { id: "peter", name: "Peter", handle: "peter", role: "project manager", load: 0, departmentIds: [] },
    { id: "ricky", name: "Ricky", handle: "ricky", role: "researcher", load: 0, departmentIds: [] },
    { id: "brody", name: "Brody", handle: "brody", role: "requirements", load: 0, departmentIds: [] },
    { id: "cody", name: "Cody", handle: "cody", role: "n8n engineer", load: 0, departmentIds: [] },
    { id: "verifier", name: "Verifier", handle: "verifier", role: "reviewer", load: 0, departmentIds: [] },
  ],
};

export function recordedRequest(model: string) {
  return {
    model,
    system: plannerSystemPrompt(roster),
    user: plannerUserPrompt({
      goal: RECORDED_GOAL,
      answers: [],
      mayAsk: false,
      maxTasks: MAX_PLAN_TASKS,
      departmentId: null,
      repo: null,
    }),
    schema: PlanSchema,
  };
}
