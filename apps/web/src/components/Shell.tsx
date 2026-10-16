// Sidebar, company switcher, navigation, theme toggle.
import {
  Activity,
  Building2,
  ChevronDown,
  CircleDollarSign,
  Cog,
  Kanban,
  LayoutGrid,
  LogOut,
  Plug,
  Plus,
  ShieldCheck,
  SquareCheck,
  SunMoon,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Company } from "../api/types.ts";
import { cn } from "../lib/cn.ts";
import type { View } from "../state/store.tsx";
import { Avatar, Tip } from "./ui.tsx";

export interface ShellProps {
  companies: Company[];
  company: Company | null;
  view: View;
  counts: { reviews: number; approvals: number };
  userName: string;
  userRole: string;
  onNavigate(view: View): void;
  onSelectCompany(id: string): void;
  onCreateCompany(): void;
  /** False when the board would refuse: the menu then offers no new company. */
  canCreateCompany?: boolean;
  onToggleTheme(): void;
  onSignOut(): void;
  children: ReactNode;
}

const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: "company", label: "Company", icon: <Building2 size={16} /> },
  { view: "board", label: "Board", icon: <Kanban size={16} /> },
  { view: "reviews", label: "Reviews", icon: <SquareCheck size={16} /> },
  { view: "approvals", label: "Approvals", icon: <ShieldCheck size={16} /> },
  { view: "activity", label: "Activity", icon: <Activity size={16} /> },
  { view: "office", label: "Office", icon: <LayoutGrid size={16} /> },
  { view: "costs", label: "Costs", icon: <CircleDollarSign size={16} /> },
];
const STRUCTURE: { view: View; label: string; icon: ReactNode }[] = [
  { view: "org", label: "Departments", icon: <Users size={16} /> },
  { view: "team", label: "Teammates", icon: <Plug size={16} /> },
  { view: "settings", label: "Settings", icon: <Cog size={16} /> },
];

export function Shell(props: ShellProps) {
  const [menu, setMenu] = useState(false);
  const badge = (view: View) => {
    const n = view === "reviews" ? props.counts.reviews : view === "approvals" ? props.counts.approvals : 0;
    if (!n) return null;
    return <span className={cn("badge", view === "approvals" && "warn")}>{n}</span>;
  };
  const navBtn = (item: { view: View; label: string; icon: ReactNode }) => (
    <button
      key={item.view}
      className={cn("nav", props.view === item.view && "active")}
      onClick={() => {
        setMenu(false);
        props.onNavigate(item.view);
      }}
    >
      <span className="l">
        {item.icon}
        <span>{item.label}</span>
      </span>
      {badge(item.view)}
    </button>
  );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="relative mb-3">
          <button
            className={cn("brand", menu && "open")}
            onClick={() => setMenu((m) => !m)}
            aria-haspopup="menu"
            aria-expanded={menu}
          >
            <span className="brand-mark">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              >
                <path d="M4 6h16" />
                <path d="M4 12h10" />
                <path d="M4 18h7" />
              </svg>
            </span>
            <span className="flex min-w-0 grow flex-col items-start">
              <span className="brand-name">{props.company?.name ?? "No company"}</span>
              <span className="whitespace-nowrap text-[11px] text-muted">Company · RosterDock</span>
            </span>
            <ChevronDown size={14} className="text-muted" />
          </button>
          {menu ? (
            <div className="card company-menu" role="menu">
              {props.companies.map((co) => (
                <button
                  key={co.id}
                  className={cn("nav", co.id === props.company?.id && "active")}
                  style={{ padding: "8px 10px" }}
                  onClick={() => {
                    setMenu(false);
                    props.onSelectCompany(co.id);
                  }}
                >
                  <span className="l">
                    <span className="flex flex-col items-start">
                      <span>{co.name}</span>
                      <span className="text-[11px] font-normal text-muted">
                        {co.role} · {co.template ?? "custom"}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
              {props.canCreateCompany === false ? null : (
                <button
                  className="nav"
                  style={{ padding: "8px 10px", color: "var(--accent)" }}
                  onClick={() => {
                    setMenu(false);
                    props.onCreateCompany();
                  }}
                >
                  <span className="l">
                    <Plus size={16} />
                    <span>Create a company</span>
                  </span>
                </button>
              )}
            </div>
          ) : null}
        </div>
        {NAV.map(navBtn)}
        <div className="eyebrow" style={{ padding: "14px 10px 4px", fontSize: 11 }}>
          Structure
        </div>
        {STRUCTURE.map(navBtn)}
        <div className="sidebar-foot">
          <button className="theme-toggle" onClick={props.onToggleTheme}>
            <SunMoon size={16} />
            <span>Switch theme</span>
          </button>
          <div className="me">
            <Avatar name={props.userName} you />
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold">{props.userName}</span>
              <span className="text-[12px] text-muted">{props.userRole}</span>
            </div>
            <Tip text="Sign out">
              <button className="theme-toggle ml-auto" onClick={props.onSignOut} aria-label="Sign out">
                <LogOut size={16} />
                <span>Sign out</span>
              </button>
            </Tip>
          </div>
        </div>
      </aside>
      <div className="main">{props.children}</div>
    </div>
  );
}
