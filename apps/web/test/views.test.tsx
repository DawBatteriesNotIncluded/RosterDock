// Headless smoke: every view renders to HTML with sample data and shows the
// things the prototype shows. No DOM, no network.
import { blockerFor, EVENT_TYPES } from "@rosterdock/shared";
import { blockerLine, blockerNeedsYou } from "../src/lib/format.ts";
import { renderToString } from "react-dom/server";
import type { Approval, CompanyData } from "../src/api/types.ts";
import { describe, expect, it } from "vitest";
import { Shell } from "../src/components/Shell.tsx";
import { Avatar, elapsedLabel, Thinking, Topbar } from "../src/components/ui.tsx";
import { describeEvent, engineChoices, relativeTime, teammateStatus } from "../src/lib/format.ts";
import {
  CreateDepartmentModal,
  CreateTaskModal,
  DesignCompanyModal,
  HireTeammateModal,
  NewGoalModal,
} from "../src/modals/index.tsx";
import { GoalResultPanel, goalProgress, goalTone, publishedVerdict } from "../src/views/GoalsPanel.tsx";
import { ActivityView } from "../src/views/ActivityView.tsx";
import {
  afterRejectionText,
  APPROVAL_LABEL,
  ApprovalsView,
  sortApprovals,
} from "../src/views/ApprovalsView.tsx";
import { capFor, ClientPoliciesPanel } from "../src/views/ClientPoliciesPanel.tsx";
import { messageWithIssues } from "../src/api/client.ts";
import {
  AddWebForm,
  checkLine,
  confirmAsRead,
  ConnectionsPanel,
  connectionSummary,
  heldReads,
  consentUrl,
  privateFlag,
  stdioListed,
} from "../src/views/ConnectionsPanel.tsx";
import { ConnectionGrant } from "../src/views/ToolboxEditor.tsx";
import { domainsText, parseDomains, webDomainsOf } from "../src/views/WebDomains.tsx";
import { policyNarrows, withWebDomains } from "../src/views/ClientPoliciesPanel.tsx";
import { BoardView } from "../src/views/BoardView.tsx";
import { CompanyView } from "../src/views/CompanyView.tsx";
import {
  CostsView,
  fourteenDays,
  modelLabel,
  money,
  MonthlyView,
  monthOf,
  workCount,
} from "../src/views/CostsView.tsx";
import { characterRows, carpetOf, HAIR_STYLES, lookFor } from "../src/views/office/art.ts";
import {
  lineDuration,
  newStage,
  plainText,
  shortAge,
  stepStage,
  STAGE_MAX,
} from "../src/views/office/dialogue.ts";
import {
  agentMode,
  companyManager,
  dialogueLines,
  inRoom,
  findPath,
  seatOf,
  walkable,
  walkGrid,
  dropDesk,
  dropRoom,
  officeInteractions,
  officeLayout,
  officeSettings,
  OfficeView,
  pendingApprovals,
  recolorRoom,
  officePack,
  roomImageName,
  spriteFrame,
} from "../src/views/OfficeView.tsx";
import {
  budgetLine,
  driftForm,
  importSummary,
  listPricesLine,
  notifyFromForm,
  plannerLine,
  styleSource,
  scopeName,
  SETTINGS_TABS,
  SettingsView,
  toMinor,
} from "../src/views/SettingsView.tsx";
import { REVIEW_LABEL, ReviewsView, sortReviews, splitRows } from "../src/views/ReviewsView.tsx";
import { DELIVERABLE_LABEL, fmtBytes, fmtCpu, fmtTokens, otherFiles } from "../src/views/RunPanel.tsx";
import { WorkingNow } from "../src/views/WorkingNow.tsx";
import { loginErrorText, LoginView } from "../src/views/Login.tsx";
import { cellState, DepartmentsView, nextCellState } from "../src/views/DepartmentsView.tsx";
import {
  draftDirty,
  editorState,
  EFFORT_CHOICES,
  refreshed,
  TeammatesView,
  toolboxLines,
  withGrant,
} from "../src/views/TeammatesView.tsx";
import { nextGrant, toolGrantedBy } from "../src/views/ToolboxEditor.tsx";
import {
  approvalFixtures,
  approvalsFixture,
  budgetFixture,
  connectionFixtures,
  connectionsFixture,
  costFixture,
  fixture,
  liveRunFixture,
  monthlyFixture,
  peterFixture,
  priceFixture,
  reviewFixture,
  reviewListFixture,
} from "./fixtures.ts";

const noop = () => {};
const asyncNoop = async () => {};
// React's server renderer separates adjacent text nodes with comment markers.
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");

const companyProps = {
  meId: fixture.members[0]!.userId,
  onNewProject: noop,
  onNewTask: noop,
  onNewDepartment: noop,
  onOpenProject: noop,
  onOpenDepartmentBoard: noop,
  onOpenTask: noop,
  onOpenReview: noop,
  onOpenTeammate: noop,
  onGoActivity: noop,
  onNewGoal: noop,
  onAnswerGoal: asyncNoop,
  onStopGoal: asyncNoop,
  onUpdateGoalCaps: asyncNoop,
  canDecide: true,
  onDesign: noop,
  onAudit: asyncNoop,
  onAcceptDraft: asyncNoop,
  onRejectDraft: asyncNoop,
};

const stylesFixture = [
  {
    id: "ponytail",
    label: "Minimal code (Ponytail)",
    what: "Write the least code that works.",
    applies: "code" as const,
    levels: null,
    level: null,
    enabled: false,
    source: {
      home: "https://github.com/dietrichgebert/ponytail",
      repo: "dietrichgebert/ponytail",
      commit: "e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156",
      path: "AGENTS.md",
      license: "MIT",
      url: "https://raw.githubusercontent.com/dietrichgebert/ponytail/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/AGENTS.md",
    },
    bundled: false,
    fetchedAt: null,
  },
  {
    id: "caveman",
    label: "Terse replies (Caveman)",
    what: "Say it short.",
    applies: "replies" as const,
    levels: ["lite", "full", "ultra"],
    level: "lite",
    enabled: true,
    source: {
      home: "https://caveman.so",
      repo: "JuliusBrussee/caveman",
      commit: "2fd153c67988e980fb0b2455c90832159a6a5a25",
      path: "plugins/caveman/skills/caveman/SKILL.md",
      license: "MIT",
      url: "https://raw.githubusercontent.com/JuliusBrussee/caveman/2fd153c67988e980fb0b2455c90832159a6a5a25/plugins/caveman/skills/caveman/SKILL.md",
    },
    bundled: true,
    fetchedAt: "2026-09-30T12:00:00.000Z",
  },
];

const plannerFixture = {
  choice: { via: "auto" as const },
  effective: "claude_cli" as const,
  reason: "automatic: the Claude Code CLI",
  options: [
    {
      kind: "claude_cli" as const,
      label: "Claude Code CLI",
      available: true,
      detail: "signed in (claude.ai, max)",
    },
    {
      kind: "codex_cli" as const,
      label: "Codex CLI",
      available: false,
      detail: "installed, not signed in: run codex login where the board runs",
    },
    {
      kind: "api" as const,
      label: "Anthropic API",
      available: false,
      detail: "no ANTHROPIC_API_KEY on the board",
    },
  ],
};

describe("views render with sample data", () => {
  it("Company view shows goals, Peter's drafts, departments, projects, and the live rail", () => {
    const withPeter = render(<CompanyView data={peterFixture} {...companyProps} />);
    // Goals: the live one and the one that needs an answer, with the question and the form.
    expect(withPeter).toContain("Weekly Gong digest to #sales");
    expect(withPeter).toContain("Needs you");
    expect(withPeter).toContain("Which bank accounts are in scope?");
    expect(withPeter).toContain("Answer");
    expect(withPeter).toContain("1 need you");
    // Spend in tokens and money, the cap, and the caps control for a person who may decide.
    expect(withPeter).toContain("413.7k tokens · £1.87 · cap 2.00M");
    expect(withPeter).toContain(">Caps<");
    // Drafts: the org proposal with its toolbox as a recommendation, and the audit's finding.
    expect(withPeter).toContain("Peter proposes");
    expect(withPeter).toContain("Finn · finance analyst · lead");
    expect(withPeter).toContain("Toolbox recommended: xero. Nothing is granted");
    expect(withPeter).toContain("Accept and create");
    expect(withPeter).toContain("nobody whose role reviews it");
    expect(withPeter).toContain("Design from a brief");
    // A viewer sees the drafts but no buttons.
    const viewer = render(<CompanyView data={peterFixture} {...companyProps} canDecide={false} />);
    expect(viewer).not.toContain("Accept and create");
    expect(viewer).not.toContain(">Caps<");
    expect(viewer).not.toContain("Audit the company");
    const html = render(<CompanyView data={fixture} {...companyProps} />);
    expect(html).toContain("Hand Peter a goal");
    expect(html).toContain("New goal");
    expect(html).toContain("GTM Studio");
    expect(html).toContain("2 departments · 5 teammates · 1 working now");
    expect(html).toContain("Engineering");
    expect(html).toContain("Peter · Lead");
    expect(html).toContain("VMS architecture map");
    expect(html).toContain("Happening now");
    expect(html).toContain("Ricky created #144");
  });

  it("Board view has five columns including Blocked, and the drawer for the selected task", () => {
    const html = render(
      <BoardView
        data={fixture}
        projectId="all"
        departmentId="all"
        selectedTaskId={fixture.tasks[2]!.id}
        onFilterProject={noop}
        onFilterDepartment={noop}
        onSelectTask={noop}
        onNewTask={noop}
        onMove={asyncNoop}
        onRefuseDone={noop}
        onOpenReview={noop}
        onAssign={asyncNoop}
        onSetDepartment={asyncNoop}
        loadMessages={async () => []}
        onPostMessage={asyncNoop}
        loadRuns={async () => []}
        loadRun={async () => {
          throw new Error("not in this test");
        }}
        loadArtifacts={async () => []}
        loadArtifact={async () => {
          throw new Error("not in this test");
        }}
        onStartRun={asyncNoop}
        onStopRun={asyncNoop}
      />,
    );
    for (const col of ["To do", "In progress", "Blocked", "In review", "Done"]) expect(html).toContain(col);
    // A few departments are buttons; past three they are a dropdown, so the bar never runs under New task.
    expect(html).not.toContain("All departments");
    const depts = [
      "Growth Analytics & Unit Economics",
      "Lifecycle Email & Retention",
      "Organic Content Engine",
      "Paid Social Creative Lab",
    ];
    const crowded = render(
      <BoardView
        data={{
          ...fixture,
          departments: depts.map((name, i) => ({ ...fixture.departments[0]!, id: `d${i}`, name })),
        }}
        projectId="all"
        departmentId="all"
        selectedTaskId={null}
        onFilterProject={noop}
        onFilterDepartment={noop}
        onSelectTask={noop}
        onNewTask={noop}
        onMove={asyncNoop}
        onRefuseDone={noop}
        onOpenReview={noop}
        onAssign={asyncNoop}
        onSetDepartment={asyncNoop}
        loadMessages={async () => []}
        onPostMessage={asyncNoop}
        loadRuns={async () => []}
        loadRun={async () => {
          throw new Error("not in this test");
        }}
        loadArtifacts={async () => []}
        loadArtifact={async () => {
          throw new Error("not in this test");
        }}
        onStartRun={asyncNoop}
        onStopRun={asyncNoop}
      />,
    );
    expect(crowded).toContain('aria-label="Department"');
    expect(crowded).toContain("All departments");
    expect(crowded).toContain("Paid Social Creative Lab</option>");
    expect(html).toContain("Waiting on @brody");
    expect(html).toContain("#140");
    expect(html).toContain("drawer-title");
    expect(html).toContain("Unblock");
    expect(html).toContain("Cody · n8n engineer");

    // A cancelled task has no column; its drawer says Cancelled and does not offer a move.
    const cancelled = { ...fixture.tasks[2]!, status: "cancelled" as const };
    const drawer = render(
      <BoardView
        data={{ ...fixture, tasks: fixture.tasks.map((t) => (t.id === cancelled.id ? cancelled : t)) }}
        projectId="all"
        departmentId="all"
        selectedTaskId={cancelled.id}
        onFilterProject={noop}
        onFilterDepartment={noop}
        onSelectTask={noop}
        onNewTask={noop}
        onMove={asyncNoop}
        onRefuseDone={noop}
        onOpenReview={noop}
        onAssign={asyncNoop}
        onSetDepartment={asyncNoop}
        loadMessages={async () => []}
        onPostMessage={asyncNoop}
        loadRuns={async () => []}
        loadRun={async () => {
          throw new Error("not in this test");
        }}
        loadArtifacts={async () => []}
        loadArtifact={async () => {
          throw new Error("not in this test");
        }}
        onStartRun={asyncNoop}
        onStopRun={asyncNoop}
      />,
    );
    expect(drawer).toMatch(
      /<select class="select" disabled="">\s*<option value="cancelled" selected="">Cancelled<\/option>/,
    );
  });

  it("Departments view renders cards and the teammate x department matrix", () => {
    const pooled = render(
      <DepartmentsView
        data={fixture}
        onNewDepartment={noop}
        onDissolve={asyncNoop}
        onOpenBoard={noop}
        onCycleCell={asyncNoop}
        onHire={noop}
        onDesign={noop}
      />,
    );
    expect(pooled).toContain("Runs on secure");
    const html = render(
      <DepartmentsView
        data={fixture}
        onNewDepartment={noop}
        onDissolve={asyncNoop}
        onOpenBoard={noop}
        onCycleCell={asyncNoop}
        onHire={noop}
        onDesign={noop}
      />,
    );
    expect(html).toContain("Drafts auto, live writes ask");
    expect(html).toContain("Read only");
    expect(html).toContain("Who sits where");
    expect((html.match(/cellbtn lead/g) ?? []).length).toBe(2);
    expect((html.match(/cellbtn member/g) ?? []).length).toBe(3);
  });

  it("Teammates view renders the roster grouped by department and the editor", () => {
    const html = render(
      <TeammatesView
        data={fixture}
        selectedId={fixture.teammates[1]!.id}
        onSelect={noop}
        onHire={noop}
        onSave={asyncNoop}
        loadInbox={async () => ({ since: null, unread: 0, items: [] })}
      />,
    );
    expect(html).toContain("Cody");
    expect(html).toContain("Handle: @cody");
    expect(html).toContain("senior n8n automation engineer");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Building · Map VMS sub-workflow calls");
    // Effort beside the model: the engine's default unless one is picked.
    expect(html).toContain("Effort");
    for (const [, label] of EFFORT_CHOICES) expect(html).toContain(label);
    expect(EFFORT_CHOICES.map(([v]) => v)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
  });

  it("offers only the engines a worker can run; a teammate already on OpenCode sees it as not available", () => {
    expect(engineChoices("claude_code").map(([id]) => id)).toEqual(["claude_code", "codex", "stub"]);
    expect(engineChoices("opencode").at(-1)).toEqual(["opencode", "OpenCode (not available)"]);
    // A template on OpenCode hires onto Claude Code.
    const hire = render(
      <HireTeammateModal
        templates={[
          {
            id: "t-cody-3",
            companyId: null,
            name: "Cody 3",
            role: "HubSpot analyst",
            personaMd: "You analyse HubSpot data.",
            playbooks: [],
            engine: "opencode",
            model: "claude-sonnet-5-5",
            avatar: "C",
          },
        ]}
        onClose={noop}
        onCreate={asyncNoop}
      />,
    );
    expect(hire).not.toContain("OpenCode");
    expect(hire).toContain('<option value="claude_code" selected="">Claude Code</option>');
    const onOpenCode = { ...fixture.teammates[1]!, engine: "opencode" };
    const editor = render(
      <TeammatesView
        data={{
          ...fixture,
          teammates: fixture.teammates.map((t) => (t.id === onOpenCode.id ? onOpenCode : t)),
        }}
        selectedId={onOpenCode.id}
        onSelect={noop}
        onHire={noop}
        onSave={asyncNoop}
        loadInbox={async () => ({ since: null, unread: 0, items: [] })}
      />,
    );
    expect(editor).toContain("OpenCode (not available)");
  });

  it("Approvals view lists pending cards first with the exact action, and decided ones with their outcome", () => {
    const html = render(
      <ApprovalsView
        data={approvalsFixture}
        canDecide
        onApprove={asyncNoop}
        onReject={asyncNoop}
        onOpenTask={noop}
      />,
    );
    expect(html).toContain("1 waiting");
    expect(html).toContain("Create a HubSpot list");
    expect(html).toContain("hubspot · create_list");
    expect(html).toContain("&quot;processingType&quot;: &quot;MANUAL&quot;");
    expect(html).toContain("Waiting on you");
    expect(html).toContain("Approve and run");
    expect(html).toContain("Reject");
    expect(html).toContain("Ask a question first");
    expect(html).toContain("Cody · n8n engineer · Engineering");
    expect(html).toContain("#144");
    expect(html).toContain("sha256 9f2c4d1a0b7e");
    // The decided card fades and carries the note, which ends the sentence with its own full stop.
    expect(html).toContain("approval decided");
    expect(html).toContain(
      "Not until the first digest is approved. Nothing was sent; Peter re-plans the task.",
    );
    expect(html).not.toContain("approved..");
    const failed = render(
      <ApprovalsView
        data={{
          ...approvalsFixture,
          approvals: [{ ...approvalFixtures[0]!, status: "failed", error: "HubSpot answered HTTP 429." }],
        }}
        canDecide
        onApprove={asyncNoop}
        onReject={asyncNoop}
        onOpenTask={noop}
      />,
    );
    expect(failed).toContain("but the send failed: HubSpot answered HTTP 429.</span>");
    expect(sortApprovals(approvalFixtures)[0]!.status).toBe("pending");
    expect(APPROVAL_LABEL.executed).toBe("Approved · executed");
    // A replaced proposal fades, says what replaced it, and offers no decision.
    const replaced = render(
      <ApprovalsView
        data={{
          ...approvalsFixture,
          approvals: [
            {
              ...approvalFixtures[0]!,
              status: "superseded",
              target: "published/positioning.md",
              supersededBy: "a2",
            },
          ],
        }}
        canDecide
        onApprove={asyncNoop}
        onReject={asyncNoop}
        onOpenTask={noop}
      />,
    );
    expect(replaced).toContain("Replaced");
    expect(replaced).toContain(
      "Replaced by a newer proposal of the same write (published/positioning.md) before anyone decided it.",
    );
    expect(replaced).not.toContain("Approve and run");
    // A viewer sees the queue and no buttons.
    const viewer = render(
      <ApprovalsView
        data={approvalsFixture}
        canDecide={false}
        onApprove={asyncNoop}
        onReject={asyncNoop}
        onOpenTask={noop}
      />,
    );
    expect(viewer).not.toContain("Approve and run");
    expect(viewer).toContain("An owner or admin decides this.");
    const empty = render(
      <ApprovalsView data={fixture} canDecide onApprove={asyncNoop} onReject={asyncNoop} onOpenTask={noop} />,
    );
    expect(empty).toContain("Nothing waits for you");
  });

  it("a rejected write's card says who takes the task from there, and claims no re-plan that will not come", () => {
    const card = (afterRejection: Approval["afterRejection"]) =>
      render(
        <ApprovalsView
          data={{ ...approvalsFixture, approvals: [{ ...approvalFixtures[1]!, afterRejection }] }}
          canDecide
          onApprove={asyncNoop}
          onReject={asyncNoop}
          onOpenTask={noop}
        />,
      );
    // A teammate's task: its manager re-plans it on his next pass, and then has.
    expect(card({ kind: "replan", by: "Peter" })).toContain(
      "Not until the first digest is approved. Nothing was sent; Peter re-plans the task.",
    );
    expect(card({ kind: "replanned", by: "Lena" })).toContain("Nothing was sent; Lena re-planned the task.");
    // A person's task waits for them; one nobody picks up says what a person can do with it.
    const dana = card({ kind: "person", name: "Dana" });
    expect(dana).toContain("Nothing was sent; the task waits with the rejection for Dana.");
    expect(dana).not.toContain("re-plan");
    const nobody = card({ kind: "person", name: null });
    expect(nobody).toContain(
      "Nothing was sent; the task waits with the rejection for a person to start it again with a note, reassign it or cancel it.",
    );
    expect(nobody).not.toContain("re-plan");
    expect(card({ kind: "proposal" })).toContain(
      "Nothing was sent; the task still waits on another proposal.",
    );
    // A task that moved on another way (started again, cancelled) is not promised anything.
    expect(card(null)).toContain("Not until the first digest is approved. Nothing was sent.</span>");
    // The toast says the same after "Rejected."
    expect(afterRejectionText({ kind: "person", name: "Dana" })).toBe(
      "Nothing was sent; the task waits with the rejection for Dana.",
    );
  });

  it("Connections panel lists connections with credential names, tools by classification, and the add forms", () => {
    const catalog = [
      {
        id: "hubspot",
        name: "HubSpot",
        description: "CRM",
        category: "CRM",
        kind: "mcp" as const,
        transport: "http" as const,
        urlExample: "https://mcp.hubspot.com/mcp",
        authEnvExample: "HUBSPOT_MCP_TOKEN",
        reads: [],
        writes: [],
      },
    ];
    const props = {
      connections: connectionFixtures,
      loadCatalog: async () => catalog,
      createConnection: async () => connectionFixtures[0]!,
      previewOpenApi: async () => ({ operations: [], errors: [] }),
      createOpenApiConnection: async () => connectionFixtures[1]!,
      updateConnection: async () => connectionFixtures[0]!,
      discoverConnection: async () => connectionFixtures[0]!,
      checkConnection: async () => connectionFixtures[0]!,
      deleteConnection: asyncNoop,
      startOAuth: async () => ({ url: "https://auth.example.test/authorize" }),
      initialCatalog: catalog,
    };
    const html = render(<ConnectionsPanel {...props} canEdit />);
    // Without a secret store the form offers no OAuth; with one, it does, and an OAuth connection shows its state.
    expect(html).not.toContain("Authorise by OAuth");
    const offered = render(
      <ConnectionsPanel
        {...props}
        features={{ oauth: true, objectStore: false }}
        connections={[
          {
            ...connectionFixtures[0]!,
            authEnvName: null,
            oauth: {
              authorizationServer: null,
              clientId: null,
              registered: false,
              scopes: [],
              authorizedAt: null,
            },
          },
          {
            ...connectionFixtures[0]!,
            id: "c-authorised",
            name: "gong",
            authEnvName: null,
            oauth: {
              authorizationServer: "https://auth.example.test",
              clientId: "client-1",
              clientSecretEnvName: "GONG_OAUTH_CLIENT_SECRET",
              registered: false,
              scopes: ["crm.read"],
              authorizedAt: "2026-09-12T04:00:00.000Z",
            },
          },
        ]}
        canEdit
      />,
    );
    expect(offered).toContain("Authorise by OAuth");
    expect(offered).toContain("OAuth · not authorised yet");
    expect(offered).toContain("OAuth · authorised");
    // A pre-registered client's secret shows by name only.
    expect(offered).toContain("secret by name: GONG_OAUTH_CLIENT_SECRET");
    expect(offered).not.toMatch(/client-secret-|given-secret/);
    expect(offered).toContain("Authorise again");
    // Secrets set from here: only with a store and the loader; the section, its form and the names, never a value.
    expect(html).not.toContain("Set value");
    expect(offered).not.toContain("Set value");
    const withSecrets = render(
      <ConnectionsPanel
        {...props}
        features={{ oauth: true, objectStore: false }}
        loadSecrets={async () => []}
        setSecret={async (name) => ({
          name,
          updatedAt: "2026-09-13T00:00:00.000Z",
          updatedBy: { kind: "user", id: "u1" },
        })}
        deleteSecret={asyncNoop}
        canEdit
      />,
    );
    expect(withSecrets).toContain("Secrets");
    expect(withSecrets).toContain("Set value");
    expect(withSecrets).toContain("never shown again");
    expect(withSecrets).toContain("No values set here yet");
    expect(html).toContain("hubspot");
    expect(html).toContain("HUBSPOT_MCP_TOKEN");
    expect(html).toContain("MCP · http · https://mcp.hubspot.example/mcp · 2 reads, 1 write");
    expect(html).toContain("OpenAPI · https://crm.example.test/v1 · 1 read, 1 write");
    expect(html).toContain("Discover");
    expect(html).toContain("Switch off");
    expect(html).toContain("Switch on");
    expect(html).toContain("HubSpot · CRM");
    expect(html).toContain("Add connection");
    expect(html).toContain("OpenAPI service");
    expect(html).not.toMatch(/xox[a-z]-|sk-live/);
    expect(connectionSummary(connectionFixtures[0]!)).toContain("discovered");
    const viewer = render(<ConnectionsPanel {...props} canEdit={false} />);
    expect(viewer).not.toContain("Add connection");
    expect(viewer).not.toContain("Discover");
    // A tool a person switched off counts as neither read nor write. (The chips with their switches sit
    // behind the card's expand click, out of a string render's reach.)
    const withOff = {
      ...connectionFixtures[0]!,
      tools: [
        ...connectionFixtures[0]!.tools,
        { name: "run_report", description: "", write: true as const, source: "default" as const, off: true },
      ],
    };
    expect(connectionSummary(withOff)).toContain("2 reads, 1 write, 1 off");
    expect(render(<ConnectionsPanel {...props} connections={[withOff]} canEdit />)).toContain(
      "2 reads, 1 write, 1 off",
    );
    // A connector that authorises by OAuth only, on a board without a secret store, says so instead of asking for a token.
    const notion = [
      {
        id: "notion",
        name: "Notion",
        description: "Pages",
        category: "Knowledge",
        kind: "mcp" as const,
        transport: "http" as const,
        urlExample: "https://mcp.notion.com/mcp",
        auth: "oauth" as const,
        reads: [],
        writes: [],
      },
    ];
    const withNotion = render(<ConnectionsPanel {...props} initialCatalog={notion} canEdit />);
    expect(withNotion).toContain("Notion · Knowledge");
    expect(withNotion).not.toContain("authorises by OAuth only");
    // A catalog entry that runs a command says whether this board runs any.
    const xero = [
      {
        id: "xero",
        name: "Xero",
        description: "Accounting",
        category: "Finance",
        kind: "mcp" as const,
        transport: "stdio" as const,
        commandExample: "npx -y @xeroapi/xero-mcp-server",
        reads: [],
        writes: [],
      },
    ];
    const none = { oauth: false, objectStore: false, stdioCommands: [] };
    expect(render(<ConnectionsPanel {...props} initialCatalog={xero} features={none} canEdit />)).toContain(
      "Xero · Finance · this board runs no commands",
    );
    const some = { ...none, stdioCommands: ["npx -y @xeroapi/xero-mcp-server@1.0.0"] };
    expect(render(<ConnectionsPanel {...props} initialCatalog={xero} features={some} canEdit />)).toContain(
      "Xero · Finance · its command must be one the operator allows",
    );
    const listed = { ...none, stdioCommands: ["npx -y @xeroapi/xero-mcp-server *"] };
    expect(render(<ConnectionsPanel {...props} initialCatalog={xero} features={listed} canEdit />)).toContain(
      "Xero · Finance · runs on this board",
    );
    // What the board runs: the same line, or its start before a final *.
    const lines = [
      "npx -y @xeroapi/xero-mcp-server@1.0.0",
      "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 *",
    ];
    expect(stdioListed(lines, " npx  -y @xeroapi/xero-mcp-server@1.0.0 ")).toBe(true);
    expect(stdioListed(lines, "npx -y @xeroapi/xero-mcp-server")).toBe(false);
    expect(stdioListed(lines, "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 /srv/drive")).toBe(
      true,
    );
    expect(stdioListed(lines, "sh -c env")).toBe(false);
    expect(stdioListed([], "npx -y @xeroapi/xero-mcp-server@1.0.0")).toBe(false);

    // A catalog server usually run on a private address says the operator must allow it, unless they do.
    const playwright = [
      {
        id: "playwright",
        name: "Playwright browser",
        description: "A real browser",
        category: "Web",
        kind: "mcp" as const,
        transport: "http" as const,
        urlExample: "http://playwright-mcp:8931/mcp",
        reads: [],
        writes: [],
      },
    ];
    const nothing = { ...none, privateDestinations: [] };
    expect(
      render(<ConnectionsPanel {...props} initialCatalog={playwright} features={nothing} canEdit />),
    ).toContain("Playwright browser · Web · usually on a private address, which the operator must allow");
    // The operator's list shows to the people who manage connections, the company's own entries marked.
    const own = {
      ...none,
      privateDestinations: ["10.20.0.0/16", "ollama.internal"],
      companyPrivateDestinations: ["ollama.internal"],
    };
    const intro = render(
      <ConnectionsPanel {...props} features={own} companyId="4f1aee73-e65e-4c8d-83f7-aa1169379d7f" canEdit />,
    );
    expect(intro).toContain(
      "of private ones only those this board&#x27;s operator lists: 10.20.0.0/16 · ollama.internal (this company only).",
    );
    expect(intro).toContain("for this company alone by its id, 4f1aee73-e65e-4c8d-83f7-aa1169379d7f.");
    const allowed = { ...none, privateDestinations: ["playwright-mcp"] };
    expect(
      render(<ConnectionsPanel {...props} initialCatalog={playwright} features={allowed} canEdit />),
    ).not.toContain("which the operator must allow");
  });

  it("says before the board's check does what it refuses, by the board's own rules", () => {
    const listed = [
      "*.tools.svc.cluster.local",
      "10.20.0.0/16",
      "127.0.0.1",
      "ollama.internal.",
      "[::1]",
      "fd00::/8",
      "::ffff:192.168.7.0/120",
    ];
    // An address the board refuses, whatever form the URL writes it in.
    for (const url of [
      "http://169.254.169.254/latest",
      "http://10.21.0.1/mcp",
      "http://127.0.0.2/mcp",
      "http://[fc00::1]/mcp",
      "http://[::ffff:169.254.169.254]/latest",
      "http://[64:ff9b::a9fe:a9fe]/latest",
      "http://[2002:a9fe:a9fe::1]/",
      "http://0x7f.0.0.2/",
      "http://2130706434/",
      "http://198.18.0.1/",
      "http://[fe80::1]/",
    ])
      expect(privateFlag(url, listed), url).toBe("refused");
    // A name that looks private and no entry names: refused only if it resolves outside the listed ranges.
    for (const url of [
      "http://localhost:3001/mcp",
      "http://playwright-mcp:8931/mcp",
      "https://n8n.office.lan/mcp",
      "http://other.ns.svc.cluster.local/mcp",
      "http://tools.svc.cluster.local/mcp",
    ])
      expect(privateFlag(url, listed), url).toBe("unless-listed");
    // Public, or listed: nothing to say.
    for (const url of [
      "https://mcp.hubspot.com/mcp",
      "http://8.8.8.8/",
      "http://playwright.tools.svc.cluster.local:8931/mcp",
      "http://ollama.internal:11434/",
      "http://ollama.internal.:11434/",
      "http://10.20.3.4/mcp",
      "http://127.0.0.1:3001/mcp",
      "http://[::1]:3001/mcp",
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[fd12::5]/mcp",
      "http://[::ffff:10.20.0.9]/",
      "http://192.168.7.9/",
      "not a url",
      "",
    ])
      expect(privateFlag(url, listed), url).toBeNull();
    // Nothing listed: every private address is refused.
    expect(privateFlag("http://127.0.0.1:3001/", [])).toBe("refused");
  });

  it("opens only a web page as a connection's consent page", () => {
    expect(consentUrl("https://auth.example.test/authorize?state=1")).toBe(
      "https://auth.example.test/authorize?state=1",
    );
    expect(consentUrl("http://localhost:9000/authorize")).toBe("http://localhost:9000/authorize");
    for (const url of [
      "javascript:alert(document.domain)//?x=1",
      "data:text/html,hi",
      "JAVASCRIPT:alert(1)",
      " ",
      "/relative",
    ])
      expect(() => consentUrl(url), url).toThrow("not a web page");
  });

  it("tools only the server calls read-only are listed on their connection for a person to confirm as reads", () => {
    const props = {
      connections: connectionFixtures,
      loadCatalog: async () => [],
      createConnection: async () => connectionFixtures[0]!,
      previewOpenApi: async () => ({ operations: [], errors: [] }),
      createOpenApiConnection: async () => connectionFixtures[1]!,
      updateConnection: async () => connectionFixtures[0]!,
      discoverConnection: async () => connectionFixtures[0]!,
      checkConnection: async () => connectionFixtures[0]!,
      deleteConnection: asyncNoop,
      startOAuth: async () => ({ url: "https://auth.example.test/authorize" }),
      initialCatalog: [],
    };
    const html = render(<ConnectionsPanel {...props} canEdit />);
    // Tools only the server calls read-only are writes until a person confirms them: listed on the card, each
    // with its confirmation, and all at once; a viewer sees them and who confirms. One switched off waits for nothing.
    expect(html).not.toContain("Confirm as read");
    const held = (name: string, more: { off?: boolean } = {}) => ({
      name,
      description: `${name} on GitHub`,
      write: true,
      source: "unconfirmed" as const,
      ...more,
    });
    const github = {
      ...connectionFixtures[0]!,
      id: "c-github",
      name: "github",
      tools: [
        { name: "list_issues", description: "", write: false, source: "annotation" as const },
        held("issue_read"),
        held("pull_request_read"),
        held("projects_get", { off: true }),
        { name: "label_read", description: "", write: false, source: "person" as const },
      ],
    };
    expect(heldReads(github).map((t) => t.name)).toEqual(["issue_read", "pull_request_read"]);
    expect(confirmAsRead(["issue_read", "pull_request_read"])).toEqual({
      tools: [
        { name: "issue_read", write: false },
        { name: "pull_request_read", write: false },
      ],
    });
    const holding = render(<ConnectionsPanel {...props} connections={[github]} canEdit />);
    expect(holding).toContain("github says these 2 tools only read.");
    expect(holding).toContain("waits for approval as a write until you confirm it reads");
    expect(holding).toContain('aria-label="Confirm issue_read as read"');
    expect(holding).toContain('aria-label="Confirm pull_request_read as read"');
    expect(holding).not.toContain('aria-label="Confirm projects_get as read"');
    expect(holding).toContain("Confirm all 2 as reads");
    const watching = render(<ConnectionsPanel {...props} connections={[github]} canEdit={false} />);
    expect(watching).toContain("pull_request_read");
    expect(watching).toContain("until an owner or admin confirms it reads");
    expect(watching).not.toContain("Confirm as read");
    expect(watching).not.toContain("Confirm all");
    const single = render(
      <ConnectionsPanel {...props} connections={[{ ...github, tools: [held("issue_read")] }]} canEdit />,
    );
    expect(single).toContain("github says this tool only reads.");
    expect(single).not.toContain("Confirm all");
  });

  it("a refused body names the field and why, so a form can say more than that it was refused", () => {
    expect(
      messageWithIssues("invalid request body", [
        { path: ["name"], message: "lowercase letters, digits and dashes", code: "invalid_string" },
        { path: [], message: "a credential by name or OAuth, not both" },
      ]),
    ).toBe(
      "invalid request body: name: lowercase letters, digits and dashes; a credential by name or OAuth, not both",
    );
    expect(messageWithIssues("not found", undefined)).toBe("not found");
    expect(messageWithIssues("refused", ["opaque"])).toBe("refused");
  });

  it("Client policies panel is a project by connection matrix of caps that only narrow", () => {
    const html = render(
      <ClientPoliciesPanel data={connectionsFixture} canEdit saveClientPolicy={asyncNoop} />,
    );
    expect(html).toContain("Client policies");
    expect(html).toContain("VMS architecture map");
    expect(html).toContain("hubspot");
    expect(html).toContain("crm");
    expect(html).toContain("As granted");
    expect(html).toContain("Clear every cap");
    expect(capFor(connectionsFixture.projects[0]!.clientPolicy, "crm")).toBe("off");
    expect(capFor(connectionsFixture.projects[0]!.clientPolicy, "hubspot")).toBe("");
    const empty = render(<ClientPoliciesPanel data={fixture} canEdit saveClientPolicy={asyncNoop} />);
    expect(empty).toContain("Add a connection first.");
  });

  it("Teammates editor grants connections with a mode each and says policy only narrows", () => {
    const cody = connectionsFixture.teammates.find((t) => t.handle === "cody")!;
    const html = render(
      <TeammatesView
        data={connectionsFixture}
        selectedId={cody.id}
        onSelect={noop}
        onHire={noop}
        onSave={asyncNoop}
        loadInbox={async () => ({ since: null, unread: 0, items: [] })}
      />,
    );
    expect(html).toContain("Toolbox");
    expect(html).toContain("hubspot");
    expect(html).toContain("crm");
    expect(html).toContain("writes need approval");
    // Tools grouped like a permissions page: reads under one header, writes under another, a control each.
    expect(html).toContain("Read-only tools");
    expect(html).toContain("Write tools");
    expect(html).toContain("Always allow");
    expect(html).toContain("Needs approval");
    expect(html).toContain("search_crm_objects: always allow");
    expect(html).toContain("reads allowed");
    expect(html).toContain("switched off in Settings");
    expect(html).toContain("This is the ceiling.");
    expect(html).not.toContain('<option value="auto"');
  });

  it("Activity view lists events as sentences", () => {
    const html = render(<ActivityView data={fixture} onOpen={noop} />);
    expect(html).toContain("#140 is blocked: Waiting on @brody");
    expect(html).toContain("Daniel created the company GTM Studio");
  });

  it("Shell renders the company switcher and navigation with Blocked-aware board", () => {
    const html = render(
      <Shell
        companies={[fixture.company]}
        company={fixture.company}
        view="board"
        counts={{ reviews: 0, approvals: 2 }}
        userName="Daniel"
        userRole="owner"
        onNavigate={noop}
        onSelectCompany={noop}
        onCreateCompany={noop}
        onToggleTheme={noop}
        onSignOut={noop}
      >
        <div>content</div>
      </Shell>,
    );
    for (const item of [
      "Company",
      "Board",
      "Reviews",
      "Approvals",
      "Activity",
      "Office",
      "Costs",
      "Departments",
      "Teammates",
      "Settings",
    ])
      expect(html).toContain(item);
    expect(html).toContain("badge warn");
  });

  it("the signed-in person's avatar carries their own initials", () => {
    expect(render(<Avatar name="Alex Morgan" you />)).toContain('aria-hidden="true">AM</span>');
    expect(render(<Avatar name="Alex" you />)).toContain('aria-hidden="true">A</span>');
  });

  it("Reviews view lists the queue, and one review with files, numbered hunks, threads and checks", () => {
    const data = { ...fixture, reviews: reviewListFixture };
    const base = {
      data,
      meId: fixture.members[0]!.userId,
      role: "owner" as const,
      onSelect: noop,
      loadReview: async () => reviewFixture,
      onComment: asyncNoop,
      onResolve: asyncNoop,
      onScore: asyncNoop,
      onApprove: asyncNoop,
      onRequestChanges: asyncNoop,
      onVeto: asyncNoop,
      onAssignReviewer: asyncNoop,
      onOpenTask: noop,
    };
    const queue = render(<ReviewsView {...base} selectedId={null} />);
    expect(queue).toContain("1 waiting");
    expect(queue).toContain("#146");
    expect(queue).toContain("Requirements: Slack digest format and schedule");
    expect(queue).toContain("Brody");
    expect(queue).toContain("Verifier");
    expect(queue).toContain("1 open");
    expect(queue).toContain("In review");

    const detail = render(<ReviewsView {...base} selectedId={reviewFixture.id} initial={reviewFixture} />);
    // The task's title gives way to the rest of the bar, whole on hover; the people can drop to faces.
    expect(detail).toContain('class="topbar long"');
    expect(detail).toContain(`<span class="title" title="${reviewFixture.taskTitle}">`);
    expect(detail).toContain('class="name">Brody</span>');
    expect(render(<Topbar title="Reviews" />)).toContain('<span class="title">Reviews</span>');
    expect(detail).toContain("2 files");
    expect(detail).toContain("workflows/vms-digest.json");
    expect(detail).toContain("docs/digest-requirements.md");
    expect(detail).toContain("@@ -12,7 +12,9 @@");
    expect(detail).toContain("&quot;executionOrder&quot;: &quot;v1&quot;");
    expect((detail.match(/class="ln add/g) ?? []).length).toBe(3);
    expect((detail.match(/class="ln del/g) ?? []).length).toBe(1);
    expect(detail).toContain("ln add flag");
    expect(detail).toContain("cthread");
    expect(detail).toContain("activation is approval-gated");
    expect(detail).toContain("Unified");
    expect(detail).toContain("Split");
    // Side by side: the deletion and the first addition share a row, the other additions face a blank.
    const hunk = reviewFixture.files[0]!.hunks[0]!;
    const rows = splitRows(hunk);
    expect(rows.length).toBe(hunk.lines.filter((l) => l.kind !== "add").length + 2);
    const paired = rows.find((r) => r.left?.kind === "del")!;
    expect(paired.right?.kind).toBe("add");
    expect(rows.filter((r) => r.left === null && r.right?.kind === "add")).toHaveLength(2);
    const split = render(
      <ReviewsView {...base} selectedId={reviewFixture.id} initial={reviewFixture} initialLayout="split" />,
    );
    expect((split.match(/class="ln split/g) ?? []).length).toBe(rows.length);
    expect((split.match(/class="side add"/g) ?? []).length).toBe(3);
    expect((split.match(/class="side del"/g) ?? []).length).toBe(1);
    expect(split).toContain("&quot;executionOrder&quot;: &quot;v1&quot;");
    expect(detail).toContain("No credential values in the diff");
    expect(detail).toContain("1 open comment");
    expect(detail).toContain("Acceptance criteria");
    expect(detail).toContain("Workflow imports as draft");
    expect(detail).toContain("Save scores");
    expect(detail).toContain("Approve");
    expect(detail).toContain("Request changes");
    expect(detail).toContain("Reviewing");
    expect(detail).toContain("Approving marks #146 Done");
    // The reviewer picker: teammates except the author, people who may decide, you, or nobody.
    expect(detail).toContain('aria-label="Reviewer"');
    expect(detail).toContain('value="teammate:' + fixture.teammates[2]!.id + '"');
    expect(detail).not.toContain('value="teammate:' + reviewFixture.author.id + '"');
    expect(detail).toContain("Nobody assigned; people decide");
    expect(detail).not.toContain("Veto approval");

    // A viewer sees no decision buttons enabled and cannot score.
    const viewer = render(
      <ReviewsView {...base} role="viewer" selectedId={reviewFixture.id} initial={reviewFixture} />,
    );
    expect(viewer).toContain("Read only");
    expect(viewer).not.toContain("Save scores");

    // Approved: the pull request note and the veto for owners.
    const approved: typeof reviewFixture = {
      ...reviewFixture,
      status: "approved",
      taskStatus: "done",
      decisions: [
        {
          id: "d1",
          round: 1,
          by: { kind: "teammate", id: fixture.teammates[2]!.id, name: "Verifier" },
          decision: "approve",
          note: null,
          createdAt: "2026-09-12T04:00:00.000Z",
        },
      ],
      pullRequests: [
        {
          id: "pr1",
          reviewId: reviewFixture.id,
          provider: "github",
          repo: "acme/gtm-automations",
          baseBranch: "main",
          headBranch: "rosterdock/task-146",
          payloadSha256: "cd".repeat(32),
          status: "opened",
          number: 42,
          url: "https://github.com/acme/gtm-automations/pull/42",
          error: null,
          createdAt: "2026-09-12T04:00:00.000Z",
          executedAt: "2026-09-12T04:00:01.000Z",
        },
      ],
    };
    const done = render(<ReviewsView {...base} selectedId={approved.id} initial={approved} />);
    expect(done).toContain("Approved");
    expect(done).toContain("Veto approval");
    expect(done).toContain("#42");
    expect(done).toContain("rosterdock/task-146");
    expect(done).not.toContain("Request changes");

    expect(REVIEW_LABEL.changes_requested).toBe("Changes requested");
    const sorted = sortReviews([
      { ...reviewListFixture[0]!, id: "a", status: "approved" },
      { ...reviewListFixture[0]!, id: "b", status: "open" },
      { ...reviewListFixture[0]!, id: "c", status: "changes_requested" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("Board cards say who is reviewing, and the office draws the review handoff", () => {
    const data = { ...fixture, reviews: reviewListFixture };
    const html = render(
      <BoardView
        data={data}
        projectId="all"
        departmentId="all"
        selectedTaskId={null}
        onFilterProject={noop}
        onFilterDepartment={noop}
        onSelectTask={noop}
        onNewTask={noop}
        onMove={asyncNoop}
        onRefuseDone={noop}
        onOpenReview={noop}
        onAssign={asyncNoop}
        onSetDepartment={asyncNoop}
        loadMessages={async () => []}
        onPostMessage={asyncNoop}
        loadRuns={async () => []}
        loadRun={async () => {
          throw new Error("not in this test");
        }}
        loadArtifacts={async () => []}
        loadArtifact={async () => {
          throw new Error("not in this test");
        }}
        onStartRun={asyncNoop}
        onStopRun={asyncNoop}
      />,
    );
    expect(html).toContain("Verifier reviewing");
    const edges = officeInteractions(data, []);
    const review = edges.find((e) => e.kind === "review")!;
    expect(review).toMatchObject({ from: fixture.teammates[4]!.id, to: fixture.teammates[2]!.id });
    expect(review.label).toBe("Verifier reviewing Brody · #146");
  });

  it("goal cards derive progress and tone from the board", () => {
    const active = peterFixture.goals[0]!;
    const p = goalProgress(active, peterFixture.tasks);
    expect(p.total).toBeGreaterThan(0);
    expect(goalTone(active, p.tasks)).toBe(p.working ? "ok" : "info");
    expect(goalTone(peterFixture.goals[1]!, [])).toBe("warn");
    expect(goalTone({ ...active, status: "done" }, [])).toBe("muted");
    // Cancelled tasks leave the total and are counted apart.
    const mine = peterFixture.tasks.filter((t) => t.goalId === active.id);
    const q = goalProgress(
      active,
      mine.map((t, i) => (i === 0 ? { ...t, status: "cancelled" as const } : t)),
    );
    expect(q).toMatchObject({ total: p.total - 1, cancelled: 1 });
  });

  it("a goal's result: what it delivered, whether the live copy is the approved one, and all of it at once", () => {
    const file = (path: string, n: number) => ({
      artifactId: `a${n}`,
      runId: `r${n}`,
      path,
      bytes: 20_353,
      sha256: `s${n}`,
      binary: false,
    });
    const published = {
      connection: "drive",
      tool: "write_file",
      target: "published/positioning-vs-alternatives.md",
      approvalId: "ap1",
      title: "Publish positioning-vs-alternatives.md",
      number: 31,
      executedAt: "2026-09-30T14:37:18.000Z",
      now: null,
      content: { sha256: "other", chars: 16_000 },
      matchesDelivered: { number: 31, path: "positioning-vs-alternatives.md", same: false },
    };
    const result = {
      goalId: "g1",
      title: "RosterDock competitive map",
      status: "done" as const,
      delivered: [
        {
          taskId: "t31",
          number: 31,
          title: "Write the positioning",
          files: [file("positioning-vs-alternatives.md", 31)],
        },
      ],
      supporting: [
        { taskId: "t27", number: 27, title: "Shortlist", files: [file("alternatives-shortlist.md", 27)] },
      ],
      published: [published],
    };
    const access = {
      load: async () => result,
      loadArtifact: async () => {
        throw new Error("not in this test");
      },
      zipUrl: (g: string) => `/api/companies/c1/goals/${g}/result.zip`,
      downloadUrl: (r: string, a: string) => `/api/companies/c1/runs/${r}/artifacts/${a}/download`,
    };
    const html = render(<GoalResultPanel goalId="g1" access={access} initial={result} />);
    expect(html).toContain("What it delivered");
    expect(html).toContain("#31 Write the positioning");
    expect(html).toContain("positioning-vs-alternatives.md");
    expect(html).toContain("20 KB");
    expect(html).toContain('href="/api/companies/c1/runs/r31/artifacts/a31/download"');
    expect(html).toContain("drive · published/positioning-vs-alternatives.md");
    expect(html).toContain("Not the approved file");
    expect(html).toContain(
      "It differs from #31&#x27;s positioning-vs-alternatives.md, the file review approved.",
    );
    expect(html).toContain("Show the work on the way (1 task)");
    expect(html).not.toContain("alternatives-shortlist.md");
    expect(html).toContain('href="/api/companies/c1/goals/g1/result.zip"');
    expect(html).toContain("Download all (2 files)");
    // Written again since, with the approved text: it says who wrote it and that it is the approved file.
    const fixed = {
      ...published,
      now: { approvalId: "ap2", title: "Republish", number: 32, executedAt: "2026-09-30T16:00:00.000Z" },
      matchesDelivered: { ...published.matchesDelivered, same: true },
    };
    expect(publishedVerdict(fixed)).toEqual({
      tone: "ok",
      label: "The approved file",
      hint: "It is #31's positioning-vs-alternatives.md, as review approved it.",
    });
    expect(
      render(<GoalResultPanel goalId="g1" access={access} initial={{ ...result, published: [fixed] }} />),
    ).toContain("then by #32 (Republish)");
    expect(publishedVerdict({ ...published, matchesDelivered: null })).toBeNull();
  });

  it("Peter's modals render: a goal for Peter, a brief for the architect", () => {
    const goal = render(
      <NewGoalModal
        data={fixture}
        onClose={noop}
        onCreate={async () => {
          throw new Error("not in this test");
        }}
        onAnswer={async () => {
          throw new Error("not in this test");
        }}
        onOpenBoard={noop}
      />,
    );
    expect(goal).toContain("Tell Peter what you want done");
    expect(goal).toContain("Let Peter route it");
    expect(goal).toContain("Hand to Peter");
    const design = render(<DesignCompanyModal onClose={noop} onSubmit={asyncNoop} />);
    expect(design).toContain("Design from a brief");
    expect(design).toContain("He grants nothing himself");
    expect(design).toContain("Ask Peter");
    // While Peter's model works (minutes over a whole company), a spinner says what he is doing and for how long.
    const thinking = render(<Thinking>Peter is designing departments…</Thinking>);
    expect(thinking).toContain('class="spin"');
    expect(thinking).toContain("Peter is designing departments…");
    expect(thinking).toContain("0:00");
    expect(elapsedLabel(7_400)).toBe("0:07");
    expect(elapsedLabel(161_000)).toBe("2:41");
    expect(elapsedLabel(-5)).toBe("0:00");
  });

  it("modals render", () => {
    expect(render(<CreateDepartmentModal data={fixture} onClose={noop} onCreate={asyncNoop} />)).toContain(
      "Engineering cell",
    );
    expect(render(<CreateTaskModal data={fixture} onClose={noop} onCreate={asyncNoop} />)).toContain(
      "VMS architecture map",
    );
  });
});

describe("the web connection", () => {
  const web = {
    ...connectionFixtures[0]!,
    id: "c-web",
    name: "web",
    catalogId: null,
    kind: "web" as const,
    url: null,
    authEnvName: null,
    tools: [
      { name: "fetch", description: "Read a public web page", write: false, source: "catalog" as const },
    ],
    manifest: { domains: ["gong.io"] },
    discoveredAt: null,
    lastCheck: null,
  };
  const props = {
    loadCatalog: async () => [],
    createConnection: async () => web,
    previewOpenApi: async () => ({ operations: [], errors: [] }),
    createOpenApiConnection: async () => web,
    updateConnection: async () => web,
    discoverConnection: async () => web,
    checkConnection: async () => web,
    deleteConnection: asyncNoop,
    startOAuth: async () => ({ url: "https://auth.example.test/authorize" }),
    initialCatalog: [],
  };

  it("reads a typed list of sites, and the company's list off the connection", () => {
    expect(parseDomains(" Gong.io, https://developers.hubspot.com/docs\n*.example.org gong.io ")).toEqual({
      domains: ["gong.io", "developers.hubspot.com", "example.org"],
      bad: null,
    });
    expect(parseDomains("gong.io, localhost")).toEqual({ domains: ["gong.io"], bad: "localhost" });
    expect(parseDomains("")).toEqual({ domains: [], bad: null });
    expect(domainsText(["gong.io", "hubspot.com"])).toBe("gong.io, hubspot.com");
    expect(domainsText(null)).toBe("");
    expect(webDomainsOf(web)).toEqual(["gong.io"]);
    expect(webDomainsOf({ manifest: { domains: [] } })).toBeNull();
    expect(webDomainsOf({ manifest: null })).toBeNull();
  });

  it("shows on its card what it reads, with no credential and nothing to discover, and when the board is off the web", () => {
    expect(connectionSummary(web)).toBe(
      "Web · the board's own fetch · reads only gong.io and the sites under it",
    );
    expect(connectionSummary({ ...web, manifest: { domains: null } })).toBe(
      "Web · the board's own fetch · reads any public site",
    );
    const html = render(<ConnectionsPanel {...props} connections={[web]} canEdit />);
    expect(html).toContain("Web · the board&#x27;s own fetch");
    expect(html).toContain("Sites");
    expect(html).toContain('aria-label="web sites"');
    expect(html).toContain('value="gong.io"');
    expect(html).not.toContain("Discover");
    expect(html).not.toContain("no credential");
    expect(html).toContain("Web, built in");
    const offline = render(
      <ConnectionsPanel
        {...props}
        connections={[web]}
        features={{ oauth: false, objectStore: false, web: false }}
        canEdit
      />,
    );
    expect(offline).toContain("operator keeps it off the web: it reads no page");
    const viewer = render(<ConnectionsPanel {...props} connections={[web]} canEdit={false} />);
    expect(viewer).toContain("only gong.io and the sites under it");
    expect(viewer).not.toContain('aria-label="web sites"');
  });

  it("is added once: the form asks a name and the sites, and says when the company has it", () => {
    const fresh = render(<AddWebForm existing={undefined} offline={false} onCreate={async () => true} />);
    expect(fresh).toContain("Add the web connection");
    expect(fresh).toContain('value="web"');
    expect(fresh).toContain("empty for any public site");
    expect(fresh).toContain("never what it says");
    const had = render(<AddWebForm existing={web} offline onCreate={async () => true} />);
    expect(had).toContain("This company has its web connection: web.");
    expect(had).not.toContain("Add the web connection");
    expect(had).toContain("keeps it off the web");
  });

  it("client policies and departments narrow its sites; the toolbox says what it reads", () => {
    const data: CompanyData = { ...connectionsFixture, connections: [...connectionFixtures, web] };
    const policies = render(<ClientPoliciesPanel data={data} canEdit saveClientPolicy={asyncNoop} />);
    expect(policies).toContain("Web sites");
    expect(policies).toContain("narrows what web may read for that client");
    expect(
      render(<ClientPoliciesPanel data={connectionsFixture} canEdit saveClientPolicy={asyncNoop} />),
    ).not.toContain("Web sites");
    const policy = { default: null, caps: {} };
    expect(withWebDomains(policy, ["gong.io"])).toEqual({ default: null, caps: {}, webDomains: ["gong.io"] });
    expect(withWebDomains({ ...policy, webDomains: ["gong.io"] }, [])).toEqual(policy);
    expect(policyNarrows(policy)).toBe(false);
    expect(policyNarrows({ ...policy, webDomains: ["gong.io"] })).toBe(true);
    const departments = {
      ...data,
      departments: data.departments.map((d, i) =>
        i === 0 ? { ...d, sandbox: { webDomains: ["help.gong.io"] } } : d,
      ),
    };
    const view = (onSave?: (id: string, domains: string[]) => Promise<void>) =>
      render(
        <DepartmentsView
          data={departments}
          onNewDepartment={noop}
          onDissolve={asyncNoop}
          onOpenBoard={noop}
          onCycleCell={asyncNoop}
          onHire={noop}
          onDesign={noop}
          {...(onSave ? { onSaveWebDomains: onSave } : {})}
        />,
      );
    expect(view(asyncNoop)).toContain('value="help.gong.io"');
    expect(view()).toContain("help.gong.io");
    expect(view()).toContain("Its web sites narrow what web reads for its tasks");
    const grant = render(
      <ConnectionGrant connection={web} grant={{ mode: "read", picked: null }} onChange={noop} />,
    );
    expect(grant).toContain("the board&#x27;s fetch: only gong.io and the sites under it");
  });

  it("names each page in Activity, never what it says", () => {
    const at = "2026-10-21T12:00:00.000Z";
    const ev = (payload: Record<string, unknown>) => ({
      id: "e-web",
      companyId: fixture.company.id,
      seq: 900,
      type: "tool.called" as const,
      actor: { kind: "teammate" as const, id: fixture.teammates[0]!.id },
      subject: { kind: "connection" as const, id: "c-web" },
      payload: { connection: "web", tool: "fetch", number: 140, ...payload },
      createdAt: at,
    });
    expect(
      describeEvent(ev({ url: "https://help.gong.io/calls", ok: true, status: 200, bytes: 34_816 }), fixture)
        .text,
    ).toContain("read https://help.gong.io/calls for #140 · 200 · 34 KB");
    expect(
      describeEvent(
        ev({
          url: "https://intranet.gong.io/",
          ok: false,
          status: null,
          bytes: 0,
          note: "intranet.gong.io resolves to 10.0.0.5",
        }),
        fixture,
      ).text,
    ).toContain("could not read https://intranet.gong.io/ for #140: intranet.gong.io resolves to 10.0.0.5");
    expect(describeEvent(ev({ ok: true }), fixture).text).toContain("read web · fetch for #140");
    const made = { ...ev({}), type: "connection.created" as const, payload: { name: "web", kind: "web" } };
    expect(describeEvent(made, fixture).text).toContain("added the web connection web");
    const checked = {
      ...ev({}),
      type: "connection.checked" as const,
      payload: { name: "web", kind: "web", ok: true, latencyMs: 0 },
    };
    expect(describeEvent(checked, fixture).text).toContain("checked web: the board reads the web");
    const sites = {
      ...ev({}),
      type: "connection.updated" as const,
      payload: { name: "web", domains: ["gong.io"] },
    };
    expect(describeEvent(sites, fixture).text).toContain(
      "set the sites web reads: only gong.io and the sites under it",
    );
    expect(describeEvent({ ...sites, payload: { name: "web", domains: null } }, fixture).text).toContain(
      "set the sites web reads: any public site",
    );
  });
});

describe("sign-in page", () => {
  const noop = async () => {};
  it("offers the identity provider by name, the dev login only when the board allows it, and says why a sign-in failed", () => {
    const sso = renderToString(
      <LoginView
        providers={{ devLogin: false, oidc: { name: "Acme SSO", startUrl: "/api/auth/oidc/start" } }}
        onLogin={noop}
      />,
    );
    expect(sso).toContain("Sign in with Acme SSO");
    expect(sso).toContain('href="/api/auth/oidc/start"');
    expect(sso).not.toContain("ROSTERDOCK_DEV_LOGIN");
    const dev = renderToString(<LoginView providers={{ devLogin: true, oidc: null }} onLogin={noop} />);
    expect(dev).toContain("Local development sign-in");
    expect(dev).toContain('type="email"');
    const both = renderToString(
      <LoginView
        providers={{ devLogin: true, oidc: { name: "Google", startUrl: "/api/auth/oidc/start" } }}
        error="domain"
        onLogin={noop}
      />,
    );
    expect(both).toContain("Sign in with Google");
    expect(both).toContain("Or the local dev login");
    expect(both).toContain("not allowed to sign in here");
    const nothing = renderToString(<LoginView providers={{ devLogin: false, oidc: null }} onLogin={noop} />);
    expect(nothing).toContain("No way to sign in is configured");
    expect(loginErrorText("denied")).toMatch(/cancelled/);
    expect(loginErrorText("what")).toMatch(/failed/);
    expect(loginErrorText(null)).toBeNull();
  });
});

describe("pure helpers", () => {
  it("matrix cells cycle none, member, lead, none", () => {
    expect(nextCellState("none")).toBe("member");
    expect(nextCellState("member")).toBe("lead");
    expect(nextCellState("lead")).toBe("none");
    expect(cellState(fixture.departments[0]!, fixture.teammates[0]!)).toBe("lead");
    expect(cellState(fixture.departments[0]!, fixture.teammates[1]!)).toBe("member");
    expect(cellState(fixture.departments[1]!, fixture.teammates[1]!)).toBe("none");
  });

  it("derives teammate status from the board", () => {
    expect(teammateStatus(fixture.teammates[1]!, fixture.tasks).tone).toBe("ok");
    expect(teammateStatus(fixture.teammates[3]!, fixture.tasks).text).toMatch(/^Blocked/);
    expect(teammateStatus(fixture.teammates[0]!, fixture.tasks).text).toBe("Idle · available");
    // A cancelled task is nobody's work: the teammate it was blocking is free.
    const dropped = fixture.tasks.map((t) =>
      t.status === "blocked" ? { ...t, status: "cancelled" as const } : t,
    );
    expect(teammateStatus(fixture.teammates[3]!, dropped).text).not.toMatch(/^Blocked/);
  });

  it("a task waiting on a person is amber and needs you: on its card, its department and in the feed", () => {
    const onTeammate = fixture.tasks.find((t) => t.status === "blocked")!;
    expect(blockerLine(onTeammate)).toBe("Waiting on @brody");
    expect(blockerNeedsYou(onTeammate.blocker)).toBe(false);
    const blocker = blockerFor("waiting_on_person", {
      what: "Blocked: waiting on @manager to grant web fetch access.",
      why: "@manager is not a teammate here, so a person has to answer.",
    });
    const onPerson = { ...onTeammate, blocker };
    expect(blockerLine(onPerson)).toBe("Needs you");
    expect(blockerNeedsYou(onPerson.blocker)).toBe(true);
    const data = { ...fixture, tasks: fixture.tasks.map((t) => (t.id === onPerson.id ? onPerson : t)) };
    expect(render(<CompanyView data={fixture} {...companyProps} />)).not.toContain("waiting on you");
    expect(render(<CompanyView data={data} {...companyProps} />)).toContain(
      "2 teammates · 0 working · waiting on you",
    );
    const ev = fixture.events.find((e) => e.type === "task.blocked")!;
    expect(describeEvent(ev, fixture).attention).toBe(false);
    expect(describeEvent({ ...ev, payload: { number: 140, blocker } }, fixture)).toMatchObject({
      text: "#140 is blocked: Blocked: waiting on @manager to grant web fetch access.",
      attention: true,
    });
  });

  it("relative time and event sentences", () => {
    const now = new Date("2026-09-12T04:10:00Z").getTime();
    expect(relativeTime("2026-09-12T04:00:00Z", now)).toBe("10 min ago");
    expect(relativeTime("2026-09-12T04:09:50Z", now)).toBe("just now");
    const s = describeEvent(fixture.events[0]!, fixture, fixture.members[0]!.userId);
    expect(s.text).toBe("Ricky created #144 Cross-check credential names against outbound-mail map for Cody");
    expect(s.go?.taskId).toBe(fixture.tasks[1]!.id);
    // Review and pull request events open the review.
    const ev = (
      type: string,
      actor: { kind: "user" | "teammate"; id: string } | null,
      payload: Record<string, unknown>,
    ) =>
      ({
        id: "e",
        companyId: fixture.company.id,
        seq: 9,
        type: type as never,
        actor,
        subject: { kind: "review" as const, id: "rev1" },
        payload,
        createdAt: "2026-09-12T04:00:00.000Z",
      }) as const;
    const verifier = { kind: "teammate" as const, id: fixture.teammates[2]!.id };
    // Peter's events.
    const peter = { kind: "teammate" as const, id: fixture.teammates[0]!.id };
    expect(
      describeEvent(
        ev("goal.planned", peter, {
          title: "Weekly Gong digest",
          tasks: [1, 2, 3, 4],
          assignees: ["Ricky", "Brody", "Cody"],
          projectId: "p1",
        }),
        fixture,
      ),
    ).toMatchObject({
      text: "Peter split Weekly Gong digest into 4 tasks for Ricky, Brody, Cody",
      go: { view: "board", projectId: "p1" },
    });
    expect(
      describeEvent(
        ev("teammate.drift", peter, {
          teammateName: "Cody",
          metric: "cost",
          value: 410_000,
          baseline: 128_000,
          ratio: 3.2,
          number: 12,
        }),
        fixture,
      ).text,
    ).toBe("Cody's runs cost 3.2× their usual (410k tokens against 128k tokens on #12)");
    // A discovery says how many tools only the server calls read-only; a person's confirmation says which.
    const daniel = { kind: "user" as const, id: fixture.members[0]!.userId };
    expect(
      describeEvent(
        ev("connection.updated", daniel, {
          name: "github",
          discovered: 5,
          writes: ["create_issue", "issue_read", "pull_request_read"],
          unconfirmed: ["issue_read", "pull_request_read"],
        }),
        fixture,
      ).text,
    ).toBe("Daniel discovered 5 tools on github · 3 write · 2 to confirm as reads");
    expect(
      describeEvent(
        ev("connection.updated", daniel, { name: "github", discovered: 2, writes: [], unconfirmed: [] }),
        fixture,
      ).text,
    ).toBe("Daniel discovered 2 tools on github · 0 write");
    expect(
      describeEvent(
        ev("connection.updated", daniel, {
          name: "github",
          reclassified: ["issue_read"],
          confirmed: ["issue_read"],
        }),
        fixture,
      ).text,
    ).toBe("Daniel confirmed issue_read on github as a read");
    expect(
      describeEvent(
        ev("connection.updated", daniel, {
          name: "github",
          reclassified: ["issue_read", "pull_request_read"],
          confirmed: ["issue_read", "pull_request_read"],
        }),
        fixture,
      ).text,
    ).toBe("Daniel confirmed issue_read, pull_request_read on github as reads");
    expect(
      describeEvent(
        ev("connection.updated", daniel, {
          name: "github",
          reclassified: ["issue_read", "create_issue"],
          confirmed: ["issue_read"],
        }),
        fixture,
      ).text,
    ).toBe("Daniel reclassified issue_read, create_issue on github");
    // A cancelled task says why, and a reopened one says so.
    const cancelled = { number: 12, title: "Map it", from: "todo", to: "cancelled", toLabel: "Cancelled" };
    expect(
      describeEvent(ev("task.moved", peter, { ...cancelled, note: "The goal was stopped." }), fixture).text,
    ).toBe("Peter cancelled #12: The goal was stopped.");
    expect(describeEvent(ev("task.moved", peter, cancelled), fixture).text).toBe("Peter cancelled #12");
    // A proposal replaced by a newer one of the same write says so, and points at the newer one.
    expect(
      describeEvent(
        ev("approval.superseded", peter, {
          number: 31,
          title: "Publish positioning.md",
          teammateName: "Brody",
          by: "a2",
          byTitle: "Publish corrected positioning.md",
        }),
        fixture,
      ),
    ).toMatchObject({
      text: "Brody replaced publish positioning.md on #31 with a newer proposal: Publish corrected positioning.md",
      go: { view: "approvals", approvalId: "a2" },
    });
    expect(
      describeEvent(
        ev("task.moved", peter, { number: 12, from: "cancelled", to: "todo", toLabel: "To do" }),
        fixture,
      ).text,
    ).toBe("Peter reopened #12");
    expect(
      describeEvent(
        ev(
          "review.reassigned",
          { kind: "user", id: fixture.members[0]!.userId },
          {
            number: 146,
            title: "Requirements",
            taskId: "t1",
            reviewer: { kind: "user", id: fixture.members[0]!.userId, name: "Daniel" },
          },
        ),
        fixture,
        fixture.members[0]!.userId,
      ),
    ).toMatchObject({
      text: "You made #146 Requirements yours to review",
      attention: true,
      go: { view: "reviews", reviewId: "rev1" },
    });
    expect(
      describeEvent(ev("goal.questions", peter, { title: "Reconcile Xero", questions: ["a", "b"] }), fixture),
    ).toMatchObject({
      text: "Peter has 2 questions before planning Reconcile Xero",
      attention: true,
    });
    expect(
      describeEvent(ev("goal.escalated", peter, { title: "Digest", reason: "#3 failed 3 times" }), fixture)
        .text,
    ).toBe("Peter needs you on Digest: #3 failed 3 times");
    // A teammate's decision reads as one, with how sure it is.
    expect(
      describeEvent(
        ev(
          "decision.logged",
          { kind: "teammate", id: fixture.teammates[1]!.id },
          {
            number: 12,
            decision: "Read the Gong calls from the v2 API",
            confidence: 0.8,
          },
        ),
        fixture,
      ).text,
    ).toBe("Cody decided on #12: Read the Gong calls from the v2 API (80% sure)");
    // Every event type has its own sentence: none falls through to its raw name.
    for (const type of EVENT_TYPES) {
      expect(describeEvent(ev(type, peter, {}), fixture).text, type).not.toContain(type);
    }
    expect(describeEvent(ev("task.replanned", peter, { number: 3, replans: 1 }), fixture).text).toBe(
      "Peter re-planned #3 after a failed run (attempt 2)",
    );
    expect(
      describeEvent(ev("goal.done", peter, { title: "Digest", spend: { totalTokens: 4500 } }), fixture).text,
    ).toBe("Digest is done · 4,500 tokens");
    expect(
      describeEvent(ev("draft.proposed", peter, { kind: "org", departments: [{ name: "Finance" }] }), fixture)
        .text,
    ).toBe("Peter proposes Finance; accept it on the Company page");
    expect(
      describeEvent(
        ev(
          "draft.accepted",
          { kind: "user", id: fixture.members[0]!.userId },
          { kind: "org", departments: 1, teammates: 2 },
        ),
        fixture,
        fixture.members[0]!.userId,
      ).text,
    ).toBe("You accepted Peter's draft: 1 department, 2 teammates");
    // Approvals (M5): proposals need you and open the Approvals view; decisions read back.
    const cody = { kind: "teammate" as const, id: fixture.teammates[1]!.id };
    const proposed = describeEvent(
      ev("approval.proposed", cody, {
        number: 144,
        title: "Create a HubSpot list",
        connection: "hubspot",
        tool: "create_list",
      }),
      fixture,
    );
    expect(proposed.text).toBe(
      "Cody asks approval to create a HubSpot list (hubspot · create_list) for #144",
    );
    expect(proposed.attention).toBe(true);
    expect(proposed.go?.view).toBe("approvals");
    expect(
      describeEvent(
        ev(
          "approval.rejected",
          { kind: "user", id: fixture.members[0]!.userId },
          { number: 144, title: "Create a HubSpot list", note: "Use the active list." },
        ),
        fixture,
        fixture.members[0]!.userId,
      ).text,
    ).toBe("You rejected create a HubSpot list on #144: Use the active list.");
    expect(
      describeEvent(
        ev("approval.executed", cody, {
          number: 144,
          title: "Create a HubSpot list",
          connection: "hubspot",
          tool: "create_list",
        }),
        fixture,
      ).text,
    ).toBe("hubspot · create_list executed for #144: Create a HubSpot list");
    const opened = describeEvent(
      ev(
        "review.opened",
        { kind: "teammate", id: fixture.teammates[1]!.id },
        { number: 142, title: "Map VMS", round: 2, authorName: "Cody", reviewer: { name: "Verifier" } },
      ),
      fixture,
    );
    expect(opened.text).toBe("Cody handed #142 Map VMS to Verifier for review (round 2)");
    expect(opened.go).toMatchObject({ view: "reviews", reviewId: "rev1" });
    expect(
      describeEvent(ev("review.opened", null, { number: 5, title: "x", round: 1, reviewer: null }), fixture)
        .attention,
    ).toBe(true);
    expect(
      describeEvent(
        ev("review.changes_requested", verifier, { number: 142, title: "Map VMS", openComments: 1 }),
        fixture,
      ).text,
    ).toBe("Verifier requested changes on #142 Map VMS · 1 open comment");
    expect(
      describeEvent(ev("review.approved", verifier, { number: 142, title: "Map VMS" }), fixture).text,
    ).toBe("Verifier approved #142 Map VMS");
    // A person approving over a failed credential scan or failing tests is said so in the line.
    expect(
      describeEvent(
        ev(
          "review.approved",
          { kind: "user", id: fixture.members[0]!.userId },
          {
            number: 142,
            title: "Map VMS",
            overrodeChecks: [{ kind: "tests", title: "npm test failed: 2 failing" }],
          },
        ),
        fixture,
        fixture.members[0]!.userId,
      ).text,
    ).toBe("You approved #142 Map VMS over a failed check: npm test failed: 2 failing");
    expect(
      describeEvent(
        ev("pr.opened", verifier, { number: 142, prNumber: 42, repo: "acme/gtm", reviewId: "rev1" }),
        fixture,
      ).text,
    ).toBe("Pull request #42 opened for #142 on acme/gtm · merging needs you");
    expect(describeEvent(ev("task.done", verifier, { number: 142, title: "Map VMS" }), fixture).text).toBe(
      "#142 Map VMS is Done",
    );
    expect(
      describeEvent(
        ev("run.queued", verifier, {
          number: 142,
          title: "Map VMS",
          kind: "review",
          teammateName: "Verifier",
          round: 2,
        }),
        fixture,
      ).text,
    ).toBe("Verifier is up to review #142 Map VMS (round 2)");
    expect(
      describeEvent(
        ev("run.started", verifier, { number: 142, kind: "review", teammateName: "Verifier", attempt: 1 }),
        fixture,
      ).text,
    ).toBe("Verifier is reviewing on #142");
  });

  it("a ticket's outputs lead with its deliverable, then the newest of each other file", () => {
    const at = (run: string, path: string, kind: string, t: string) => ({
      id: `${run}-${path}`,
      runId: run,
      taskId: "t1",
      path,
      kind,
      sha256: "s",
      bytes: 10,
      inline: true,
      createdAt: `2026-09-30T${t}:00.000Z`,
    });
    const all = [
      at("r2", "shortlist.md", "document", "12:00"),
      at("r2", "scratch.md", "document", "12:00"),
      at("r2", "changes.diff", "diff", "12:00"),
      at("r3", "handover-summary.md", "handover", "12:30"),
      at("r1", "shortlist.md", "document", "11:00"),
      at("r1", "scratch.md", "document", "11:00"),
      at("r1", "changes.diff", "diff", "11:00"),
    ];
    const deliverable = [all[0]!];
    // Not the deliverable or its older version, not the diffs; the newest scratch.md, counted.
    expect(otherFiles(all, deliverable).map((o) => [o.file.id, o.versions])).toEqual([
      ["r3-handover-summary.md", 1],
      ["r2-scratch.md", 2],
    ]);
    expect(DELIVERABLE_LABEL.approved).toEqual({ label: "Approved in review", tone: "ok" });
    expect(DELIVERABLE_LABEL.changes_requested.tone).toBe("warn");
  });

  it("the tokens-per-day chart has all fourteen days, the ones without runs too", () => {
    // Seen on a live board: a company that began today drew a single bar across the whole card.
    const days = fourteenDays(
      [{ day: "2026-09-30", tokens: 7_600_000, costMinorUnits: 1101 }],
      new Date("2026-09-30T22:00:00Z"),
    );
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ day: "2026-09-17", tokens: 0, costMinorUnits: null });
    expect(days[13]).toEqual({ day: "2026-09-30", tokens: 7_600_000, costMinorUnits: 1101 });
    expect(days.filter((d) => d.tokens > 0)).toHaveLength(1);
  });

  it("Costs view shows spend, budget, forecast and the four breakdowns", () => {
    const html = render(
      <CostsView
        data={fixture}
        initial={costFixture}
        loadCosts={async () => costFixture}
        loadMonthly={async () => monthlyFixture}
        usageCsvUrl={(w) => `/api/companies/c1/costs/export.csv?window=${w}`}
        chargebackCsvUrl={(m) => `/api/companies/c1/costs/monthly.csv?month=${m}`}
        onOpenTeammate={noop}
        onOpenProject={noop}
        onOpenSettings={noop}
      />,
    );
    expect(html).toContain("Spend so far");
    expect(html).toContain("£412.50");
    expect(html).toContain("Forecast to Sunday");
    expect(html).toContain("£687.50");
    expect(html).toContain("If billed the other way");
    expect(html).toContain("£230.26");
    expect(html).toContain("56% used");
    expect(html).toContain("80% alert");
    for (const s of [
      "By department",
      "By model",
      "By teammate",
      "By project",
      "Engineering",
      "Gong digest",
      "claude-opus-5",
    ])
      expect(html).toContain(s);
    expect(html).toContain("Last 14 days");
    // Peter's planning calls count beside the runs, never as runs.
    expect(html).toContain("9 runs · 3 planning calls · 3 teammates");
    expect(html).toContain('2<div class="hint">3 planning calls</div>');
    expect(html).toContain("2 runs · 3 planning calls");
    expect(workCount({ runs: 1, calls: 0 })).toBe("1 run");
    expect(workCount({ runs: 0, calls: 1 })).toBe("0 runs · 1 planning call");
    expect(html).toContain("Export CSV");
    expect(html).toContain('href="/api/companies/c1/costs/export.csv?window=week"');
    expect(html).toContain("Monthly report");
    // A stub teammate's runs read as the stub engine, never as the model the teammate names.
    const stubTokens = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500 };
    const stub = {
      model: "stub",
      providerId: null,
      provider: "This board's own models",
      tokens: stubTokens,
      costMinorUnits: null,
      runs: 1,
      calls: 0,
    };
    const withStub = render(
      <CostsView
        data={fixture}
        initial={{
          ...costFixture,
          byTeammate: [{ ...costFixture.byTeammate[0]!, ...stub, name: "Stubby", engine: "stub" }],
          byModel: [{ ...stub, teammates: 1 }],
        }}
        loadCosts={async () => costFixture}
        loadMonthly={async () => monthlyFixture}
        usageCsvUrl={(w) => `/api/companies/c1/costs/export.csv?window=${w}`}
        chargebackCsvUrl={(m) => `/api/companies/c1/costs/monthly.csv?month=${m}`}
        onOpenTeammate={noop}
        onOpenProject={noop}
        onOpenSettings={noop}
      />,
    );
    expect((withStub.match(/Stub \(no model\)/g) ?? []).length).toBe(2);
    expect(withStub).not.toContain("claude-sonnet-5");
    expect(modelLabel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    const monthly = render(
      <MonthlyView
        month="2026-08"
        report={monthlyFixture}
        error={null}
        usageCsvUrl="/api/companies/c1/costs/export.csv?month=2026-08"
        chargebackCsvUrl="/api/companies/c1/costs/monthly.csv?month=2026-08"
        onOpenProject={noop}
      />,
    );
    expect(monthly).toContain("API spend in 2026-08");
    expect(monthly).toContain("Chargeback by project");
    expect(monthly).toContain("ACME-2026-Q3");
    expect(monthly).toContain("untagged");
    expect(monthly).toContain("£412.50");
    expect(monthly).toContain('href="/api/companies/c1/costs/monthly.csv?month=2026-08"');
    expect(monthly).toContain("By chargeback tag");
    expect(monthOf(new Date("2026-08-03T10:00:00Z"))).toBe("2026-08");
    expect(money(null, "GBP")).toBe("—");
    expect(money(241, "GBP")).toBe("£2.41");
  });

  it("Settings view is five tabs; prices and budgets on the first; only editors get the forms", () => {
    const props = {
      data: fixture,
      loadPrices: async () => priceFixture,
      savePrice: async () => priceFixture[0]!,
      deletePrice: asyncNoop,
      fillListPrices: async () => ({ added: [], unknown: [] }),
      loadBudgets: async () => budgetFixture,
      saveBudget: async () => budgetFixture[0]!,
      deleteBudget: asyncNoop,
      initialPrices: priceFixture,
      initialBudgets: budgetFixture,
      models: {
        features: { oauth: true, objectStore: false },
        load: async () => ({ offered: { kinds: [], board: true }, providers: [] }),
        loadSecrets: async () => [],
        setSecret: asyncNoop,
        checkNew: async () => ({ ok: true }),
        create: async () => Promise.reject(new Error("not in this test")),
        update: async () => Promise.reject(new Error("not in this test")),
        remove: asyncNoop,
        initial: { offered: { kinds: [], board: true }, providers: [] },
        initialSecrets: [],
        loadPrices: async () => priceFixture,
        savePrice: async () => priceFixture[0]!,
        deletePrice: asyncNoop,
        fillListPrices: async () => ({ added: [], unknown: [] }),
        initialPrices: priceFixture,
      },
      connections: {
        loadCatalog: async () => [],
        createConnection: async () => connectionFixtures[0]!,
        previewOpenApi: async () => ({ operations: [], errors: [] }),
        createOpenApiConnection: async () => connectionFixtures[1]!,
        updateConnection: async () => connectionFixtures[0]!,
        discoverConnection: async () => connectionFixtures[0]!,
        checkConnection: async () => connectionFixtures[0]!,
        deleteConnection: asyncNoop,
        startOAuth: async () => ({ url: "" }),
        initialCatalog: [],
      },
      saveClientPolicy: asyncNoop,
      saveNotifySettings: asyncNoop,
      saveDriftSettings: asyncNoop,
      loadPlanner: async () => plannerFixture,
      savePlanner: asyncNoop,
      initialPlanner: plannerFixture,
      loadStyles: async () => stylesFixture,
      setStyle: async () => stylesFixture,
      initialStyles: stylesFixture,
      testNotify: async () => ({ sent: true, target: "GTM_SLACK_WEBHOOK", error: null }),
      templatesExportUrl: "/api/companies/c1/templates/export",
      importTemplates: async () => ({
        created: {
          teammateTemplates: [],
          teammates: ["Cody"],
          departments: ["Engineering"],
          connections: ["n8n"],
        },
        clientPolicies: [],
        skipped: ["teammate Peter"],
        notes: [],
      }),
    };
    // One tab at a time: the prices tab shows no notification field, and every tab is offered.
    const prices = render(<SettingsView {...props} canEdit tab="prices" onTab={noop} />);
    expect(prices).toContain("Model prices");
    expect(prices).not.toContain("Webhook env var NAME");
    for (const t of SETTINGS_TABS) expect(prices).toContain(t.label);
    expect(SETTINGS_TABS.map((t) => t.value)).toEqual([
      "prices",
      "models",
      "peter",
      "style",
      "connections",
      "notifications",
      "drift",
      "templates",
    ]);
    // A budget row reads on one line, the window as a phrase; Peter's goal cap says so.
    expect(budgetLine(budgetFixture[0]!)).toBe("1.69M of 3.00M a week");
    expect(budgetLine({ used: 0, tokensLimit: 500_000, window: "goal" })).toBe("0 of 500.0k for the goal");
    expect(prices).toContain("1.69M of 3.00M a week");
    const all = (canEdit: boolean) =>
      SETTINGS_TABS.map((t) =>
        render(<SettingsView {...props} canEdit={canEdit} tab={t.value} onTab={noop} />),
      ).join("\n");
    const editor = all(true);
    expect(editor).toContain("Webhook env var NAME");
    // List prices: one click for an editor, with what it did in a sentence.
    expect(prices).toContain("Add list prices");
    expect(all(false)).not.toContain("Add list prices");
    expect(listPricesLine({ added: ["claude-opus-5-5", "claude-haiku-4-5"], unknown: ["gpt-6-astra"] })).toBe(
      "Priced claude-opus-5-5, claude-haiku-4-5 at the API list price. No list price for gpt-6-astra: add it by hand.",
    );
    expect(listPricesLine({ added: [], unknown: [] })).toBe(
      "Every model in use with a list price already has a price.",
    );
    // House style: each pack with what it governs, where it comes from, a level where it has them.
    const style = render(<SettingsView {...props} canEdit tab="style" onTab={noop} />);
    expect(style).toContain("Minimal code (Ponytail)");
    expect(style).toContain("Terse replies (Caveman)");
    expect(style).toContain("Delivered files and code are written normally.");
    expect(style).toContain("Turn on");
    expect(style).toContain("Turn off");
    expect(style).toContain("Ultra");
    expect(styleSource(stylesFixture[0]!)).toBe(
      "From dietrichgebert/ponytail at e3ba2aa, MIT licence; downloaded from GitHub when first turned on.",
    );
    // A pack the board's build carries needs no network, whenever it was turned on.
    expect(styleSource(stylesFixture[1]!)).toBe(
      "From JuliusBrussee/caveman at 2fd153c, MIT licence; comes with this board.",
    );
    expect(render(<SettingsView {...props} canEdit={false} tab="style" onTab={noop} />)).not.toContain(
      "Turn on",
    );
    // How Peter thinks: every brain the board offers, whether it works here, and what he plans with now.
    const peter = render(<SettingsView {...props} canEdit tab="peter" onTab={noop} />);
    expect(peter).toContain("How Peter thinks");
    expect(peter).toContain("Peter plans with the Claude Code CLI, chosen automatically.");
    expect(peter).toContain("signed in (claude.ai, max)");
    expect(peter).toContain("installed, not signed in: run codex login where the board runs");
    expect(peter).toContain("No model");
    expect(plannerLine({ ...plannerFixture, effective: null, choice: { via: "none" } })).toBe(
      "Peter plans by role, without a model.",
    );
    expect(plannerLine({ ...plannerFixture, effective: null, choice: { via: "codex_cli" } })).toBe(
      "The Codex CLI does not work on this board, so Peter plans by role until it does.",
    );
    expect(plannerLine({ ...plannerFixture, effective: null, choice: { via: "auto" } })).toBe(
      "Nothing works on this board yet, so Peter plans by role.",
    );
    expect(editor).toContain("SMTP URL env var NAME");
    expect(
      notifyFromForm({
        webhookEnvName: " HOOK ",
        smtpUrlEnvName: "SMTP",
        to: "a@x.test, b@x.test",
        from: "",
      }),
    ).toEqual({
      webhookEnvName: "HOOK",
      email: { smtpUrlEnvName: "SMTP", to: ["a@x.test", "b@x.test"] },
    });
    expect(notifyFromForm({ webhookEnvName: "", smtpUrlEnvName: "SMTP", to: "", from: "" })).toEqual({
      webhookEnvName: null,
      email: null,
    });
    expect(editor).toContain("Save thresholds");
    expect(editor).toContain("Times the usual");
    expect(driftForm({ drift: { ratioFloor: 2.5 } })).toEqual({
      ratioFloor: "2.5",
      madFactor: "",
      rejectionRateFloor: "",
      rejectionRateDelta: "",
    });
    expect(editor).toContain("Send a test");
    expect(editor).toContain("Connections");
    expect(editor).toContain("Client policies");
    expect(editor).toContain("Model prices");
    expect(editor).toContain("claude-sonnet-5");
    expect(editor).toContain("£200.00");
    expect(editor).toContain("Save price");
    expect(editor).toContain("Set budget");
    expect(editor).toContain("GTM Studio");
    expect(editor).toContain("86%");
    expect(editor).toContain("Names only");
    expect(editor).toContain("Export as a file");
    expect(editor).toContain('type="file"');
    const viewer = all(false);
    expect(viewer).not.toContain("Save price");
    expect(viewer).not.toContain("Set budget");
    expect(viewer).toContain("Export as a file");
    expect(viewer).not.toContain('type="file"');
    expect(
      importSummary({
        created: {
          teammateTemplates: [],
          teammates: ["Cody"],
          departments: ["Engineering"],
          connections: ["n8n"],
        },
        clientPolicies: ["VMS architecture map"],
        skipped: ["teammate Peter"],
        notes: ["teammate Cody: no connection named n8n here; grant dropped"],
      }),
    ).toBe("Created 1 department, 1 teammate, 1 connection. 1 client policy set. Already here: 1. 1 note.");
    expect(toMinor("2.40")).toBe(240);
    expect(toMinor("")).toBeNull();
    expect(toMinor("-1")).toBeNull();
    expect(scopeName(fixture, budgetFixture[1]!)).toBe("Engineering");
  });

  it("Working now lists live runs with step, elapsed time and tokens; turns say answering", () => {
    const now = new Date("2026-09-12T04:05:00.000Z").getTime();
    const html = render(<WorkingNow runs={liveRunFixture} data={fixture} now={now} onOpenTask={noop} />);
    expect(html).toContain("Working now");
    expect(html).toContain("2 runs");
    expect(html).toContain("Cody");
    expect(html).toContain("reading the intake workflow");
    expect(html).toContain(`${fmtTokens(53_200)} tokens`);
    expect(html).toContain("Ricky");
    expect(html).toContain("answering on");
    expect(html).toContain("Waiting for a worker");
    // The running one says what its pod is using; the queued one has no pod yet.
    expect(html).toContain("320m CPU · 512 MB");
    expect(fmtCpu(1500)).toBe("1.5 cores");
    expect(fmtBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(fmtBytes(300 * 1024)).toBe("300 kB");
    expect(render(<WorkingNow runs={[]} data={fixture} onOpenTask={noop} />)).toBe("");
    // The company view shows the panel in its rail when runs are live.
    const company = render(
      <CompanyView
        data={fixture}
        {...companyProps}
        liveRuns={liveRunFixture}
        onNewProject={noop}
        onNewTask={noop}
        onNewDepartment={noop}
        onOpenReview={noop}
        onOpenProject={noop}
        onOpenDepartmentBoard={noop}
        onOpenTask={noop}
        onOpenTeammate={noop}
        onGoActivity={noop}
      />,
    );
    expect(company).toContain("Working now");
  });

  it("Office: rooms per department, a desk per teammate, handoffs from tasks, blockers and mentions", () => {
    const layout = officeLayout(fixture, "all");
    expect(layout.rooms.map((r) => r.d.name)).toEqual(["Engineering", "Research"]);
    // Peter sits at reception; everyone else has a desk in a room.
    expect(layout.manager).toBe(fixture.teammates.find((t) => t.handle === "peter")!.id);
    expect([...layout.rooms.flatMap((r) => r.desks.map((d) => d.id)), layout.manager].sort()).toEqual(
      fixture.teammates.map((t) => t.id).sort(),
    );
    expect(officeLayout(fixture, fixture.departments[1]!.id).single).toBe(true);

    const edges = officeInteractions(fixture, liveRunFixture);
    const kinds = edges.map((e) => e.kind);
    expect(kinds).toContain("task"); // Ricky filed #144 for Cody
    expect(kinds).toContain("blocked"); // #140 waits on Brody
    expect(edges.find((e) => e.kind === "blocked")!.label).toBe("Ricky blocked on Brody · #140");
    expect(edges.find((e) => e.kind === "mention")!.label).toBe("Ricky answering on #142");

    const cody = fixture.teammates.find((t) => t.handle === "cody")!;
    expect(agentMode(cody, fixture.tasks, liveRunFixture).mode).toBe("typing");
    const ricky = fixture.teammates.find((t) => t.handle === "ricky")!;
    const turnRunning = liveRunFixture.map((r) => ({ ...r, status: "running" as const }));
    expect(agentMode(ricky, fixture.tasks, turnRunning).mode).toBe("reading"); // answering a turn
    expect(agentMode(ricky, fixture.tasks, []).mode).toBe("blocked");

    const html = render(
      <OfficeView
        data={fixture}
        liveRuns={liveRunFixture}
        meName="Daniel"
        initialMode="map"
        onOpenTask={noop}
        onOpenTeammate={noop}
        onOpenDepartmentBoard={noop}
        onGoApprovals={noop}
      />,
    );
    expect(html).toContain("Interaction map");
    expect(html).toContain("ENGINEERING");
    expect(html).toContain("RESEARCH");
    expect(html).toContain("Daniel · approvals");
    expect(html).toContain("Peter · lead");
    expect(html).toContain("Handoffs in flight");
    expect(html).toContain("Ricky blocked on Brody · #140");
    expect(html).toContain('class="edge blocked"');

    // The layout editor: slots order the rooms, a colour is the room's, a desk takes its cell when free.
    const eng = layout.rooms[0]!;
    const res = layout.rooms[1]!;
    const arranged = officeLayout(fixture, "all", {
      rooms: { [eng.d.id]: { slot: 1 }, [res.d.id]: { slot: 0, color: "#123456" } },
    });
    expect(arranged.rooms.map((r) => r.d.name)).toEqual(["Research", "Engineering"]);
    expect(arranged.rooms[0]!.color).toBe("#123456");
    const [first, second] = eng.desks;
    expect([first!.col, first!.row, second!.col, second!.row]).toEqual([0, 0, 1, 0]);
    const moved = officeLayout(fixture, "all", { desks: { [first!.id]: { col: 2, row: 1 } } });
    const desk = (id: string, L = moved) => L.rooms.flatMap((r) => r.desks).find((d) => d.id === id)!;
    expect([desk(first!.id).col, desk(first!.id).row]).toEqual([2, 1]);
    // Two claims on one cell: the first in department order keeps it, the other takes the next free one after its own.
    const contested = officeLayout(fixture, "all", {
      desks: { [first!.id]: { col: 1, row: 0 }, [second!.id]: { col: 1, row: 0 } },
    });
    expect([desk(first!.id, contested).col, desk(second!.id, contested).col]).toEqual([1, 2]);
    // A desk without a chosen cell keeps its own when another desk moves away.
    expect(desk(second!.id).col).toBe(1);
    // A cell off the grid is ignored.
    expect(
      desk(first!.id, officeLayout(fixture, "all", { desks: { [first!.id]: { col: 9, row: 9 } } })).col,
    ).toBe(0);
    // Drops are pure: a desk on another's cell swaps them; a room on another swaps their slots.
    const swapDesks = dropDesk({}, layout, first!.id, second!.x + 8, second!.y + 11)!;
    expect(swapDesks.desks).toEqual({ [first!.id]: { col: 1, row: 0 }, [second!.id]: { col: 0, row: 0 } });
    expect(dropDesk({}, layout, first!.id, first!.x + 8, first!.y + 11)).toBeNull();
    expect(dropDesk({}, layout, first!.id, -10, -10)).toBeNull();
    const swapRooms = dropRoom({}, layout, eng.d.id, res.x + 5, res.y + 5)!;
    expect(officeLayout(fixture, "all", swapRooms).rooms.map((r) => r.d.name)).toEqual([
      "Research",
      "Engineering",
    ]);
    expect(dropRoom({}, layout, eng.d.id, eng.x + 5, eng.y + 5)).toBeNull();
    expect(recolorRoom({}, eng.d.id, "#e6f2ec").rooms).toEqual({ [eng.d.id]: { color: "#e6f2ec" } });
    // What is saved is read tolerantly: a bad slot or colour is dropped, a bad desk is skipped.
    expect(
      officeSettings({
        office: {
          rooms: { x: { slot: -1, color: "red" } },
          desks: { y: { col: 1.5, row: 0 }, z: { col: 1, row: 2 } },
        },
      }),
    ).toEqual({ rooms: { x: {} }, desks: { z: { col: 1, row: 2 } } });
    expect(officeSettings({ office: "no" })).toEqual({});
    // The pack is read tolerantly too; a sprite is three frames; a room takes its own floor, else the shared one.
    const img = { sha256: "a".repeat(64), width: 48, height: 24, bytes: 300 };
    expect(
      officePack({ officePack: { "sprite.idle": img, "room.default": { ...img, sha256: "nope" } } }),
    ).toEqual({ "sprite.idle": img });
    expect(officePack({ officePack: "no" })).toEqual({});
    expect(spriteFrame(48, 24, false, 0)).toEqual({ sx: 0, w: 16, h: 24 });
    expect(spriteFrame(48, 24, true, 0)).toEqual({ sx: 16, w: 16, h: 24 });
    expect(spriteFrame(48, 24, true, 8)).toEqual({ sx: 32, w: 16, h: 24 });
    expect(spriteFrame(2, 24, true, 8)).toEqual({ sx: 0, w: 2, h: 24 });
    const floors = { "room.default": img, [`room.${eng.d.id}`]: img };
    expect(roomImageName(floors, eng.d.id)).toBe(`room.${eng.d.id}`);
    expect(roomImageName(floors, "none")).toBe("room.default");
    expect(roomImageName({}, "none")).toBeNull();
    // Editors get the button; the pixel office renders headless too.
    const pixel = render(
      <OfficeView
        data={fixture}
        liveRuns={liveRunFixture}
        meName="Daniel"
        canEdit
        onSaveOffice={asyncNoop}
        onOpenTask={noop}
        onOpenTeammate={noop}
        onOpenDepartmentBoard={noop}
        onGoApprovals={noop}
      />,
    );
    expect(pixel).toContain("Edit layout");
    expect(html).not.toContain("Edit layout");
  });

  it("the last health check on a connection reads as one line", () => {
    expect(checkLine(connectionFixtures[0]!)).toMatch(
      /^Checked .* · answered in 142 ms · 6 tools listed · 1 new: whoami$/,
    );
    expect(checkLine(connectionFixtures[1]!)).toBeNull();
    expect(
      checkLine({
        ...connectionFixtures[0]!,
        lastCheck: {
          ok: false,
          at: "2026-09-12T04:00:00.000Z",
          latencyMs: 0,
          error: "HUBSPOT_MCP_TOKEN is not set where the board runs",
          tools: { seen: 0, missing: [], extra: [] },
        },
      }),
    ).toMatch(/^Check failed .*: HUBSPOT_MCP_TOKEN is not set where the board runs$/);
  });

  it("the Board drawer shows the task's proposed writes and lets a decider act on them", () => {
    const props = {
      projectId: "all" as const,
      departmentId: "all" as const,
      selectedTaskId: approvalFixtures[0]!.taskId,
      onFilterProject: noop,
      onFilterDepartment: noop,
      onSelectTask: noop,
      onNewTask: noop,
      onMove: asyncNoop,
      onRefuseDone: noop,
      onOpenReview: noop,
      onAssign: asyncNoop,
      onSetDepartment: asyncNoop,
      loadMessages: async () => [],
      onPostMessage: asyncNoop,
      loadRuns: async () => [],
      loadRun: async () => {
        throw new Error("not in this test");
      },
      loadArtifacts: async () => [],
      loadArtifact: async () => {
        throw new Error("not in this test");
      },
      onStartRun: asyncNoop,
      onStopRun: asyncNoop,
    };
    const decider = render(
      <BoardView data={approvalsFixture} {...props} canDecide onApprove={asyncNoop} onReject={asyncNoop} />,
    );
    expect(decider).toContain("Approvals · 1 waiting for you");
    expect(decider).toContain("Create a HubSpot list");
    expect(decider).toContain("Approve and run");
    const viewer = render(<BoardView data={approvalsFixture} {...props} />);
    expect(viewer).toContain("Approvals · 1 waiting for an owner");
    expect(viewer).toContain("An owner or admin decides this.");
    expect(viewer).not.toContain("Approve and run");
    // The office desk counts approval rows, not blockers.
    expect(pendingApprovals(fixture)).toBe(0);
    expect(pendingApprovals(approvalsFixture)).toBe(1);
    const office = render(
      <OfficeView
        data={approvalsFixture}
        liveRuns={liveRunFixture}
        meName="Daniel"
        initialMode="map"
        onOpenTask={noop}
        onOpenTeammate={noop}
        onOpenDepartmentBoard={noop}
        onGoApprovals={noop}
      />,
    );
    expect(office).toContain("Daniel · 1 to approve");
  });

  it("a rejected write leaves the task saying so, and owners and admins can cancel it from the status menu", () => {
    const stale = fixture.tasks.find((t) => t.status === "blocked")!;
    const rejected = {
      ...stale,
      blocker: {
        code: "approval_rejected" as const,
        what: "Stub write: create_note on notes (notes · create_note) was rejected: written once already.",
        why: "Nothing was sent and nothing waits for a decision any more.",
        resolution:
          "Start it again with a note on what to do instead of that write, reassign it, or cancel it.",
        retrySafe: false,
      },
    };
    const data = { ...fixture, tasks: fixture.tasks.map((t) => (t.id === stale.id ? rejected : t)) };
    const props = {
      projectId: "all" as const,
      departmentId: "all" as const,
      selectedTaskId: stale.id,
      onFilterProject: noop,
      onFilterDepartment: noop,
      onSelectTask: noop,
      onNewTask: noop,
      onMove: asyncNoop,
      onRefuseDone: noop,
      onOpenReview: noop,
      onAssign: asyncNoop,
      onSetDepartment: asyncNoop,
      loadMessages: async () => [],
      onPostMessage: asyncNoop,
      loadRuns: async () => [],
      loadRun: async () => {
        throw new Error("not in this test");
      },
      loadArtifacts: async () => [],
      loadArtifact: async () => {
        throw new Error("not in this test");
      },
      onStartRun: asyncNoop,
      onStopRun: asyncNoop,
    };
    const cancel = '<option value="cancelled">Cancelled</option>';
    const owner = render(<BoardView data={data} {...props} canCancel onCancel={asyncNoop} />);
    // The card and the drawer tell what happened: no approval to give, nothing waiting.
    expect(owner).toContain("was rejected: written once already.");
    expect(owner).toContain("Nothing was sent and nothing waits for a decision any more.");
    expect(owner).not.toContain("Needs your approval");
    expect(owner).toContain(cancel);
    // Nobody else is offered it, and a task in review is its reviewer's to decide.
    expect(render(<BoardView data={data} {...props} />)).not.toContain(cancel);
    const inReview = fixture.tasks.find((t) => t.status === "review")!;
    expect(
      render(
        <BoardView data={data} {...props} selectedTaskId={inReview.id} canCancel onCancel={asyncNoop} />,
      ),
    ).not.toContain(cancel);
  });
});

describe("toolbox grants", () => {
  const tools = [
    { name: "search", description: "", write: false, source: "catalog" as const },
    { name: "get", description: "", write: false, source: "catalog" as const },
    { name: "create", description: "", write: true, source: "catalog" as const },
    { name: "gone", description: "", write: false, source: "person" as const, off: true },
  ];
  it("reads what a toolbox line grants: every tool under its mode, or the names picked; never a write under read", () => {
    expect(toolGrantedBy({ mode: "ask", picked: null }, tools[0]!)).toBe(true);
    expect(toolGrantedBy({ mode: "ask", picked: null }, tools[2]!)).toBe(true);
    expect(toolGrantedBy({ mode: "read", picked: null }, tools[2]!)).toBe(false);
    expect(toolGrantedBy({ mode: "read", picked: ["get"] }, tools[0]!)).toBe(false);
    expect(toolGrantedBy({ mode: "off", picked: null }, tools[0]!)).toBe(false);
    expect(toolGrantedBy({ mode: "ask", picked: null }, tools[3]!)).toBe(false);
  });
  it("turning tools on and off lands on the narrowest line that says the same thing", () => {
    // From nothing: allow one read.
    expect(nextGrant({ mode: "off", picked: null }, tools, ["search"], true)).toEqual({
      mode: "read",
      picked: ["search"],
    });
    // Allow the other read too: every read, so no names.
    expect(nextGrant({ mode: "read", picked: ["search"] }, tools, ["get"], true)).toEqual({
      mode: "read",
      picked: null,
    });
    // A write needs approval: ask, and with every live tool on, no names.
    expect(nextGrant({ mode: "read", picked: null }, tools, ["create"], true)).toEqual({
      mode: "ask",
      picked: null,
    });
    // Never one read under ask: the names say which.
    expect(nextGrant({ mode: "ask", picked: null }, tools, ["get"], false)).toEqual({
      mode: "ask",
      picked: ["search", "create"],
    });
    // Never the write: back to read, every read on.
    expect(nextGrant({ mode: "ask", picked: null }, tools, ["create"], false)).toEqual({
      mode: "read",
      picked: null,
    });
    // Never everything: off.
    expect(nextGrant({ mode: "ask", picked: null }, tools, ["search", "get", "create"], false)).toEqual({
      mode: "off",
      picked: null,
    });
  });
  it("a tool picked or dropped is a change to save, and a refresh of the same teammate keeps it", () => {
    const cody = connectionsFixture.teammates.find((t) => t.handle === "cody")!;
    const hubspot = connectionsFixture.connections.find((c) => c.name === "hubspot")!;
    const clean = editorState(cody);
    expect(draftDirty(clean)).toBe(false);
    // One read set to never: the mode stays "ask", only the names move.
    const grant = { mode: clean.draft.toolbox.hubspot!, picked: clean.draft.picked.hubspot ?? null };
    const dropped = nextGrant(grant, hubspot.tools, ["get_properties"], false);
    expect(dropped).toEqual({ mode: "ask", picked: ["search_crm_objects", "manage_crm_objects"] });
    const s = { ...clean, draft: withGrant(clean.draft, "hubspot", dropped) };
    expect(draftDirty(s)).toBe(true);
    expect(toolboxLines(s.draft)).toEqual([
      { connection: "hubspot", mode: "ask", tools: ["search_crm_objects", "manage_crm_objects"] },
    ]);
    // Every event in the company fetches the teammates again: the same teammate in new objects. The draft stays.
    expect(refreshed(s, structuredClone(cody))).toBe(s);
    // Saved: the teammate comes back holding the grant, at a new time; nothing is left to save.
    const saved = refreshed(s, {
      ...cody,
      toolbox: toolboxLines(s.draft),
      updatedAt: "2026-09-12T05:00:00.000Z",
    });
    expect(draftDirty(saved)).toBe(false);
    expect(saved.draft.picked.hubspot).toEqual(["search_crm_objects", "manage_crm_objects"]);
    // Picking it back is no change after all; a connection never granted, set to never, saves nothing.
    const back = nextGrant(dropped, hubspot.tools, ["get_properties"], true);
    expect(draftDirty({ ...clean, draft: withGrant(s.draft, "hubspot", back) })).toBe(false);
    expect(
      draftDirty({ ...clean, draft: withGrant(clean.draft, "crm", { mode: "off", picked: null }) }),
    ).toBe(false);
  });
});

describe("the pixel office: people, their words and their ways", () => {
  const t = (n: number) => fixture.teammates[n]!;
  const ev = (
    seq: number,
    type: string,
    actor: { kind: string; id: string } | null,
    payload: object,
    subject?: object,
  ) =>
    ({
      id: `e${seq}`,
      companyId: fixture.company.id,
      seq,
      type,
      actor,
      subject: subject ?? { kind: "task", id: fixture.tasks[0]!.id },
      payload,
      createdAt: new Date(Date.UTC(2026, 8, 12, 4, seq)).toISOString(),
    }) as CompanyData["events"][number];
  const talk: CompanyData = {
    ...fixture,
    reviews: [reviewFixture],
    events: [
      ev(
        17,
        "goal.questions",
        { kind: "teammate", id: t(0).id },
        {
          title: "Digest",
          managerName: "Peter",
          questions: ["Which channel?", "What time?"],
        },
      ),
      ev(
        16,
        "approval.proposed",
        { kind: "teammate", id: t(1).id },
        {
          number: 142,
          title: "Create a HubSpot list",
          teammateId: t(1).id,
          taskId: fixture.tasks[0]!.id,
        },
      ),
      ev(
        15,
        "decision.logged",
        { kind: "teammate", id: t(1).id },
        { number: 142, decision: "Map by node id." },
      ),
      ev(
        14,
        "review.commented",
        { kind: "teammate", id: t(2).id },
        { number: 146, action: "resolved" },
        {
          kind: "review",
          id: reviewFixture.id,
        },
      ),
      ev(
        13,
        "review.commented",
        { kind: "teammate", id: t(2).id },
        { number: 146, preview: "Say **which** timezone.", file: "requirements.md", line: 18 },
        { kind: "review", id: reviewFixture.id },
      ),
      ev(
        12,
        "message.posted",
        { kind: "user", id: fixture.members[0]!.userId },
        {
          number: 142,
          authorName: "Daniel",
          preview: "Ship it   when green.",
          mentions: [],
        },
      ),
      ev(
        11,
        "message.posted",
        { kind: "teammate", id: t(0).id },
        {
          number: 142,
          preview: "@cody can you take `#142` next?",
          mentions: [{ id: t(1).id, handle: "cody", name: "Cody" }],
        },
      ),
      ev(10, "task.created", { kind: "teammate", id: t(0).id }, { number: 142 }),
    ],
  };

  it("a person is 24 rows of 16 in every hair style, view and frame, and looks the same every time", () => {
    for (const style of HAIR_STYLES)
      for (const view of ["down", "up", "right", "left"] as const)
        for (const frame of ["stand", "walkA", "walkB", "sit", "typeA", "typeB", "rest"] as const) {
          const rows = characterRows(style, view, frame);
          expect(rows).toHaveLength(24);
          for (const row of rows) expect(row).toMatch(/^[.kestmhglcdwpqb]{16}$/);
        }
    // Seated at a desk the chair hides the legs; walking moves them.
    expect(
      characterRows("short", "up", "typeA")
        .slice(18)
        .every((r) => /^\.+$/.test(r)),
    ).toBe(true);
    expect(characterRows("short", "down", "walkA")).not.toEqual(characterRows("short", "down", "stand"));
    expect(lookFor(123, "#4f6bd8")).toEqual(lookFor(123, "#4f6bd8"));
    expect(lookFor(123, "#4f6bd8").shirt[0]).toBe("#4f6bd8");
    expect(carpetOf("#e8eef9")[1]).toMatch(/^hsl\(\d+ \d+% 64%\)$/);
  });

  it("what teammates say comes from the event stream, oldest first, with who it is said to", () => {
    const lines = dialogueLines(talk);
    expect(lines.map((l) => l.kind)).toEqual([
      "mention",
      "message",
      "comment",
      "decision",
      "ask",
      "question",
    ]);
    const [ask, said, comment, decision, approval, question] = lines;
    expect(ask).toMatchObject({ speaker: t(0).id, to: [{ id: t(1).id, name: "Cody" }], number: 142 });
    expect(ask!.text).toBe("@cody can you take #142 next?");
    // A person is "you" at your desk, by the name they posted under; words are one clean line.
    expect(said).toMatchObject({ speaker: "you", speakerName: "Daniel", text: "Ship it when green." });
    // A review comment is said to the author, at its place in the change; a resolved one says nothing.
    expect(comment).toMatchObject({ speaker: t(2).id, to: [{ name: "Brody" }], where: "requirements.md:18" });
    expect(comment!.text).toBe("Say which timezone.");
    expect(decision).toMatchObject({ speaker: t(1).id, to: [], text: "Map by node id." });
    expect(approval).toMatchObject({ to: [{ id: "you" }], text: "Create a HubSpot list" });
    expect(question!.text).toBe("Which channel? (+1 more)");
    expect(plainText("## Plan\n```ts\nx\n```")).toBe("Plan x");
    expect(shortAge("2026-09-12T04:00:00.000Z", Date.parse("2026-09-12T06:10:00.000Z"))).toBe("2h");
  });

  it("lines are said one after another: new ones first, one bubble per speaker, a few at a time", () => {
    const lines = dialogueLines(talk);
    const here = () => true;
    let s = newStage(lines, 0);
    s = stepStage(s, lines, 0, here);
    expect(s.playing).toHaveLength(0); // a beat before anyone speaks
    s = stepStage(s, lines, 1000, here);
    // Nothing new: the last few are replayed from the oldest.
    expect(s.playing.map((p) => [p.key, p.replay])).toEqual([["e11", true]]);
    expect(s.playing[0]!.until).toBe(1000 + lineDuration(lines[0]!.text));
    // Something new is said next, before the replay goes on.
    const fresh = [...lines, { ...lines[1]!, key: "new", seq: 99, speaker: t(3).id }];
    s = stepStage(s, fresh, s.nextAt, here);
    expect(s.playing.map((p) => [p.key, p.replay])).toEqual([
      ["e11", true],
      ["new", false],
    ]);
    // A speaker who is not in the room is passed over; one who is talking is waited for.
    let q = newStage(lines, 0);
    q = stepStage(q, lines, 1000, (sp) => sp !== t(0).id);
    expect(q.playing.map((p) => p.key)).toEqual([]);
    q = stepStage(q, lines, 1000, (sp) => sp !== t(0).id);
    expect(q.playing.map((p) => p.key)).toEqual(["e12"]);
    let r = newStage(lines, 0);
    for (let now = 1000; now < 20000; now += 250) {
      r = stepStage(r, lines, now, here);
      expect(r.playing.length).toBeLessThanOrEqual(STAGE_MAX);
      expect(new Set(r.playing.map((p) => p.speaker)).size).toBe(r.playing.length);
    }
  });

  it("Peter keeps reception, between your office and everyone else", () => {
    const peter = fixture.teammates.find((t) => t.handle === "peter")!;
    // The board's rule: handle peter, else the first whose role says project manager.
    expect(companyManager(fixture.teammates)).toBe(peter.id);
    const pms = fixture.teammates.map((t) => (t.id === peter.id ? { ...t, handle: "pete" } : t));
    const later = {
      ...fixture.teammates[1]!,
      id: "pm2",
      handle: "pm2",
      role: "Project Manager",
      createdAt: "2027-01-01T00:00:00.000Z",
    };
    expect(companyManager([...pms, later])).toBe(peter.id);
    expect(companyManager(fixture.teammates.filter((t) => t.id !== peter.id))).toBeNull();
    const L = officeLayout(fixture, "all");
    expect(L.areas.slice(0, 4).map((a) => a.kind)).toEqual(["office", "reception", "kitchen", "lounge"]);
    const reception = L.areas[1]!;
    const seat = seatOf(L, peter.id)!;
    expect(seat).toMatchObject({ front: true, home: "reception" });
    expect(inRoom(reception, seat.x, seat.y)).toBe(true);
    // Nobody else keeps a desk in reception, and Peter is not at one in Engineering.
    expect(L.rooms[0]!.desks.map((d) => d.id)).not.toContain(peter.id);
    // Whoever waits on you stands in front of your desk first, then takes the bench, then stands in reception.
    expect(L.visitors.map((v) => `${L.areas.find((a) => inRoom(a, v.x, v.y))!.kind}:${v.pose}`)).toEqual([
      "office:stand",
      "office:stand",
      "reception:sit",
      "reception:sit",
      "reception:stand",
      "reception:stand",
    ]);
    // The board on the reception wall.
    expect(L.props.some((p) => p.kind === "taskBoard" && inRoom(reception, p.x, p.y))).toBe(true);
  });

  it("everyone can walk from their desk to yours, to the kitchen and to the lounge, through the doors", () => {
    const third = {
      ...fixture.departments[1]!,
      id: "d3",
      slug: "growth",
      name: "Growth",
      leadTeammateId: null,
      members: [],
    };
    const three = { ...fixture, departments: [...fixture.departments, third] };
    for (const [data, scope] of [
      [fixture, "all"],
      [fixture, fixture.departments[0]!.id],
      [three, "all"],
    ] as const) {
      const L = officeLayout(data, scope);
      const g = walkGrid(L);
      const [office, reception] = L.areas;
      // Your office has one door, and it is from reception: no department opens straight into it.
      const into = L.doors.filter((d) =>
        d.side === "left"
          ? d.at === reception!.x || d.at === office!.x
          : d.x < office!.x + office!.w && d.at > office!.y,
      );
      expect(into).toEqual([expect.objectContaining({ side: "left", at: reception!.x })]);
      // Nothing solid underfoot where people stand to wait on you, and the common rooms have somewhere to go.
      for (const v of L.visitors) if (v.pose === "stand") expect(walkable(g, v)).toBe(true);
      const areas = new Set(L.spots.map((s) => s.area));
      expect([areas.has("kitchen"), areas.has("lounge"), areas.has("reception")]).toEqual([true, true, true]);
      const people = [
        ...L.rooms.flatMap((r) => r.desks.map((d) => ({ id: d.id, d }))),
        { id: L.manager!, d: null },
      ];
      for (const { id, d } of people) {
        const seat = seatOf(L, id)!;
        if (d) expect(seat).toMatchObject({ x: d.x + 16, y: d.y + 31, front: false });
        for (const to of [...L.visitors, L.spots[0]!, L.spots[L.spots.length - 1]!]) {
          const path = findPath(g, seat, to);
          expect(path, `${id} to ${to.x},${to.y}`).not.toBeNull();
          // From a department, the way to your desk is through reception.
          if (d && to === L.visitors[0]) {
            const along = [seat, ...path!].flatMap((p, i, all) => {
              const q = all[i + 1];
              if (!q) return [p];
              const n = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 4);
              return Array.from({ length: n }, (_, k) => ({
                x: p.x + ((q.x - p.x) * k) / n,
                y: p.y + ((q.y - p.y) * k) / n,
              }));
            });
            expect(along.some((p) => inRoom(reception!, p.x, p.y))).toBe(true);
          }
          // Four ways only, and on open floor away from the ends (a walk may cross three cells of a chair or a bench to reach one).
          const corners = path!.slice(0, -1);
          corners
            .slice(1)
            .forEach((p, i) => expect(p.x === corners[i]!.x || p.y === corners[i]!.y).toBe(true));
          const far = (p: { x: number; y: number }, q: { x: number; y: number }) =>
            Math.abs(p.x - q.x) > 14 || Math.abs(p.y - q.y) > 14;
          expect(corners.filter((p) => far(p, seat) && far(p, to)).every((p) => walkable(g, p))).toBe(true);
        }
      }
    }
    // Walls are walls: straight across from one room into the next is not open floor.
    const L = officeLayout(fixture, "all");
    const [eng, res] = L.rooms;
    expect(walkable(walkGrid(L), { x: res!.x - 3, y: eng!.y + 60 })).toBe(false);
  });

  it("the conversation list says who said what to whom, and the empty office says how it fills", () => {
    const html = render(
      <OfficeView
        data={talk}
        liveRuns={[]}
        meName="Daniel"
        initialMode="map"
        onOpenTask={noop}
        onOpenTeammate={noop}
        onOpenDepartmentBoard={noop}
        onGoApprovals={noop}
      />,
    );
    expect(html).toContain("Conversations");
    expect(html).toContain("can you take #142 next?");
    expect(html).toContain('<b class="at">@cody</b>');
    expect(html).toContain("review comment");
    expect(html).toContain("requirements.md:18");
    expect(html).toContain("asks you to approve");
    const quiet = render(
      <OfficeView
        data={fixture}
        liveRuns={[]}
        meName="Daniel"
        onOpenTask={noop}
        onOpenTeammate={noop}
        onOpenDepartmentBoard={noop}
        onGoApprovals={noop}
      />,
    );
    expect(quiet).toContain("Nobody has said anything here yet.");
    expect(quiet).toContain('aria-label="Pixel office"');
  });
});
