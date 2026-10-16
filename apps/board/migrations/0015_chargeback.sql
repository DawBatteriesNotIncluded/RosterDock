-- Milestone 6: an optional chargeback tag per project (a cost centre, a client
-- code, an invoice reference). The monthly cost report groups by it.
ALTER TABLE projects ADD COLUMN chargeback_tag text;
