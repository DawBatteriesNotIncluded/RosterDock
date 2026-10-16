import { describe, expect, it } from "vitest";
import {
  BOARD_OWN_ENV_NAME,
  isCompanyCreator,
  isPublicOidcIssuer,
  parseCompanyCreators,
  parseSharedEnvNames,
  parseStdioCommands,
  stdioCommandAllowed,
  stdioCommandLine,
} from "../src/index.js";

describe("what the operator lets companies reach", () => {
  it("shared env names: trimmed, deduplicated, empty by default; never the board's own", () => {
    expect(parseSharedEnvNames(undefined)).toEqual([]);
    expect(parseSharedEnvNames(" , ")).toEqual([]);
    expect(parseSharedEnvNames("HUBSPOT_MCP_TOKEN, N8N_MCP_TOKEN,HUBSPOT_MCP_TOKEN")).toEqual([
      "HUBSPOT_MCP_TOKEN",
      "N8N_MCP_TOKEN",
    ]);
    expect(() => parseSharedEnvNames("HUBSPOT-TOKEN")).toThrow("not an env var name");
    for (const own of [
      "DATABASE_URL",
      "ROSTERDOCK_WORKER_TOKEN",
      "ROSTERDOCK_OIDC_CLIENT_SECRET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
    ]) {
      expect(BOARD_OWN_ENV_NAME.test(own)).toBe(true);
      expect(() => parseSharedEnvNames(own)).toThrow(`${own} is the board's own`);
    }
    expect(BOARD_OWN_ENV_NAME.test("DATABASE_URL_RO")).toBe(false);
    expect(BOARD_OWN_ENV_NAME.test("S3_READONLY_KEY")).toBe(false);
  });

  it("stdio command lines: exact, or a start before a final *; none listed runs none", () => {
    const allowed = parseStdioCommands(
      " npx -y @modelcontextprotocol/server-memory@2026.8.31 ,npx -y @modelcontextprotocol/server-filesystem@2026.8.31 *",
    );
    expect(allowed.map(stdioCommandLine)).toEqual([
      "npx -y @modelcontextprotocol/server-memory@2026.8.31",
      "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 *",
    ]);
    const runs = (command: string | null, args: string[]) => stdioCommandAllowed(allowed, command, args);
    expect(runs("npx", ["-y", "@modelcontextprotocol/server-memory@2026.8.31"])).toBe(true);
    expect(runs("npx", ["-y", "@modelcontextprotocol/server-memory@2026.8.31", "--debug"])).toBe(false);
    expect(runs("npx", ["-y", "@modelcontextprotocol/server-memory"])).toBe(false);
    expect(runs("npx", ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"])).toBe(true);
    expect(runs("npx", ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/srv/a", "/srv/b"])).toBe(
      true,
    );
    expect(runs("npx", ["-y", "evil-package", "@modelcontextprotocol/server-filesystem@2026.8.31"])).toBe(
      false,
    );
    expect(runs("/usr/bin/npx", ["-y", "@modelcontextprotocol/server-memory@2026.8.31"])).toBe(false);
    expect(runs("sh", ["-c", "env"])).toBe(false);
    expect(runs(null, [])).toBe(false);
    expect(stdioCommandAllowed([], "npx", [])).toBe(false);
    expect(parseStdioCommands(undefined)).toEqual([]);
    expect(() => parseStdioCommands("npx, *")).toThrow("names no command");
  });

  it("company creators: emails and @domains, case-insensitive; * for anyone; unset is null", () => {
    expect(parseCompanyCreators(undefined)).toBeNull();
    expect(parseCompanyCreators(" ")).toBeNull();
    const creators = parseCompanyCreators("Ana@Acme.test, @Founders.test")!;
    expect(creators).toEqual({ anyone: false, emails: ["ana@acme.test"], domains: ["founders.test"] });
    expect(isCompanyCreator(creators, "ANA@acme.test")).toBe(true);
    expect(isCompanyCreator(creators, "bo@founders.test")).toBe(true);
    expect(isCompanyCreator(creators, "eve@acme.test")).toBe(false);
    expect(isCompanyCreator(creators, "eve@sub.founders.test")).toBe(false);
    expect(isCompanyCreator(creators, "not-an-email")).toBe(false);
    expect(isCompanyCreator(parseCompanyCreators("*")!, "anyone@anywhere.test")).toBe(true);
    for (const bad of ["acme.test", "@", "a@b", "x@@y.test"])
      expect(() => parseCompanyCreators(bad)).toThrow("not an email, an @domain or *");
  });

  it("public providers: where anyone can hold an account", () => {
    expect(isPublicOidcIssuer("https://accounts.google.com")).toBe(true);
    expect(isPublicOidcIssuer("https://accounts.google.com/")).toBe(true);
    expect(isPublicOidcIssuer("https://login.microsoftonline.com/common/v2.0")).toBe(true);
    expect(isPublicOidcIssuer("https://login.microsoftonline.com/0b1d2c3e-tenant/v2.0")).toBe(false);
    expect(isPublicOidcIssuer("https://sso.acme.test/realms/acme")).toBe(false);
  });
});
