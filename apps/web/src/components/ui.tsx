// Small presentational pieces shared by every view. The ones with behaviour
// (a dialog, a tooltip, a segmented control) sit on the shadcn-style
// primitives under ./ui; these are the manager-language wrappers the views use.
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { avatarTone, initialsOf } from "../lib/format.ts";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export function Button({
  variant = "ghost",
  size,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "accent" | "danger";
  size?: "sm";
}) {
  return <button className={cn("btn", variant, size, className)} {...rest} />;
}

export function Avatar({
  name,
  handle,
  size = "m",
  you = false,
}: {
  name: string;
  handle?: string;
  size?: "s" | "m" | "l" | "xl";
  you?: boolean;
}) {
  return (
    <span className={cn("av", size, you ? "you" : `tone-${avatarTone(handle ?? name)}`)} aria-hidden="true">
      {initialsOf(name).slice(0, name.includes(" ") ? 2 : 1)}
    </span>
  );
}

export function Pill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "info" | "bad" | "muted";
  children: ReactNode;
}) {
  return <span className={cn("pill", tone)}>{children}</span>;
}

export function Dot({ tone }: { tone: "ok" | "warn" | "info" | "bad" | "idle" }) {
  return <span className={cn("dot", tone)} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** A modal with a title. Escape, a click outside and the caller's own buttons close it; focus stays inside. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** A short explanation on hover or focus, where a title attribute used to be. */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/** The segmented control: one of a few choices, always one chosen. */
export function Segs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Minutes and seconds since something started: 0:07, 2:41. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Someone is working on it: a spinner, what they are doing, and how long it has taken so far. */
export function Thinking({ children }: { children: ReactNode }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="thinking">
      <span className="spin" />
      <span>{children}</span>
      <span className="mono text-[12px]">{elapsedLabel(now - start)}</span>
    </div>
  );
}

export function Topbar({
  title,
  subtitle,
  left,
  right,
  long = false,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  /** A task's title, not a page's: it gives way to the rest of the bar, cut short and whole on hover. */
  long?: boolean;
}) {
  return (
    <div className={cn("topbar", long && "long")}>
      <div className="topbar-l">
        <span className="title" title={long ? title : undefined}>
          {title}
        </span>
        {subtitle ? <span className="subtitle">{subtitle}</span> : null}
        {left}
      </div>
      <div className="topbar-r">{right}</div>
    </div>
  );
}
