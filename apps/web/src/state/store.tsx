// Application state: who you are, which company is open, that company's data,
// and a live tail of its events. Every write goes through the client; every
// event from the stream triggers a refresh, so a second browser sees changes.
import type { EventRecord } from "@rosterdock/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, type Client } from "../api/client.ts";
import type { Company, CompanyData, Me } from "../api/types.ts";

export type View =
  | "company"
  | "board"
  | "reviews"
  | "approvals"
  | "activity"
  | "office"
  | "costs"
  | "org"
  | "team"
  | "settings";

/** The Settings page, one tab at a time. */
export type SettingsTab =
  "prices" | "peter" | "style" | "connections" | "notifications" | "drift" | "templates";

export interface Ui {
  view: View;
  settingsTab: SettingsTab;
  projectId: string | "all";
  departmentId: string | "all";
  selectedTaskId: string | null;
  selectedTeammateId: string | null;
  selectedReviewId: string | null;
  theme: "light" | "dark" | "system";
}

export interface AppState {
  client: Client;
  me: Me | null;
  authChecked: boolean;
  companies: Company[];
  companyId: string | null;
  data: CompanyData | null;
  loading: boolean;
  ui: Ui;
  setUi(patch: Partial<Ui>): void;
  go(view: View, patch?: Partial<Ui>): void;
  selectCompany(id: string): void;
  refresh(): Promise<void>;
  reloadSession(): Promise<void>;
  toast(message: string, tone?: "ok" | "bad"): void;
  /** Run a write; on failure show the board's message as a toast and rethrow. */
  run<T>(fn: () => Promise<T>, successMessage?: string): Promise<T>;
  toggleTheme(): void;
}

const Ctx = createContext<AppState | null>(null);

const COMPANY_KEY = "rosterdock.company";
const THEME_KEY = "rosterdock.theme";

function readTheme(): Ui["theme"] {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "dark" || t === "light" ? t : "system";
  } catch {
    return "system";
  }
}

export function showToast(message: string, tone: "ok" | "bad" = "ok"): void {
  if (typeof document === "undefined") return;
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${tone === "bad" ? "bad" : ""}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

export function AppProvider({ client, children }: { client: Client; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [data, setData] = useState<CompanyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [ui, setUiState] = useState<Ui>({
    view: "company",
    settingsTab: "prices",
    projectId: "all",
    departmentId: "all",
    selectedTaskId: null,
    selectedTeammateId: null,
    selectedReviewId: null,
    theme: readTheme(),
  });
  const lastSeq = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const setUi = useCallback((patch: Partial<Ui>) => setUiState((u) => ({ ...u, ...patch })), []);
  const go = useCallback(
    (view: View, patch: Partial<Ui> = {}) => setUiState((u) => ({ ...u, view, ...patch })),
    [],
  );

  const reloadSession = useCallback(async () => {
    try {
      const who = await client.me();
      setMe(who);
      const list = await client.companies();
      setCompanies(list);
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(COMPANY_KEY);
      } catch {
        // ignore
      }
      const pick = list.find((c) => c.id === stored)?.id ?? list[0]?.id ?? null;
      setCompanyId(pick);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
        setCompanies([]);
        setCompanyId(null);
      } else {
        showToast((err as Error).message, "bad");
      }
    } finally {
      setAuthChecked(true);
    }
  }, [client]);

  const loadCompany = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const [
          list,
          members,
          departments,
          teammates,
          projects,
          tasks,
          events,
          reviews,
          goals,
          drafts,
          approvals,
          connections,
        ] = await Promise.all([
          client.companies(),
          client.members(id),
          client.departments(id),
          client.teammates(id),
          client.projects(id),
          client.tasks(id),
          client.events(id, 100),
          client.reviews(id),
          client.goals(id),
          client.drafts(id),
          client.approvals(id),
          client.connections(id),
        ]);
        setCompanies(list);
        const company = list.find((c) => c.id === id);
        if (!company) throw new Error("company not found");
        setData({
          company,
          members,
          departments,
          teammates,
          projects,
          tasks,
          events,
          reviews,
          goals,
          drafts,
          approvals,
          connections,
        });
        lastSeq.current = events[0]?.seq ?? 0;
      } catch (err) {
        showToast((err as Error).message, "bad");
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const refresh = useCallback(async () => {
    if (companyId) await loadCompany(companyId);
  }, [companyId, loadCompany]);

  // Initial session.
  useEffect(() => {
    void reloadSession();
  }, [reloadSession]);

  // Company switch: load and tail.
  useEffect(() => {
    if (!companyId) {
      setData(null);
      return;
    }
    try {
      localStorage.setItem(COMPANY_KEY, companyId);
    } catch {
      // ignore
    }
    let stopped = false;
    let stop: (() => void) | null = null;
    void loadCompany(companyId).then(() => {
      if (stopped) return;
      stop = client.subscribe(companyId, lastSeq.current, (ev: EventRecord) => {
        if (ev.companyId !== companyId) return;
        setData((d) => {
          if (!d || d.events.some((e) => e.seq === ev.seq)) return d;
          return { ...d, events: [ev, ...d.events].slice(0, 300) };
        });
        lastSeq.current = Math.max(lastSeq.current ?? 0, ev.seq);
        // Coalesce bursts into one refetch of the entity lists.
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => void refreshEntities(companyId), 150);
      });
    });
    const refreshEntities = async (id: string) => {
      try {
        const [
          list,
          members,
          departments,
          teammates,
          projects,
          tasks,
          reviews,
          goals,
          drafts,
          approvals,
          connections,
        ] = await Promise.all([
          client.companies(),
          client.members(id),
          client.departments(id),
          client.teammates(id),
          client.projects(id),
          client.tasks(id),
          client.reviews(id),
          client.goals(id),
          client.drafts(id),
          client.approvals(id),
          client.connections(id),
        ]);
        setCompanies(list);
        setData((d) => {
          const company = list.find((c) => c.id === id) ?? d?.company;
          if (!d || !company) return d;
          return {
            ...d,
            company,
            members,
            departments,
            teammates,
            projects,
            tasks,
            reviews,
            goals,
            drafts,
            approvals,
            connections,
          };
        });
      } catch {
        // transient; the next event retries
      }
    };
    return () => {
      stopped = true;
      stop?.();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [client, companyId, loadCompany]);

  const selectCompany = useCallback((id: string) => {
    setCompanyId(id);
    setUiState((u) => ({
      ...u,
      view: "company",
      projectId: "all",
      departmentId: "all",
      selectedTaskId: null,
      selectedTeammateId: null,
      selectedReviewId: null,
    }));
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>, successMessage?: string): Promise<T> => {
    try {
      const out = await fn();
      if (successMessage) showToast(successMessage);
      return out;
    } catch (err) {
      showToast((err as Error).message, "bad");
      throw err;
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setUiState((u) => {
      const root = document.documentElement;
      const current =
        u.theme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : u.theme;
      const next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // ignore
      }
      return { ...u, theme: next };
    });
  }, []);

  const value = useMemo<AppState>(
    () => ({
      client,
      me,
      authChecked,
      companies,
      companyId,
      data,
      loading,
      ui,
      setUi,
      go,
      selectCompany,
      refresh,
      reloadSession,
      toast: showToast,
      run,
      toggleTheme,
    }),
    [
      client,
      me,
      authChecked,
      companies,
      companyId,
      data,
      loading,
      ui,
      setUi,
      go,
      selectCompany,
      refresh,
      reloadSession,
      run,
      toggleTheme,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
