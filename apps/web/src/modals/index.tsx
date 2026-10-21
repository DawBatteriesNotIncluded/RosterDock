// Create flows: company, project, department, task, hire teammate, a goal for Peter, a brief for Peter.
import type {
  CreateDepartmentInput,
  CreateGoalInput,
  CreateTaskInput,
  CreateTeammateInput,
} from "@rosterdock/shared";
import { useEffect, useState, type FormEvent } from "react";
import type { CompanyData, GoalDetail, TeammateTemplate } from "../api/types.ts";
import { Avatar, Button, Field, Modal, Thinking } from "../components/ui.tsx";
import { DEFAULT_MODEL, engineChoices, PICKABLE_ENGINES, POLICY_LABEL } from "../lib/format.ts";

export const DEPT_TEMPLATES: Record<
  string,
  { name: string; roles: string[]; policy: "readonly" | "drafts" | "ask" }
> = {
  engineering: {
    name: "Engineering cell",
    roles: ["project manager", "n8n engineer", "n8n engineer", "reviewer"],
    policy: "drafts",
  },
  research: {
    name: "Research agency",
    roles: ["researcher", "requirements", "architect"],
    policy: "readonly",
  },
  marketing: { name: "Marketing ops", roles: ["reporting", "HubSpot analyst"], policy: "ask" },
  docs: { name: "Docs shop", roles: ["requirements", "reporting"], policy: "readonly" },
  audit: { name: "Audit office", roles: ["reviewer", "reviewer"], policy: "readonly" },
  finance: { name: "Finance", roles: ["finance analyst", "reviewer"], policy: "ask" },
  blank: { name: "Blank", roles: [], policy: "ask" },
};

function Footer({
  onClose,
  submitLabel,
  busy,
  disabled,
}: {
  onClose(): void;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" disabled={busy || disabled}>
        {submitLabel}
      </Button>
    </div>
  );
}

function useSubmit<T>(fn: (v: T) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    submit: (v: T) => async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      try {
        await fn(v);
      } catch {
        // toast already shown by run()
      } finally {
        setBusy(false);
      }
    },
  };
}

export function CreateCompanyModal({
  onClose,
  onCreate,
}: {
  onClose(): void;
  onCreate(input: { name: string }): Promise<void>;
}) {
  const [name, setName] = useState("");
  const { busy, submit } = useSubmit(onCreate);
  return (
    <Modal title="Create a company" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={submit({ name: name.trim() })}>
        <Field
          label="Name"
          hint="It starts with Peter. Import a company file in Settings, Templates, or describe the company you need with Design from a brief, and Peter drafts its departments."
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" autoFocus />
        </Field>
        <Footer onClose={onClose} submitLabel="Create company" busy={busy} disabled={!name.trim()} />
      </form>
    </Modal>
  );
}

export function CreateProjectModal({
  onClose,
  onCreate,
}: {
  onClose(): void;
  onCreate(input: {
    name: string;
    client: string;
    repoUrl: string | null;
    chargebackTag: string | null;
  }): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [chargebackTag, setChargebackTag] = useState("");
  const { busy, submit } = useSubmit(onCreate);
  return (
    <Modal title="New project" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={submit({
          name: name.trim(),
          client: client.trim() || "Internal",
          repoUrl: repoUrl.trim() || null,
          chargebackTag: chargebackTag.trim() || null,
        })}
      >
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="VMS architecture map"
            autoFocus
          />
        </Field>
        <Field label="Client" hint="Client-specific policies bind per project, never board-wide.">
          <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Internal" />
        </Field>
        <Field
          label="Chargeback tag (optional)"
          hint="A cost centre or invoice reference; the monthly cost report groups by it."
        >
          <input
            value={chargebackTag}
            onChange={(e) => setChargebackTag(e.target.value)}
            placeholder="ACME-2026-Q3"
            className="mono"
          />
        </Field>
        <Field
          label="Repository (optional)"
          hint="An https git URL the worker clones. Credentials come from the worker environment by name."
        >
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git"
            className="mono"
          />
        </Field>
        <Footer onClose={onClose} submitLabel="Open project" busy={busy} disabled={!name.trim()} />
      </form>
    </Modal>
  );
}

export function CreateDepartmentModal({
  data,
  onClose,
  onCreate,
}: {
  data: CompanyData;
  onClose(): void;
  onCreate(input: CreateDepartmentInput): Promise<void>;
}) {
  const [tpl, setTpl] = useState("engineering");
  const [name, setName] = useState(DEPT_TEMPLATES.engineering!.name);
  const [policy, setPolicy] = useState<CreateDepartmentInput["writePolicy"]>("drafts");
  const [lead, setLead] = useState<string>(data.teammates[0]?.id ?? "");
  const [members, setMembers] = useState<string[]>([]);
  const [pool, setPool] = useState("");
  const { busy, submit } = useSubmit(onCreate);
  const pickTpl = (id: string) => {
    setTpl(id);
    const t = DEPT_TEMPLATES[id]!;
    setName(t.name === "Blank" ? "" : t.name);
    setPolicy(t.policy);
  };
  return (
    <Modal title="Create a department" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={submit({
          name: name.trim(),
          writePolicy: policy,
          leadTeammateId: lead || undefined,
          memberTeammateIds: members.filter((m) => m !== lead),
          sandbox: pool.trim() ? { pool: pool.trim() } : {},
        })}
      >
        <Field
          label="Template"
          hint={
            DEPT_TEMPLATES[tpl]!.roles.length
              ? `Roles: ${DEPT_TEMPLATES[tpl]!.roles.join(", ")}`
              : "No suggested roles"
          }
        >
          <select value={tpl} onChange={(e) => pickTpl(e.target.value)}>
            {Object.entries(DEPT_TEMPLATES).map(([k, t]) => (
              <option key={k} value={k}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering" />
        </Field>
        <Field
          label="Write policy"
          hint="Narrows what members may do with live systems. Never widens a toolbox."
        >
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as CreateDepartmentInput["writePolicy"])}
          >
            {Object.entries(POLICY_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Runs on (optional)"
          hint="A worker pool your operator set up with its own network rules (the chart's worker.pools). Empty: the default fleet."
        >
          <input
            value={pool}
            onChange={(e) => setPool(e.target.value)}
            placeholder="secure"
            className="mono"
            pattern="[a-z0-9][a-z0-9-]{0,31}"
          />
        </Field>
        <Field label="Lead">
          <select value={lead} onChange={(e) => setLead(e.target.value)}>
            <option value="">No lead yet</option>
            {data.teammates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.role}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Members">
          <div className="checklist">
            {data.teammates
              .filter((t) => t.id !== lead)
              .map((t) => (
                <label key={t.id}>
                  <input
                    type="checkbox"
                    checked={members.includes(t.id)}
                    onChange={(e) =>
                      setMembers(e.target.checked ? [...members, t.id] : members.filter((m) => m !== t.id))
                    }
                  />
                  <Avatar name={t.name} handle={t.handle} size="s" />
                  {t.name} · {t.role}
                </label>
              ))}
            {data.teammates.length === 0 ? (
              <span className="text-[12px] text-muted">
                No teammates yet. Hire some first, or add them later in the matrix.
              </span>
            ) : null}
          </div>
        </Field>
        <Footer onClose={onClose} submitLabel="Create department" busy={busy} disabled={!name.trim()} />
      </form>
    </Modal>
  );
}

export function CreateTaskModal({
  data,
  defaultProjectId,
  defaultDepartmentId,
  onClose,
  onCreate,
}: {
  data: CompanyData;
  defaultProjectId?: string;
  defaultDepartmentId?: string;
  onClose(): void;
  onCreate(input: CreateTaskInput): Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [outputs, setOutputs] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? data.projects[0]?.id ?? "");
  const [departmentId, setDepartmentId] = useState(defaultDepartmentId ?? "");
  const [assignee, setAssignee] = useState("");
  const { busy, submit } = useSubmit(onCreate);
  const [kind, id] = assignee
    ? (assignee.split(":") as ["user" | "teammate", string])
    : [undefined, undefined];
  return (
    <Modal title="New task" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={submit({
          projectId,
          title: title.trim(),
          description,
          departmentId: departmentId || null,
          assignee: kind && id ? { kind, id } : null,
          dependsOn: [],
          criteria: [],
          workKind: "build",
          declaredOutputs: outputs
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        })}
      >
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Map VMS sub-workflow calls"
            autoFocus
          />
        </Field>
        <div className="grid2">
          <Field label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Department">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">None</option>
              {data.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Assignee">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            <optgroup label="Teammates">
              {data.teammates.map((t) => (
                <option key={t.id} value={`teammate:${t.id}`}>
                  {t.name} · {t.role}
                </option>
              ))}
            </optgroup>
            <optgroup label="People">
              {data.members.map((m) => (
                <option key={m.userId} value={`user:${m.userId}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <Field label="Brief" hint="What done looks like. Names only for credentials.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ minHeight: 90 }}
          />
        </Field>
        <Field
          label="Expected outputs"
          hint="File names the run must produce, comma-separated. Leave empty to keep whatever the teammate writes."
        >
          <input
            value={outputs}
            onChange={(e) => setOutputs(e.target.value)}
            placeholder="vms-architecture.md, handover.md"
            className="mono"
          />
        </Field>
        {data.projects.length === 0 ? (
          <span className="hint" style={{ color: "var(--bad)" }}>
            Open a project first.
          </span>
        ) : null}
        <Footer
          onClose={onClose}
          submitLabel="Create task"
          busy={busy}
          disabled={!title.trim() || !projectId}
        />
      </form>
    </Modal>
  );
}

/** Hand Peter a goal: he plans it before the modal shows the result, questions or tasks. */
export function NewGoalModal({
  data,
  onClose,
  onCreate,
  onAnswer,
  onOpenBoard,
}: {
  data: CompanyData;
  onClose(): void;
  onCreate(input: CreateGoalInput): Promise<GoalDetail>;
  onAnswer(goalId: string, answers: string[]): Promise<GoalDetail>;
  onOpenBoard(projectId: string): void;
}) {
  const [text, setText] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [tokens, setTokens] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [phase, setPhase] = useState<"input" | "thinking" | "result">("input");
  const [goal, setGoal] = useState<GoalDetail | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const open = goal?.questions.filter((q) => q.answer === null) ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPhase("thinking");
    try {
      const g = await onCreate({
        text: text.trim(),
        departmentId: departmentId || null,
        ...(repoUrl.trim()
          ? { repoUrl: repoUrl.trim(), ...(branch.trim() ? { defaultBranch: branch.trim() } : {}) }
          : {}),
        caps: tokens.trim() ? { tokens: Number(tokens) } : {},
      });
      setGoal(g);
      setAnswers(g.questions.filter((q) => q.answer === null).map(() => ""));
      setPhase("result");
    } catch {
      setPhase("input");
    }
  };
  const answer = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal) return;
    setPhase("thinking");
    try {
      const g = await onAnswer(goal.id, answers);
      setGoal(g);
      setAnswers(g.questions.filter((q) => q.answer === null).map(() => ""));
    } finally {
      setPhase("result");
    }
  };
  return (
    <Modal title="New goal" onClose={onClose}>
      {phase === "input" ? (
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="Tell Peter what you want done">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Map every downstream process of the VMS workflow and give me diagrams with notes"
              style={{ minHeight: 96 }}
              autoFocus
            />
          </Field>
          <div className="grid2">
            <Field label="Department" hint="Its lead plans and watches the goal. Leave it to Peter to route.">
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Let Peter route it</option>
                {data.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Token cap (optional)" hint="A lifetime budget for the goal; runs stop at the cap.">
              <input
                value={tokens}
                onChange={(e) => setTokens(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="2000000"
                className="mono"
              />
            </Field>
          </div>
          <div className="grid2">
            <Field
              label="Repository (optional)"
              hint="Peter plans changes to its code, and each approved change opens a pull request. Without one, the goal delivers files."
            >
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/acme/app"
                className="mono"
              />
            </Field>
            <Field label="Branch" hint="Where its pull requests go.">
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="mono"
                disabled={!repoUrl.trim()}
              />
            </Field>
          </div>
          <Footer
            onClose={onClose}
            submitLabel="Hand to Peter"
            busy={false}
            disabled={text.trim().length < 3}
          />
        </form>
      ) : phase === "thinking" ? (
        <Thinking>Peter is reading the goal and splitting it into tasks…</Thinking>
      ) : goal && goal.status === "needs_you" && open.length ? (
        <form className="flex flex-col gap-3" onSubmit={answer}>
          <span className="text-[13px] text-ink-2">
            Peter has {open.length === 1 ? "a question" : `${open.length} questions`} before he plans.
          </span>
          {open.map((q, i) => (
            <Field key={i} label={q.text}>
              <textarea
                value={answers[i] ?? ""}
                onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                rows={2}
              />
            </Field>
          ))}
          <Footer
            onClose={onClose}
            submitLabel="Answer"
            busy={false}
            disabled={answers.some((a) => !a.trim())}
          />
        </form>
      ) : goal && goal.status === "active" ? (
        <div className="flex flex-col gap-3">
          <span className="text-[13px] text-ink-2">
            Peter split it into {goal.tasks.length} task{goal.tasks.length === 1 ? "" : "s"}
            {goal.plan?.department ? ` for ${goal.plan.department}` : ""}. The first{" "}
            {goal.tasks.filter((t) => t.status === "doing").length === 1 ? "one has" : "ones have"} started.
          </span>
          <div className="plan">
            {goal.tasks.map((t) => {
              const mate = data.teammates.find((x) => x.id === t.assignee?.id);
              return (
                <div key={t.id} className="plan-item">
                  {mate ? <Avatar name={mate.name} handle={mate.handle} size="s" /> : null}
                  <span className="t">{t.title}</span>
                  <span className="role">{mate?.role ?? "unassigned"}</span>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
            <Button type="button" variant="primary" onClick={() => onOpenBoard(goal.projectId)}>
              Open the board
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <span className="text-[13px] text-ink-2">
            {goal?.attention ?? "Peter could not plan this goal."}
          </span>
          <div className="flex justify-end">
            <Button type="button" variant="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Ask Peter to design departments from a brief; the result is a draft on the Company page. */
export function DesignCompanyModal({
  onClose,
  onSubmit,
}: {
  onClose(): void;
  onSubmit(brief: string): Promise<void>;
}) {
  const [brief, setBrief] = useState("");
  // Peter's model can take minutes over a whole company: say so while he works, and let the person go.
  const [thinking, setThinking] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setThinking(true);
    try {
      await onSubmit(brief.trim());
    } catch {
      // The error is a toast (run()); the brief is still here to send again.
      setThinking(false);
    }
  };
  return (
    <Modal title="Design from a brief" onClose={onClose}>
      {thinking ? (
        <div className="flex flex-col gap-3">
          <Thinking>Peter is designing departments, teammates and toolboxes from your brief…</Thinking>
          <span className="hint">
            His model can take a few minutes over a whole company. You can close this: the draft appears under
            Peter proposes on the Company page when it is ready, and nothing is created until you accept it.
          </span>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field
            label="What does the company need?"
            hint="Peter proposes departments, teammates, toolboxes and policies as a draft you accept. He grants nothing himself."
          >
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. I need a finance function that reconciles Xero weekly"
              style={{ minHeight: 90 }}
              autoFocus
            />
          </Field>
          <Footer onClose={onClose} submitLabel="Ask Peter" busy={false} disabled={brief.trim().length < 3} />
        </form>
      )}
    </Modal>
  );
}

/** A template on an engine nobody can pick (OpenCode) hires onto Claude Code instead. */
const engineOf = (t: TeammateTemplate) => (PICKABLE_ENGINES.includes(t.engine) ? t.engine : "claude_code");

export function HireTeammateModal({
  templates,
  onClose,
  onCreate,
}: {
  templates: TeammateTemplate[];
  onClose(): void;
  onCreate(input: CreateTeammateInput): Promise<void>;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const tpl = templates.find((t) => t.id === templateId);
  const [name, setName] = useState(tpl?.name ?? "");
  const [role, setRole] = useState(tpl?.role ?? "");
  const [engine, setEngine] = useState(tpl ? engineOf(tpl) : "claude_code");
  const [model, setModel] = useState(tpl?.model ?? DEFAULT_MODEL);
  const { busy, submit } = useSubmit(onCreate);
  useEffect(() => {
    if (!tpl) return;
    setName(tpl.name);
    setRole(tpl.role);
    setEngine(engineOf(tpl));
    setModel(tpl.model);
  }, [tpl]);
  return (
    <Modal title="Hire from template" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={submit({
          name: name.trim(),
          role: role.trim(),
          engine: engine as CreateTeammateInput["engine"],
          model: model.trim(),
          personaMd: tpl?.personaMd ?? "",
          playbooks: tpl?.playbooks ?? [],
          templateId: templateId || undefined,
        })}
      >
        <Field label="Template">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.role}
              </option>
            ))}
            <option value="">Blank</option>
          </select>
        </Field>
        <div className="grid2">
          <Field label="Name" hint="Unique per company. Cody, Cody 2, Cody 3 all work.">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role">
            <input value={role} onChange={(e) => setRole(e.target.value)} />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Engine">
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {engineChoices(engine).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <input value={model} onChange={(e) => setModel(e.target.value)} className="mono" />
          </Field>
        </div>
        {tpl ? <div className="card p-3 text-[13px] leading-relaxed text-ink-2">{tpl.personaMd}</div> : null}
        <span className="hint">
          A teammate is a persona and a permission set. Seat them in a department afterwards.
        </span>
        <Footer
          onClose={onClose}
          submitLabel="Hire"
          busy={busy}
          disabled={!name.trim() || !role.trim() || !model.trim()}
        />
      </form>
    </Modal>
  );
}
