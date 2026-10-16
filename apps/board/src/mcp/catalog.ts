// The connector catalog: the menu of known integrations an owner can add as a
// connection. Definitions only: what the connector is, how it is reached, an
// example env var NAME for its credential (never a value), and which of its
// tools are known to read or write so a fresh connection starts classified
// before discovery. Ported from agent-board connector-catalog.ts without the
// governance ladder and the file store; entries live in code.

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: "mcp" | "openapi";
  transport: "http" | "stdio";
  /** Example endpoint or command shown in the Add flow; the owner supplies the real one. A command runs only when the operator lists its line (ROSTERDOCK_STDIO_COMMANDS). */
  urlExample?: string;
  commandExample?: string;
  /** Env var NAME example, never a value. Absent when the server takes no token at all. */
  authEnvExample?: string;
  /** "oauth": the server authorises by OAuth only, so the Add flow starts there and needs the board's secret store. */
  auth?: "oauth";
  docsUrl?: string;
  /** Tools known to read; anything else on the server is a write until a person or an annotation says otherwise. */
  reads: string[];
  /** Tools known to write, whatever their name suggests. */
  writes: string[];
}

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM reads (contacts, companies, deals, lists) and approval-gated writes.",
    category: "CRM",
    kind: "mcp",
    transport: "http",
    urlExample: "https://mcp.hubspot.com/mcp",
    authEnvExample: "HUBSPOT_MCP_TOKEN",
    docsUrl: "https://developers.hubspot.com",
    reads: ["search_crm_objects", "get_crm_objects", "query_crm_data", "get_properties", "search_owners"],
    writes: ["manage_crm_objects", "manage_segment", "manage_marketing_email", "manage_campaign_objects"],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read channels and threads; posting a message is a write that asks.",
    category: "Communication",
    kind: "mcp",
    transport: "http",
    urlExample: "https://mcp.slack.com/mcp",
    authEnvExample: "SLACK_MCP_TOKEN",
    docsUrl: "https://api.slack.com",
    reads: ["slack_read_channel", "slack_read_thread", "slack_search_public", "slack_search_users"],
    writes: ["slack_send_message", "slack_schedule_message", "slack_create_canvas", "slack_add_reaction"],
  },
  {
    id: "xero",
    name: "Xero",
    description: "Accounting reads (invoices, bank transactions, contacts); every posting asks.",
    category: "Finance",
    kind: "mcp",
    transport: "stdio",
    commandExample: "npx -y @xeroapi/xero-mcp-server",
    authEnvExample: "XERO_CLIENT_SECRET",
    docsUrl: "https://developer.xero.com",
    reads: ["list-invoices", "list-contacts", "list-bank-transactions", "list-accounts", "get-invoice"],
    writes: ["create-invoice", "update-invoice", "approve-invoice", "create-payment", "create-contact"],
  },
  {
    id: "n8n",
    name: "n8n",
    description: "Workflow automation: inspect workflows; creating, updating or activating one asks.",
    category: "Automation",
    kind: "mcp",
    transport: "http",
    urlExample: "http://localhost:3001/mcp",
    authEnvExample: "N8N_MCP_TOKEN",
    docsUrl: "https://docs.n8n.io",
    reads: ["list_workflows", "get_workflow", "get_workflow_details", "list_executions", "get_execution"],
    writes: [
      "create_workflow",
      "update_workflow",
      "activate_workflow",
      "deactivate_workflow",
      "run_workflow",
      "execute_workflow",
      "delete_workflow",
    ],
  },
  {
    id: "gong",
    name: "Gong",
    description: "Conversation intelligence, read only: calls, transcripts, topics.",
    category: "Revenue",
    kind: "mcp",
    transport: "http",
    urlExample: "https://mcp.gong.io/mcp",
    authEnvExample: "GONG_MCP_TOKEN",
    docsUrl: "https://help.gong.io",
    reads: ["list_calls", "get_call", "get_call_transcript", "search_calls"],
    writes: [],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search and read pages and databases; creating, editing, moving or commenting asks.",
    category: "Knowledge",
    kind: "mcp",
    transport: "http",
    urlExample: "https://mcp.notion.com/mcp",
    auth: "oauth",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    reads: [
      "notion-search",
      "notion-ai-search",
      "notion-fetch",
      "notion-query-data-sources",
      "notion-query-meeting-notes",
      "notion-get-comments",
      "notion-get-users",
      "notion-get-teams",
    ],
    writes: [
      "notion-create-pages",
      "notion-update-page",
      "notion-move-pages",
      "notion-duplicate-page",
      "notion-create-database",
      "notion-update-data-source",
      "notion-create-view",
      "notion-update-view",
      "notion-create-comment",
      "notion-create-attachment",
      "notion-create-file-upload",
      "notion-spawn-session",
      "notion-send-message-to-session",
      "notion-stop-session",
    ],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues and pull requests; anything that changes the host asks.",
    category: "Engineering",
    kind: "mcp",
    transport: "http",
    urlExample: "https://api.githubcopilot.com/mcp/",
    authEnvExample: "GITHUB_MCP_TOKEN",
    docsUrl: "https://github.com/github/github-mcp-server",
    reads: [
      "get_file_contents",
      "list_issues",
      "get_issue",
      "list_pull_requests",
      "get_pull_request",
      "search_code",
    ],
    writes: [
      "create_issue",
      "update_issue",
      "create_pull_request",
      "merge_pull_request",
      "create_or_update_file",
      "push_files",
    ],
  },
];

export function catalogEntry(id: string | null | undefined): CatalogEntry | null {
  return id ? (CONNECTOR_CATALOG.find((e) => e.id === id) ?? null) : null;
}
