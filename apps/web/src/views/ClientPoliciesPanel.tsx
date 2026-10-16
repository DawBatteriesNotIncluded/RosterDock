// Client policies: what each project's client lets any teammate do with each
// connection. A matrix of projects by connections; a cell is the cap for that
// pair (or "as granted" to say nothing). Policy only narrows: a cap never
// widens a toolbox.
import { useState } from "react";
import type { ToolMode } from "@rosterdock/shared";
import type { CompanyData, Project } from "../api/types.ts";
import { Button, Pill } from "../components/ui.tsx";

export interface ClientPoliciesPanelProps {
  data: CompanyData;
  canEdit: boolean;
  saveClientPolicy(projectId: string, policy: Project["clientPolicy"]): Promise<void>;
}

export const MODE_LABEL: Record<ToolMode, string> = {
  off: "Off",
  read: "Read only",
  ask: "Reads, writes ask",
};

/** The cell shown for a project and a connection: the cap, or the default, or nothing. */
export function capFor(policy: Project["clientPolicy"], connection: string): ToolMode | "" {
  return policy.caps[connection] ?? "";
}

export function ClientPoliciesPanel(p: ClientPoliciesPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connections = p.data.connections;
  const set = async (
    project: Project,
    patch: (policy: Project["clientPolicy"]) => Project["clientPolicy"],
  ) => {
    setBusy(project.id);
    try {
      await p.saveClientPolicy(project.id, patch(project.clientPolicy));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const select = (
    value: ToolMode | "",
    onChange: (v: ToolMode | "") => void,
    disabled: boolean,
    label: string,
  ) => (
    <select
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as ToolMode | "")}
      style={{ fontSize: 12, padding: "2px 6px" }}
    >
      <option value="">As granted</option>
      <option value="ask">{MODE_LABEL.ask}</option>
      <option value="read">{MODE_LABEL.read}</option>
      <option value="off">{MODE_LABEL.off}</option>
    </select>
  );
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">Client policies</span>
        <span className="hint">
          What each project's client allows with each connection. A cap here only narrows a teammate's
          toolbox; it never widens it. "As granted" says nothing. The default applies to connections without a
          cap.
        </span>
      </div>
      {error ? <Pill tone="bad">{error}</Pill> : null}
      {p.data.projects.length === 0 || connections.length === 0 ? (
        <span className="hint">
          {connections.length === 0 ? "Add a connection first." : "No projects yet."}
        </span>
      ) : (
        <table className="costs">
          <thead>
            <tr>
              <th>Project · client</th>
              <th>Default</th>
              {connections.map((c) => (
                <th key={c.id} className="mono">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.data.projects.map((pr) => (
              <tr key={pr.id}>
                <td>
                  <span className="font-semibold">{pr.name}</span>
                  <span className="hint"> · {pr.client}</span>
                </td>
                <td>
                  {select(
                    pr.clientPolicy.default ?? "",
                    (v) => void set(pr, (pol) => ({ ...pol, default: v === "" ? null : v })),
                    !p.canEdit || busy === pr.id,
                    `${pr.name} default`,
                  )}
                </td>
                {connections.map((c) => (
                  <td key={c.id}>
                    {select(
                      capFor(pr.clientPolicy, c.name),
                      (v) =>
                        void set(pr, (pol) => {
                          const caps = { ...pol.caps };
                          if (v === "") delete caps[c.name];
                          else caps[c.name] = v;
                          return { ...pol, caps };
                        }),
                      !p.canEdit || busy === pr.id,
                      `${pr.name} ${c.name}`,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.canEdit &&
      p.data.projects.some((pr) => pr.clientPolicy.default || Object.keys(pr.clientPolicy.caps).length) ? (
        <div>
          <Button
            size="sm"
            onClick={() => {
              for (const pr of p.data.projects)
                if (pr.clientPolicy.default || Object.keys(pr.clientPolicy.caps).length)
                  void set(pr, () => ({ default: null, caps: {} }));
            }}
          >
            Clear every cap
          </Button>
        </div>
      ) : null}
    </div>
  );
}
