-- A specific historical receipt may be distinguished from one waiting logical request after
-- an audited identity review. This table does not release or rewrite the historical receipt.
CREATE TABLE receipt_identity_conflicts (
  id bigserial PRIMARY KEY,
  receipt_id bigint NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  receipt_key text NOT NULL,
  receipt_wire_hash text NOT NULL,
  receipt_attempts integer NOT NULL,
  request_key text NOT NULL,
  request_identity jsonb NOT NULL,
  request_tag text NOT NULL,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'authorized', 'revoked')),
  actor text,
  reason text,
  authorized_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, receipt_key, receipt_wire_hash, receipt_attempts, request_key)
);

CREATE INDEX receipt_identity_conflicts_state_updated_idx ON receipt_identity_conflicts (state, updated_at DESC);
