// A list of web domains as people edit it: one field, domains separated by
// commas, spaces or lines, saved on Enter or with Save. Empty says nothing
// (on the company's web connection, any public site; on a department or a
// client, no narrowing). The same field sits on the web connection's card, in
// the client policies and on a department's card.
import { domainsPhrase, normalizeDomain } from "@rosterdock/shared/web";
import { useEffect, useState, type FormEvent } from "react";
import type { Connection } from "../api/types.ts";
import { Button } from "../components/ui.tsx";

export { domainsPhrase };

/** The domains a person typed, normalised, or the first entry that is not a domain. */
export function parseDomains(text: string): { domains: string[]; bad: string | null } {
  const domains: string[] = [];
  for (const entry of text.split(/[\s,]+/).filter(Boolean)) {
    const d = normalizeDomain(entry);
    if (!d) return { domains, bad: entry };
    if (!domains.includes(d)) domains.push(d);
  }
  return { domains, bad: null };
}

/** A list as the field shows it. */
export function domainsText(domains: readonly string[] | null | undefined): string {
  return (domains ?? []).join(", ");
}

/** The company's list on its web connection: null for any public site. */
export function webDomainsOf(c: Pick<Connection, "manifest">): string[] | null {
  const d = (c.manifest as { domains?: unknown } | null)?.domains;
  return Array.isArray(d) && d.length ? d.map(String) : null;
}

export function DomainsField({
  value,
  label,
  placeholder,
  disabled,
  onSave,
}: {
  value: readonly string[] | null | undefined;
  label: string;
  placeholder: string;
  disabled?: boolean;
  /** Resolves when the list is saved; an empty list says nothing. */
  onSave(domains: string[]): Promise<unknown>;
}) {
  const saved = domainsText(value);
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const parsed = parseDomains(text);
  const dirty = parsed.bad === null && domainsText(parsed.domains) !== saved;
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!dirty) return;
    setBusy(true);
    try {
      await onSave(parsed.domains);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-wrap items-center gap-1.5" onSubmit={submit}>
      <input
        aria-label={label}
        value={text}
        disabled={disabled || busy}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="mono"
        style={{ fontSize: 12, padding: "3px 6px", minWidth: 180 }}
      />
      {dirty ? (
        <Button size="sm" type="submit" disabled={busy}>
          Save
        </Button>
      ) : null}
      {parsed.bad !== null ? (
        <span className="text-[12px]" style={{ color: "var(--bad)" }}>
          {parsed.bad} is not a domain
        </span>
      ) : null}
    </form>
  );
}
