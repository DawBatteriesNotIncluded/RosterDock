-- Style packs a company switched on (apps/board/src/styles/catalog.ts): the
-- rule file as downloaded at its pinned commit and checked against its hash,
-- whether it is on, and the level where the pack has levels. The text is the
-- pack author's, kept for this company only; turning a pack off keeps it so
-- turning it on again needs no download.
CREATE TABLE company_style_packs (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pack        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  level       text,
  sha256      text NOT NULL,
  body        text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, pack)
);
