// The sign-in page. Production signs in through the company's identity
// provider (one button, the board does the rest); the local dev login form
// appears only when the board runs with ROSTERDOCK_DEV_LOGIN=1.
import { useState, type FormEvent } from "react";
import type { AuthProviders } from "../api/types.ts";
import { Button, Field } from "../components/ui.tsx";

const ERROR_TEXT: Record<string, string> = {
  denied: "You cancelled the sign-in at the identity provider.",
  state: "That sign-in was not started here or took too long. Try again.",
  provider: "The identity provider could not be reached. Try again in a moment.",
  token: "The identity provider's answer could not be verified. Try again.",
  email: "The identity provider sent no verified email, and RosterDock needs one.",
  domain: "Your email domain is not allowed to sign in here. Ask an owner.",
};

export function loginErrorText(code: string | null): string | null {
  if (!code) return null;
  return ERROR_TEXT[code] ?? "Sign-in failed. Try again.";
}

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
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
      <div className="flex flex-col">
        <span className="text-[16px] font-semibold">RosterDock</span>
        <span className="text-[12px] text-muted">{subtitle}</span>
      </div>
    </div>
  );
}

export function LoginView({
  providers,
  error,
  onLogin,
}: {
  /** Null while the page asks the board what is on offer. */
  providers: AuthProviders | null;
  /** The auth_error code the board redirected back with, if any. */
  error?: string | null;
  onLogin(email: string, name: string): Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      await onLogin(email.trim(), name.trim());
    } finally {
      setBusy(false);
    }
  };
  const errorText = loginErrorText(error ?? null);
  const oidc = providers?.oidc ?? null;
  const devLogin = providers?.devLogin ?? false;
  return (
    <div className="login">
      <div className="card flex w-[400px] max-w-full flex-col gap-4 p-6">
        <Brand
          subtitle={oidc ? "Sign in to your company" : devLogin ? "Local development sign-in" : "Sign in"}
        />
        {errorText ? (
          <div className="note" role="alert" style={{ borderColor: "var(--bad)" }}>
            {errorText}
          </div>
        ) : null}
        {providers === null ? <span className="hint">Checking how to sign you in…</span> : null}
        {oidc ? (
          <a className="btn primary block text-center" href={oidc.startUrl}>
            {`Sign in with ${oidc.name}`}
          </a>
        ) : null}
        {devLogin ? (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {oidc ? <span className="eyebrow">Or the local dev login</span> : null}
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoFocus={!oidc}
              />
            </Field>
            <Field label="Name" hint="Shown on tasks and messages you write.">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" />
            </Field>
            <Button variant="primary" type="submit" disabled={busy || !email.trim()} className="block">
              Sign in
            </Button>
            <span className="hint">
              Dev login is on because the board runs with ROSTERDOCK_DEV_LOGIN=1. Never in production.
            </span>
          </form>
        ) : null}
        {providers && !oidc && !devLogin ? (
          <span className="hint">
            No way to sign in is configured. An operator sets ROSTERDOCK_OIDC_ISSUER and
            ROSTERDOCK_OIDC_CLIENT_ID on the board (docs/install.md).
          </span>
        ) : null}
      </div>
    </div>
  );
}
