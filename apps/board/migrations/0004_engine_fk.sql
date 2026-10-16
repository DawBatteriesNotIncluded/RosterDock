-- Engines are rows: teammates and templates reference the engines table
-- instead of a hard-coded list, so adding an engine is an insert.
ALTER TABLE teammates DROP CONSTRAINT IF EXISTS teammates_engine_check;
ALTER TABLE teammate_templates DROP CONSTRAINT IF EXISTS teammate_templates_engine_check;
ALTER TABLE teammates ADD CONSTRAINT teammates_engine_fk FOREIGN KEY (engine) REFERENCES engines(id);
ALTER TABLE teammate_templates ADD CONSTRAINT teammate_templates_engine_fk FOREIGN KEY (engine) REFERENCES engines(id);
