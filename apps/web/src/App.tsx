// Binds the store to the views. Views are pure; everything that talks to the
// board lives here.
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Client } from "./api/client.ts";
import type { AuthProviders, Features, TeammateTemplate } from "./api/types.ts";
import { Shell } from "./components/Shell.tsx";
import { Empty } from "./components/ui.tsx";
import {
  CreateCompanyModal,
  CreateDepartmentModal,
  CreateProjectModal,
  CreateTaskModal,
  DesignCompanyModal,
  HireTeammateModal,
  NewGoalModal,
} from "./modals/index.tsx";
import { useApp } from "./state/store.tsx";
import { ActivityView } from "./views/ActivityView.tsx";
import { afterRejectionText, ApprovalsView } from "./views/ApprovalsView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { CompanyView } from "./views/CompanyView.tsx";
import { CostsView } from "./views/CostsView.tsx";
import { OfficeView } from "./views/OfficeView.tsx";
import { ReviewsView } from "./views/ReviewsView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { useLiveRuns } from "./views/WorkingNow.tsx";
import { DepartmentsView, nextCellState, type CellState } from "./views/DepartmentsView.tsx";
import { LoginView } from "./views/Login.tsx";
import { TeammatesView } from "./views/TeammatesView.tsx";

type ModalKind =
  | null
  | { kind: "company" }
  | { kind: "project" }
  | { kind: "department" }
  | { kind: "task" }
  | { kind: "goal" }
  | { kind: "design" }
  | { kind: "hire"; templates: TeammateTemplate[] };

/** What went wrong on the way back from an authorization server, in the person's terms, with the server's own error code when it gave one. */
export function oauthErrorText(code: string, detail: string | null = null): string {
  const said = detail ? ` The server said: ${detail}.` : "";
  switch (code) {
    case "denied":
      return "You declined the authorisation; the connection stays unauthorised.";
    case "state":
      return "That authorisation took too long or was started elsewhere; press Authorise again.";
    case "forbidden":
      return "You may not manage this company's connections.";
    case "moved":
      return "The connection's server moved to another authorization server while you were authorising; press Authorise again.";
    case "token":
      return `The authorization server did not issue a token; press Authorise again.${said}`;
    default:
      return `The authorization server refused; the board's log says why.${said}`;
  }
}

/**
 * Asks the board what it offers this company, and returns what stops a late answer landing. The private
 * destinations given to the last company are not this one's, so they go first, even if the board cannot be asked.
 */
export function loadFeatures(
  client: Pick<Client, "features">,
  companyId: string | null,
  set: Dispatch<SetStateAction<Features>>,
): () => void {
  let alive = true;
  set((f) => ({ ...f, privateDestinations: undefined, companyPrivateDestinations: undefined }));
  client
    .features(companyId ?? undefined)
    .then((f) => alive && set(f))
    .catch(() => undefined);
  return () => {
    alive = false;
  };
}

export function App() {
  const app = useApp();
  const [modal, setModal] = useState<ModalKind>(null);
  const { data, ui, companyId, client, run, refresh, go, setUi, me } = app;
  const meId = me?.user?.id;
  // The sign-in page asks the board what is on offer; the board redirects back with ?auth_error= on a refusal.
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const authError = new URLSearchParams(window.location.search).get("auth_error");
  // What the board offers (a secret store for OAuth, an object store), asked once signed in.
  const [features, setFeatures] = useState<Features>({ oauth: false, objectStore: false });
  useEffect(() => {
    if (!me) return;
    return loadFeatures(client, companyId, setFeatures);
  }, [client, me, companyId]);
  // An OAuth authorisation comes back to the root with ?oauth=<connection> or ?oauth_error=<code>.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const done = q.get("oauth");
    const failed = q.get("oauth_error");
    if (!done && !failed) return;
    if (done) app.toast(`${done} is authorised.`);
    else app.toast(oauthErrorText(failed ?? "", q.get("oauth_detail")), "bad");
    q.delete("oauth");
    q.delete("oauth_error");
    q.delete("oauth_detail");
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);
  useEffect(() => {
    if (!app.authChecked || me) return;
    let alive = true;
    client
      .authProviders()
      .then((p) => alive && setProviders(p))
      .catch(() => alive && setProviders({ devLogin: false, oidc: null }));
    return () => {
      alive = false;
    };
  }, [app.authChecked, me, client]);

  // Deciding a proposed write, from the Approvals page or a task's drawer.
  const approveApproval = async (id: string, note?: string) => {
    const r = await run(() => client.approveApproval(cid, id, note));
    app.toast(
      r.status === "executed"
        ? `Approved and executed${r.restarted.runId ? `; ${r.teammate?.name ?? "the teammate"} continues.` : r.restarted.reason ? `. ${r.restarted.reason}.` : "."}`
        : `Approved, but the send failed: ${r.error ?? "no reason recorded"}`,
      r.status === "executed" ? "ok" : "bad",
    );
    await refresh();
  };
  const rejectApproval = async (id: string, note?: string) => {
    const r = await run(() => client.rejectApproval(cid, id, note));
    app.toast(`Rejected. ${afterRejectionText(r.afterRejection)}`);
    await refresh();
  };
  const loadMessages = useCallback(
    (taskId: string) => (companyId ? client.messages(companyId, taskId) : Promise.resolve([])),
    [client, companyId],
  );

  const loadRuns = useCallback(
    (taskId: string) => (companyId ? client.runs(companyId, taskId) : Promise.resolve([])),
    [client, companyId],
  );
  const loadRun = useCallback((runId: string) => client.run(companyId!, runId), [client, companyId]);
  const loadArtifacts = useCallback(
    (taskId: string) => (companyId ? client.taskArtifacts(companyId, taskId) : Promise.resolve([])),
    [client, companyId],
  );
  const loadInbox = useCallback(
    (teammateId: string) =>
      companyId
        ? client.teammateInbox(companyId, teammateId)
        : Promise.resolve({ since: null, unread: 0, items: [] }),
    [client, companyId],
  );
  const loadArtifact = useCallback(
    (runId: string, artifactId: string) => client.artifact(companyId!, runId, artifactId),
    [client, companyId],
  );
  const loadDeliverable = useCallback(
    (taskId: string) => client.taskDeliverable(companyId!, taskId),
    [client, companyId],
  );

  const loadReview = useCallback(
    (reviewId: string) => client.review(companyId!, reviewId),
    [client, companyId],
  );
  const loadCosts = useCallback(
    (window: "day" | "week" | "month") => client.costs(companyId!, window),
    [client, companyId],
  );
  const loadMonthly = useCallback(
    (month: string) => client.monthlyCosts(companyId!, month),
    [client, companyId],
  );
  const loadLive = useCallback(
    () => client.runsByStatus(companyId!, ["queued", "running", "interrupted"]),
    [client, companyId],
  );
  // Refresh the live panel whenever a run event lands; poll while something runs.
  const runEventSeq = data?.events.find((e) => e.type.startsWith("run."))?.seq ?? 0;
  const liveRuns = useLiveRuns(companyId ? loadLive : null, runEventSeq);

  useEffect(() => {
    document.title = data ? `${data.company.name} · RosterDock` : "RosterDock";
  }, [data]);

  if (!app.authChecked) return <Empty>Loading…</Empty>;
  if (!me) {
    return (
      <LoginView
        providers={providers}
        error={authError}
        onLogin={async (email, name) => {
          await run(() => client.devLogin(email, name || undefined));
          await app.reloadSession();
        }}
      />
    );
  }

  const cid = companyId!;
  const open = (id: string) =>
    setUi({ view: "board", selectedTaskId: id, departmentId: "all", projectId: "all" });
  const openReview = (reviewId: string) => setUi({ view: "reviews", selectedReviewId: reviewId });
  const openTaskReview = (taskId: string) => {
    const r = data?.reviews.find((x) => x.taskId === taskId);
    if (r) openReview(r.id);
    else app.toast("No review yet. One opens when the assignee's run finishes.", "bad");
  };
  const refuseDone = (taskId: string) => {
    const r = data?.reviews.find((x) => x.taskId === taskId);
    app.toast(
      r
        ? "A task reaches Done through its approved review. Opening it."
        : "A task reaches Done only through an approved review.",
      "bad",
    );
    if (r) openReview(r.id);
  };
  const openFromSentence = (go: { taskId?: string; reviewId?: string; view?: string } | undefined) => {
    if (go?.view === "approvals") setUi({ view: "approvals" });
    else if (go?.reviewId) openReview(go.reviewId);
    else if (go?.taskId) open(go.taskId);
  };

  const body = !data ? (
    app.companies.length === 0 ? (
      <Empty>
        <div className="flex flex-col items-center gap-3">
          <span>No company yet.</span>
          {me.mayCreateCompany === false ? (
            <span className="hint">
              Ask an owner to invite {me.user?.email ?? "you"} to their company. Who may create one on this
              board is the operator&apos;s call.
            </span>
          ) : (
            <button className="btn primary" onClick={() => setModal({ kind: "company" })}>
              Create your first company
            </button>
          )}
        </div>
      </Empty>
    ) : (
      <Empty>Loading {app.companies.find((c) => c.id === companyId)?.name ?? "company"}…</Empty>
    )
  ) : ui.view === "company" ? (
    <CompanyView
      data={data}
      meId={meId}
      liveRuns={liveRuns}
      onNewProject={() => setModal({ kind: "project" })}
      onNewTask={() => setModal({ kind: "task" })}
      onNewDepartment={() => setModal({ kind: "department" })}
      onNewGoal={() => setModal({ kind: "goal" })}
      onAnswerGoal={async (goalId, answers) => {
        const g = await run(() => client.answerGoal(cid, goalId, answers));
        app.toast(
          g.status === "active"
            ? `Peter split it into ${g.tasks.length} tasks.`
            : g.status === "needs_you"
              ? "Peter has more questions."
              : "Answered.",
        );
        await refresh();
      }}
      onStopGoal={async (goalId) => {
        await run(() => client.stopGoal(cid, goalId), "Goal dropped.");
        await refresh();
      }}
      onUpdateGoalCaps={async (goalId, caps) => {
        await run(() => client.updateGoalCaps(cid, goalId, caps), "Caps changed.");
        await refresh();
      }}
      goalResults={{
        load: (goalId) => client.goalResult(cid, goalId),
        loadArtifact,
        zipUrl: (goalId) => client.goalResultZipUrl(cid, goalId),
        downloadUrl: (runId, artifactId) => client.artifactDownloadUrl(cid, runId, artifactId),
      }}
      canDecide={data.company.role === "owner" || data.company.role === "admin"}
      onDesign={() => setModal({ kind: "design" })}
      onAudit={async () => {
        const d = await run(() => client.auditCompany(cid));
        app.toast(`Peter looked: ${(d.proposal as { summary: string }).summary}`);
        await refresh();
      }}
      onAcceptDraft={async (d) => {
        const r = await run(() => client.acceptDraft(cid, d.id));
        app.toast(
          r.kind === "org"
            ? `Created ${r.outcome?.departments.length ?? 0} departments and ${r.outcome?.teammates.length ?? 0} teammates.`
            : "Noted.",
        );
        await refresh();
      }}
      onRejectDraft={async (d) => {
        await run(() => client.rejectDraft(cid, d.id), "Draft declined.");
        await refresh();
      }}
      onOpenProject={(id) =>
        setUi({ view: "board", projectId: id, departmentId: "all", selectedTaskId: null })
      }
      onOpenDepartmentBoard={(id) => setUi({ view: "board", departmentId: id, selectedTaskId: null })}
      onOpenTask={open}
      onOpenReview={openReview}
      onOpenTeammate={(id) => setUi({ view: "team", selectedTeammateId: id })}
      onGoActivity={() => go("activity")}
    />
  ) : ui.view === "board" ? (
    <BoardView
      data={data}
      meId={meId}
      projectId={ui.projectId}
      departmentId={ui.departmentId}
      selectedTaskId={ui.selectedTaskId}
      onFilterProject={(id) => setUi({ projectId: id, selectedTaskId: null })}
      onFilterDepartment={(id) => setUi({ departmentId: id })}
      onSelectTask={(id) => setUi({ selectedTaskId: id })}
      onNewTask={() => setModal({ kind: "task" })}
      onMove={async (id, input) => {
        await run(() => client.moveTask(cid, id, input));
        await refresh();
      }}
      onRefuseDone={refuseDone}
      onOpenReview={openTaskReview}
      onAssign={async (id, assignee) => {
        await run(() => client.updateTask(cid, id, { assignee }));
        await refresh();
      }}
      onSetDepartment={async (id, departmentId) => {
        await run(() => client.updateTask(cid, id, { departmentId }));
        await refresh();
      }}
      loadMessages={loadMessages}
      onPostMessage={async (id, text) => {
        await run(() => client.postMessage(cid, id, text));
        await refresh();
      }}
      loadRuns={loadRuns}
      loadRun={loadRun}
      loadArtifacts={loadArtifacts}
      loadArtifact={loadArtifact}
      loadDeliverable={loadDeliverable}
      downloadUrl={(runId, artifactId) => client.artifactDownloadUrl(cid, runId, artifactId)}
      onStartRun={async (id) => {
        await run(() => client.startRun(cid, id), "Run queued");
        await refresh();
      }}
      onStopRun={async (id) => {
        await run(() => client.stopRun(cid, id), "Stop requested");
        await refresh();
      }}
      canDecide={data.company.role === "owner" || data.company.role === "admin"}
      onApprove={approveApproval}
      onReject={rejectApproval}
      canCancel={data.company.role === "owner" || data.company.role === "admin"}
      onCancel={async (id, note) => {
        await run(() => client.cancelTask(cid, id, note), "Task cancelled");
        await refresh();
      }}
      onReopen={async (id) => {
        await run(() => client.reopenTask(cid, id), "Task reopened");
        await refresh();
      }}
    />
  ) : ui.view === "org" ? (
    <DepartmentsView
      data={data}
      onNewDepartment={() => setModal({ kind: "department" })}
      onDesign={() => setModal({ kind: "design" })}
      onHire={async () => setModal({ kind: "hire", templates: await run(() => client.templates(cid)) })}
      onOpenBoard={(id) => setUi({ view: "board", departmentId: id, selectedTaskId: null })}
      {...(data.company.role === "owner" || data.company.role === "admin"
        ? {
            onSaveWebDomains: async (id: string, webDomains: string[]) => {
              const d = data.departments.find((x) => x.id === id);
              if (!d) return;
              const { webDomains: _, ...sandbox } = d.sandbox ?? {};
              await run(
                () =>
                  client.updateDepartment(cid, id, {
                    sandbox: webDomains.length ? { ...sandbox, webDomains } : sandbox,
                  }),
                webDomains.length
                  ? `${d.name}'s runs read the web only within ${webDomains.join(", ")}.`
                  : `${d.name}'s runs read the company's web sites.`,
              );
              await refresh();
            },
          }
        : {})}
      onDissolve={async (id) => {
        const d = data.departments.find((x) => x.id === id);
        if (!d || !window.confirm(`Dissolve ${d.name}? Teammates keep their toolboxes.`)) return;
        await run(() => client.deleteDepartment(cid, id), `${d.name} dissolved`);
        await refresh();
      }}
      onCycleCell={async (departmentId, teammateId, from: CellState) => {
        const d = data.departments.find((x) => x.id === departmentId);
        const t = data.teammates.find((x) => x.id === teammateId);
        if (!d || !t) return;
        const to = nextCellState(from);
        if (to === "member")
          await run(
            () => client.setDepartmentMember(cid, departmentId, teammateId, false),
            `${t.name} added to ${d.name}`,
          );
        else if (to === "lead")
          await run(
            () => client.setDepartmentMember(cid, departmentId, teammateId, true),
            `${t.name} now leads ${d.name}`,
          );
        else
          await run(
            () => client.removeDepartmentMember(cid, departmentId, teammateId),
            `${t.name} removed from ${d.name}`,
          );
        await refresh();
      }}
    />
  ) : ui.view === "team" ? (
    <TeammatesView
      data={data}
      selectedId={ui.selectedTeammateId}
      onSelect={(id) => setUi({ selectedTeammateId: id })}
      onHire={async () => setModal({ kind: "hire", templates: await run(() => client.templates(cid)) })}
      onSave={async (id, input) => {
        await run(() => client.updateTeammate(cid, id, input), "Saved. Changes apply on the next run.");
        await refresh();
      }}
      loadInbox={loadInbox}
    />
  ) : ui.view === "activity" ? (
    <ActivityView data={data} meId={meId} onOpen={openFromSentence} />
  ) : ui.view === "reviews" ? (
    <ReviewsView
      data={data}
      meId={meId}
      role={data.company.role}
      selectedId={ui.selectedReviewId}
      onSelect={(id) => setUi({ selectedReviewId: id })}
      loadReview={loadReview}
      onComment={async (id, input) => {
        await run(() => client.addReviewComment(cid, id, input));
        await refresh();
      }}
      onResolve={async (id, commentId) => {
        await run(() => client.resolveReviewComment(cid, id, commentId));
        await refresh();
      }}
      onScore={async (id, scores) => {
        await run(() => client.scoreReview(cid, id, { scores }), "Scores saved.");
        await refresh();
      }}
      onApprove={async (id, summary) => {
        const r = await run(() => client.approveReview(cid, id, summary));
        const pr = r.pullRequests[0];
        app.toast(
          pr?.status === "opened"
            ? `Approved. Pull request #${pr.number} opened; merging needs you.`
            : pr?.status === "failed"
              ? `Approved and Done, but the pull request could not be opened: ${pr.error}`
              : `Approved. #${r.taskNumber} is Done.`,
          pr?.status === "failed" ? "bad" : "ok",
        );
        await refresh();
      }}
      onRequestChanges={async (id, summary) => {
        const r = (await run(() => client.requestChanges(cid, id, summary))) as {
          author: { name: string | null };
          restarted?: { runId: string | null; reason: string | null };
        };
        app.toast(
          r.restarted?.runId
            ? `Sent back to ${r.author.name ?? "the author"}; they are working on it.`
            : `Changes requested. ${r.restarted?.reason ?? "The author was not restarted."}`,
          r.restarted?.runId ? "ok" : "bad",
        );
        await refresh();
      }}
      onAssignReviewer={async (id, reviewer) => {
        const r = await run(() => client.assignReviewer(cid, id, reviewer));
        app.toast(
          r.reviewer
            ? r.started?.runId
              ? `${r.reviewer.name} is reviewing #${r.taskNumber} now.`
              : `#${r.taskNumber} is ${r.reviewer.name}'s to review.`
            : `Nobody is assigned to #${r.taskNumber}; people decide.`,
        );
        await refresh();
      }}
      onVeto={async (id, note) => {
        await run(() => client.vetoReview(cid, id, note), "Approval vetoed; the task is back in review.");
        await refresh();
      }}
      onOpenTask={open}
    />
  ) : ui.view === "approvals" ? (
    <ApprovalsView
      data={data}
      canDecide={data.company.role === "owner" || data.company.role === "admin"}
      onApprove={approveApproval}
      onReject={rejectApproval}
      onOpenTask={open}
    />
  ) : ui.view === "office" ? (
    <OfficeView
      data={data}
      liveRuns={liveRuns}
      meName={me.user?.name ?? "You"}
      onOpenTask={open}
      onOpenTeammate={(id) => setUi({ view: "team", selectedTeammateId: id })}
      onOpenDepartmentBoard={(id) =>
        setUi({ view: "board", departmentId: id, projectId: "all", selectedTaskId: null })
      }
      onGoApprovals={() => setUi({ view: "approvals" })}
      canEdit={data.company.role === "owner" || data.company.role === "admin"}
      onSaveOffice={async (office) => {
        await run(() => client.updateCompany(cid, { settings: { ...data.company.settings, office } }));
      }}
      onPutImage={async (name, file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await run(() => client.putOfficeImage(cid, name, btoa(bin)), `${file.name} is in the office`);
      }}
      onDeleteImage={async (name) => {
        await run(() => client.deleteOfficeImage(cid, name));
      }}
      imageUrl={(name, sha256) => client.officeImageUrl(cid, name, sha256)}
    />
  ) : ui.view === "costs" ? (
    <CostsView
      data={data}
      loadCosts={loadCosts}
      loadMonthly={loadMonthly}
      usageCsvUrl={(window) => client.usageCsvUrl(cid, window)}
      chargebackCsvUrl={(month) => client.chargebackCsvUrl(cid, month)}
      onOpenTeammate={(id) => setUi({ view: "team", selectedTeammateId: id })}
      onOpenProject={(id) =>
        setUi({ view: "board", projectId: id, departmentId: "all", selectedTaskId: null })
      }
      onOpenSettings={() => setUi({ view: "settings", settingsTab: "prices" })}
    />
  ) : (
    <SettingsView
      data={data}
      canEdit={data.company.role === "owner" || data.company.role === "admin"}
      tab={ui.settingsTab}
      onTab={(settingsTab) => setUi({ settingsTab })}
      loadPrices={() => client.prices(cid)}
      savePrice={(input) => run(() => client.savePrice(cid, input), "Price saved.")}
      deletePrice={(id) => run(() => client.deletePrice(cid, id), "Price removed.")}
      fillListPrices={() => run(() => client.fillListPrices(cid))}
      loadBudgets={() => client.budgets(cid)}
      saveBudget={(input) => run(() => client.saveBudget(cid, input), "Budget set.")}
      deleteBudget={(id) => run(() => client.deleteBudget(cid, id), "Budget removed.")}
      models={{
        features,
        load: () => client.modelProviders(cid),
        loadSecrets: () => client.secrets(cid),
        setSecret: (name, value) => run(() => client.setNewSecret(cid, name, value), `${name} set.`),
        replaceSecret: (name, value) => run(() => client.setSecret(cid, name, value), `${name} set.`),
        checkNew: (input) => run(() => client.checkNewModelProvider(cid, input)),
        create: (input) => run(() => client.createModelProvider(cid, input), `${input.label} added.`),
        update: (id, input) => run(() => client.updateModelProvider(cid, id, input)),
        remove: (id) => run(() => client.deleteModelProvider(cid, id), "Provider removed."),
      }}
      connections={{
        loadCatalog: () => client.catalog(),
        features,
        startOAuth: (id) => run(() => client.startOAuth(cid, id)),
        loadSecrets: () => client.secrets(cid),
        setSecret: (name, value) => run(() => client.setSecret(cid, name, value), `${name} set.`),
        deleteSecret: (name) => run(() => client.deleteSecret(cid, name), `${name} removed.`),
        createConnection: async (input) => {
          const c = await run(
            () => client.createConnection(cid, input),
            input.kind === "web"
              ? `${input.name} added. Grant it in a teammate's toolbox.`
              : `${input.name} added. Discover its tools.`,
          );
          await refresh();
          return c;
        },
        previewOpenApi: (spec) => client.previewOpenApi(cid, spec),
        createOpenApiConnection: async (input) => {
          const c = await run(() => client.createOpenApiConnection(cid, input), `${input.name} added.`);
          await refresh();
          return c;
        },
        updateConnection: async (id, input) => {
          const c = await run(() => client.updateConnection(cid, id, input));
          await refresh();
          return c;
        },
        checkConnection: async (id) => {
          const c = await run(() => client.checkConnection(cid, id));
          app.toast(
            c.lastCheck?.ok
              ? `${c.name} answered in ${c.lastCheck.latencyMs} ms.`
              : `${c.name}: ${c.lastCheck?.error ?? "no answer"}`,
          );
          await refresh();
          return c;
        },
        discoverConnection: async (id) => {
          const c = await run(() => client.discoverConnection(cid, id));
          app.toast(
            `${c.name}: ${c.tools.length} tools, ${c.tools.filter((t) => t.write).length} of them writes.`,
          );
          await refresh();
          return c;
        },
        deleteConnection: async (id) => {
          await run(() => client.deleteConnection(cid, id), "Connection removed.");
          await refresh();
        },
      }}
      saveClientPolicy={async (projectId, policy) => {
        await run(
          () => client.updateProject(cid, projectId, { clientPolicy: policy }),
          "Client policy saved.",
        );
        await refresh();
      }}
      saveNotifySettings={async (notify) => {
        const names = [notify.webhookEnvName, notify.email?.smtpUrlEnvName].filter(Boolean);
        await run(
          () => client.updateCompany(cid, { settings: { ...data.company.settings, notify } }),
          names.length
            ? `Notifications go through ${names.join(" and ")}.`
            : "Notifications use the board's defaults.",
        );
        await refresh();
      }}
      testNotify={() => client.testNotify(cid)}
      loadPlanner={(refresh) => client.planner(cid, refresh)}
      loadStyles={() => client.styles(cid)}
      setStyle={async (pack, input) => {
        const packs = await run(
          () => client.setStyle(cid, pack, input),
          input.enabled ? "House style saved." : "House style switched off.",
        );
        await refresh();
        return packs;
      }}
      savePlanner={async (planner) => {
        await run(
          () => client.updateCompany(cid, { settings: { ...data.company.settings, planner } }),
          "Saved how Peter thinks.",
        );
        await refresh();
      }}
      saveDriftSettings={async (drift) => {
        await run(
          () => client.updateCompany(cid, { settings: { ...data.company.settings, drift } }),
          "Drift thresholds saved.",
        );
        await refresh();
      }}
      templatesExportUrl={client.templatesExportUrl(cid)}
      importTemplates={async (file) => {
        const report = await run(() => client.importTemplates(cid, file));
        await refresh();
        return report;
      }}
    />
  );

  return (
    <>
      <Shell
        companies={app.companies}
        company={data?.company ?? null}
        view={ui.view}
        counts={{
          reviews: data?.reviews.filter((r) => r.status === "open").length ?? 0,
          approvals: data?.approvals.filter((a) => a.status === "pending").length ?? 0,
        }}
        userName={me.user?.name ?? me.teammate?.name ?? "You"}
        userRole={data?.company.role ?? "member"}
        onNavigate={(view) =>
          setUi({
            view,
            selectedTaskId: view === "board" ? ui.selectedTaskId : null,
            selectedReviewId: view === "reviews" ? ui.selectedReviewId : null,
          })
        }
        onSelectCompany={app.selectCompany}
        onCreateCompany={() => setModal({ kind: "company" })}
        canCreateCompany={me.mayCreateCompany}
        onSignOut={() => {
          void client.logout().then((r) => window.location.assign(r.signOutUrl ?? "/"));
        }}
        onToggleTheme={app.toggleTheme}
      >
        {body}
      </Shell>
      {modal?.kind === "company" ? (
        <CreateCompanyModal
          onClose={() => setModal(null)}
          onCreate={async (input) => {
            const co = await run(
              () => client.createCompany(input),
              `${input.name} created. Hire teammates and open a project.`,
            );
            setModal(null);
            await app.reloadSession();
            app.selectCompany(co.id);
          }}
        />
      ) : null}
      {modal?.kind === "project" && data ? (
        <CreateProjectModal
          onClose={() => setModal(null)}
          onCreate={async (input) => {
            const pr = await run(
              () => client.createProject(cid, { ...input, goal: "", defaultBranch: "main" }),
              `${input.name} opened`,
            );
            setModal(null);
            await refresh();
            setUi({ view: "board", projectId: pr.id, selectedTaskId: null });
          }}
        />
      ) : null}
      {modal?.kind === "department" && data ? (
        <CreateDepartmentModal
          data={data}
          onClose={() => setModal(null)}
          onCreate={async (input) => {
            await run(() => client.createDepartment(cid, input), `${input.name} created`);
            setModal(null);
            await refresh();
            go("org");
          }}
        />
      ) : null}
      {modal?.kind === "goal" && data ? (
        <NewGoalModal
          data={data}
          onClose={() => setModal(null)}
          onCreate={async (input) => {
            const g = await run(() => client.createGoal(cid, input));
            await refresh();
            return g;
          }}
          onAnswer={async (goalId, answers) => {
            const g = await run(() => client.answerGoal(cid, goalId, answers));
            await refresh();
            return g;
          }}
          onOpenBoard={(projectId) => {
            setModal(null);
            setUi({ view: "board", projectId, departmentId: "all", selectedTaskId: null });
          }}
        />
      ) : null}
      {modal?.kind === "design" && data ? (
        <DesignCompanyModal
          onClose={() => setModal(null)}
          onSubmit={async (brief) => {
            await run(() => client.proposeOrg(cid, brief), "Peter's draft is on the Company page.");
            setModal(null);
            await refresh();
          }}
        />
      ) : null}
      {modal?.kind === "task" && data ? (
        <CreateTaskModal
          data={data}
          defaultProjectId={ui.projectId === "all" ? undefined : ui.projectId}
          defaultDepartmentId={ui.departmentId === "all" ? undefined : ui.departmentId}
          onClose={() => setModal(null)}
          onCreate={async (input) => {
            const t = await run(
              () => client.createTask(cid, input),
              `#? ${input.title} created`.replace("#? ", ""),
            );
            setModal(null);
            await refresh();
            setUi({ view: "board", selectedTaskId: t.id, projectId: "all", departmentId: "all" });
          }}
        />
      ) : null}
      {modal?.kind === "hire" ? (
        <HireTeammateModal
          templates={modal.templates}
          onClose={() => setModal(null)}
          onCreate={async (input) => {
            const t = await run(() => client.createTeammate(cid, input), `${input.name} hired`);
            setModal(null);
            await refresh();
            setUi({ view: "team", selectedTeammateId: t.id });
          }}
        />
      ) : null}
    </>
  );
}
