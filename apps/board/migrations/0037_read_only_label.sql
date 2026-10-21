-- A server's read-only label (the readOnlyHint annotation) makes a tool a read only with a second sign: a
-- name that reads as one (readsByName in @rosterdock/shared) or the connector's catalog listing it as a read
-- (classifyTool). A tool an earlier discovery kept as a read on the label alone becomes a write held for a
-- person ("unconfirmed"), so a call to it is proposed instead of run until someone confirms it in Settings,
-- Connections; one the catalog lists as a write becomes the catalog's write. The catalog below is
-- src/mcp/catalog.ts as it stood when this was written. What a person, the catalog or a name said about a
-- tool stays as it was, and so does a server's word that a tool writes.

WITH catalog(catalog_id, reads, writes) AS (
  VALUES
    ('hubspot',
      ARRAY['search_crm_objects', 'get_crm_objects', 'query_crm_data', 'get_properties', 'search_owners'],
      ARRAY['manage_crm_objects', 'manage_segment', 'manage_marketing_email', 'manage_campaign_objects']),
    ('slack',
      ARRAY['slack_read_channel', 'slack_read_thread', 'slack_search_public', 'slack_search_users'],
      ARRAY['slack_send_message', 'slack_schedule_message', 'slack_create_canvas', 'slack_add_reaction']),
    ('xero',
      ARRAY['list-invoices', 'list-contacts', 'list-bank-transactions', 'list-accounts', 'get-invoice'],
      ARRAY['create-invoice', 'update-invoice', 'approve-invoice', 'create-payment', 'create-contact']),
    ('n8n',
      ARRAY['list_workflows', 'get_workflow', 'get_workflow_details', 'list_executions', 'get_execution'],
      ARRAY['create_workflow', 'update_workflow', 'activate_workflow', 'deactivate_workflow', 'run_workflow',
        'execute_workflow', 'delete_workflow']),
    ('gong', ARRAY['list_calls', 'get_call', 'get_call_transcript', 'search_calls'], ARRAY[]::text[]),
    ('notion',
      ARRAY['notion-search', 'notion-ai-search', 'notion-fetch', 'notion-query-data-sources',
        'notion-query-meeting-notes', 'notion-get-comments', 'notion-get-users', 'notion-get-teams'],
      ARRAY['notion-create-pages', 'notion-update-page', 'notion-move-pages', 'notion-duplicate-page',
        'notion-create-database', 'notion-update-data-source', 'notion-create-view', 'notion-update-view',
        'notion-create-comment', 'notion-create-attachment', 'notion-create-file-upload',
        'notion-spawn-session', 'notion-send-message-to-session', 'notion-stop-session']),
    ('github',
      ARRAY['get_file_contents', 'list_issues', 'get_issue', 'list_pull_requests', 'get_pull_request',
        'search_code'],
      ARRAY['create_issue', 'update_issue', 'create_pull_request', 'merge_pull_request',
        'create_or_update_file', 'push_files'])
),
reclassified AS (
  SELECT c.id,
    jsonb_agg(
      CASE WHEN h.held AND s.listed_write THEN e.t || '{"write": true, "source": "catalog"}'::jsonb
        WHEN h.held THEN e.t || '{"write": true, "source": "unconfirmed"}'::jsonb
        ELSE e.t
      END ORDER BY e.i
    ) AS tools,
    bool_or(h.held) AS changed
  FROM (SELECT id, catalog_id, tools FROM connections WHERE jsonb_typeof(tools) = 'array') c
  LEFT JOIN catalog k ON k.catalog_id = c.catalog_id
  CROSS JOIN LATERAL jsonb_array_elements(c.tools) WITH ORDINALITY AS e(t, i)
  CROSS JOIN LATERAL (SELECT regexp_replace(e.t->>'name', '^[a-z0-9-]+[.:]', '', 'i') AS bare) b
  CROSS JOIN LATERAL (
    SELECT coalesce(e.t->>'name' = ANY (k.writes), false) AS listed_write,
      coalesce(e.t->>'name' = ANY (k.reads), false) AS listed_read,
      b.bare ~* '^(get|list|search|read|find|describe|query|fetch|lookup|look_up|count|show|view|inspect|summari[sz]e|retrieve|browse)([^a-z]|$)'
        AND b.bare !~* '[-_.[:space:]](and|or|then)([-_.[:space:]]|$)' AS reads
  ) s
  CROSS JOIN LATERAL (
    SELECT e.t->>'source' = 'annotation' AND e.t->'write' = 'false'::jsonb
      AND (s.listed_write OR NOT (s.listed_read OR s.reads)) AS held
  ) h
  GROUP BY c.id
)
UPDATE connections c SET tools = reclassified.tools, updated_at = now()
FROM reclassified
WHERE reclassified.id = c.id AND reclassified.changed;
