-- Backlog: one notification per event across replicas. Every board replica's
-- notifier sees every needs-you event; before sending, it claims the event
-- here, and only the replica whose insert lands sends. The row is the claim,
-- not the record: notify.sent in the event stream still says what went where.
CREATE TABLE notify_claims (
  company_id uuid NOT NULL,
  seq        bigint NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, seq),
  FOREIGN KEY (company_id, seq) REFERENCES events (company_id, seq) ON DELETE CASCADE
);
