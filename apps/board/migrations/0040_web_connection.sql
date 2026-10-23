-- The web connection: the board's own web fetch, a connection like the others so that toolboxes grant it,
-- a department and a client narrow it, and every page it reads is a tool.called event. It has no URL,
-- command or credential: the board reads public pages itself (src/web/). Its manifest keeps the company's
-- list of web domains ({"domains": [...]}, none for any public site). A company has one.

ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('mcp', 'openapi', 'web'));
CREATE UNIQUE INDEX connections_one_web_per_company ON connections (company_id) WHERE kind = 'web';
