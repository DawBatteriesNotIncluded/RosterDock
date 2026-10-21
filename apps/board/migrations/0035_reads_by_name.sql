-- A tool's name makes it a read only when it starts with a reading verb and joins no second verb to it
-- (readsByName in @rosterdock/shared): export, preview and check are no longer reading verbs, and
-- get_or_create or find_and_replace never read. A tool an earlier discovery kept as a read by its name alone,
-- and that the rule no longer counts as one, becomes a write, so a call to it is proposed for a person instead
-- of run. What a person, an annotation or the catalog said about a tool stays as it was.

WITH reclassified AS (
  SELECT c.id,
    jsonb_agg(
      CASE WHEN e.t->>'source' = 'name' AND NOT r.reads
        THEN e.t || '{"write": true, "source": "default"}'::jsonb
        ELSE e.t
      END ORDER BY e.i
    ) AS tools,
    bool_or(e.t->>'source' = 'name' AND NOT r.reads) AS changed
  FROM (SELECT id, tools FROM connections WHERE jsonb_typeof(tools) = 'array') c
  CROSS JOIN LATERAL jsonb_array_elements(c.tools) WITH ORDINALITY AS e(t, i)
  CROSS JOIN LATERAL (SELECT regexp_replace(e.t->>'name', '^[a-z0-9-]+[.:]', '', 'i') AS bare) b
  CROSS JOIN LATERAL (
    SELECT b.bare ~* '^(get|list|search|read|find|describe|query|fetch|lookup|look_up|count|show|view|inspect|summari[sz]e|retrieve|browse)([^a-z]|$)'
      AND b.bare !~* '[-_.[:space:]](and|or|then)([-_.[:space:]]|$)' AS reads
  ) r
  GROUP BY c.id
)
UPDATE connections c SET tools = reclassified.tools, updated_at = now()
FROM reclassified
WHERE reclassified.id = c.id AND reclassified.changed;
