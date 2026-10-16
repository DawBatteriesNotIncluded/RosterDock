// One connection in a teammate's toolbox, tool by tool: read-only tools under
// one header, write tools under another, a control per group and one per row.
// Reads are allowed or never; writes need approval or never (a live write never
// runs without a person). What the person picks is stored as the toolbox line
// the board already understands: a mode on the connection and, when not every
// tool is granted, the names that are.
import type { ToolMode } from "@rosterdock/shared";
import { Ban, Check, ChevronDown, ChevronRight, Hand } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Connection } from "../api/types.ts";
import { Tip } from "../components/ui.tsx";

export interface Grant {
  mode: ToolMode;
  /** The tool names granted, or null for every tool the mode allows. */
  picked: string[] | null;
}

type Tool = Connection["tools"][number];

/** Whether one tool is granted by a toolbox line: named (or every tool), and a write only under ask. */
export function toolGrantedBy(grant: Grant, tool: Pick<Tool, "name" | "write" | "off">): boolean {
  if (grant.mode === "off" || tool.off) return false;
  if (tool.write && grant.mode !== "ask") return false;
  return grant.picked === null || grant.picked.includes(tool.name);
}

/**
 * The toolbox line after turning some tools on or off. The mode follows what is
 * granted (a write granted means ask; only reads means read; nothing means off)
 * and the names collapse to "every tool" when nothing is left out.
 */
export function nextGrant(grant: Grant, tools: Tool[], names: string[], on: boolean): Grant {
  const live = tools.filter((t) => !t.off);
  const granted = new Set(live.filter((t) => toolGrantedBy(grant, t)).map((t) => t.name));
  for (const n of names) {
    if (on) granted.add(n);
    else granted.delete(n);
  }
  const anyWrite = live.some((t) => t.write && granted.has(t.name));
  const mode: ToolMode = anyWrite ? "ask" : granted.size ? "read" : "off";
  if (mode === "off") return { mode, picked: null };
  const expected = live.filter((t) => mode === "ask" || !t.write).map((t) => t.name);
  const every = expected.length === granted.size && expected.every((n) => granted.has(n));
  return { mode, picked: every ? null : live.filter((t) => granted.has(t.name)).map((t) => t.name) };
}

function IconChoice({
  on,
  allowIcon,
  allowText,
  neverText,
  disabled,
  onChange,
}: {
  on: boolean;
  allowIcon: "check" | "hand";
  allowText: string;
  neverText: string;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  const btn = (active: boolean, label: string, icon: ReactNode, value: boolean) => (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={() => onChange(value)}
        className="flex h-6 w-6 items-center justify-center rounded-[5px]"
        style={{
          color: active ? (value ? "var(--accent-ink)" : "var(--bad-ink)") : "var(--muted)",
          background: active ? "var(--surface-2)" : "transparent",
          border: `1px solid ${active ? "var(--border)" : "transparent"}`,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {icon}
      </button>
    </Tip>
  );
  return (
    <span className="flex items-center gap-0.5">
      {btn(on, allowText, allowIcon === "check" ? <Check size={13} /> : <Hand size={13} />, true)}
      {btn(!on, neverText, <Ban size={13} />, false)}
    </span>
  );
}

function ToolGroup({
  title,
  tools,
  write,
  grant,
  onChange,
}: {
  title: string;
  tools: Tool[];
  write: boolean;
  grant: Grant;
  onChange(names: string[], on: boolean): void;
}) {
  const live = tools.filter((t) => !t.off);
  const on = live.filter((t) => toolGrantedBy(grant, t)).length;
  const [open, setOpen] = useState(true);
  const allowText = write ? "Needs approval" : "Always allow";
  const groupValue = on === 0 ? "never" : on === live.length ? "allow" : "some";
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 py-1.5">
        <button
          type="button"
          className="flex items-center gap-1.5 text-[13px] font-semibold"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>
          <span className="tool">{tools.length}</span>
        </button>
        <select
          aria-label={`${title} for every tool`}
          value={groupValue}
          onChange={(e) =>
            onChange(
              live.map((t) => t.name),
              e.target.value === "allow",
            )
          }
          className="ml-auto"
          style={{ fontSize: 12, padding: "3px 6px" }}
        >
          <option value="allow">{allowText}</option>
          {groupValue === "some" ? <option value="some">{`${on} of ${live.length}`}</option> : null}
          <option value="never">Never</option>
        </select>
      </div>
      {open
        ? tools.map((t) => {
            const granted = toolGrantedBy(grant, t);
            return (
              <div
                key={t.name}
                className="flex items-center gap-2 border-t border-border py-1.5 pl-5 text-[12px]"
                title={t.description || t.name}
              >
                <span className="mono" style={{ textDecoration: t.off ? "line-through" : undefined }}>
                  {t.name}
                </span>
                {t.description ? (
                  <span className="truncate text-muted" style={{ maxWidth: 420 }}>
                    {t.description}
                  </span>
                ) : null}
                {t.off ? <span className="text-muted">switched off in Settings</span> : null}
                <span className="ml-auto">
                  <IconChoice
                    on={granted}
                    allowIcon={write ? "hand" : "check"}
                    allowText={write ? `${t.name}: needs approval` : `${t.name}: always allow`}
                    neverText={`${t.name}: never`}
                    disabled={!!t.off}
                    onChange={(v) => onChange([t.name], v)}
                  />
                </span>
              </div>
            );
          })
        : null}
    </div>
  );
}

export function ConnectionGrant({
  connection: c,
  grant,
  onChange,
}: {
  connection: Connection;
  grant: Grant;
  onChange(grant: Grant): void;
}) {
  const reads = c.tools.filter((t) => !t.write);
  const writes = c.tools.filter((t) => t.write);
  const readsOn = reads.filter((t) => toolGrantedBy(grant, t)).length;
  const writesOn = writes.filter((t) => toolGrantedBy(grant, t)).length;
  const summary =
    grant.mode === "off"
      ? "Not granted"
      : [
          reads.length ? `${readsOn} of ${reads.length} reads allowed` : "",
          writes.length ? `${writesOn} of ${writes.length} writes need approval` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <div className="flex flex-col rounded-[8px] border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[13px] font-semibold">{c.name}</span>
        <span className="text-[12px] text-muted">
          {summary}
          {!c.enabled ? " · switched off in Settings" : ""}
        </span>
        {c.tools.length === 0 ? (
          // Nothing discovered yet: grant the whole connection with a mode; pick tools once they are known.
          <select
            value={grant.mode}
            aria-label={`${c.name} mode`}
            onChange={(e) => onChange({ mode: e.target.value as ToolMode, picked: null })}
            className="ml-auto"
            style={{ fontSize: 12, padding: "3px 6px" }}
          >
            <option value="off">Off</option>
            <option value="read">Read only</option>
            <option value="ask">Reads, writes ask</option>
          </select>
        ) : null}
      </div>
      {c.tools.length === 0 ? (
        <span className="text-[12px] text-muted">
          {c.kind === "mcp"
            ? "Tools not discovered yet. Discover them in Settings to choose tool by tool."
            : "No operations on this connection."}
        </span>
      ) : (
        <div className="mt-1 flex flex-col">
          {reads.length ? (
            <ToolGroup
              title="Read-only tools"
              tools={reads}
              write={false}
              grant={grant}
              onChange={(names, on) => onChange(nextGrant(grant, c.tools, names, on))}
            />
          ) : null}
          {writes.length ? (
            <ToolGroup
              title="Write tools"
              tools={writes}
              write
              grant={grant}
              onChange={(names, on) => onChange(nextGrant(grant, c.tools, names, on))}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
