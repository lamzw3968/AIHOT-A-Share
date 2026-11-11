-- Runtime coordination only: no existing article, analysis, publication or receipt is rewritten.
CREATE TABLE provider_quotas (
  quota_key text PRIMARY KEY,
  next_start_at timestamptz NOT NULL DEFAULT 'epoch',
  cooldown_until timestamptz NOT NULL DEFAULT 'epoch',
  rate_limit_failures integer NOT NULL DEFAULT 0 CHECK (rate_limit_failures >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_quota_leases (
  id uuid PRIMARY KEY,
  quota_key text NOT NULL REFERENCES provider_quotas (quota_key) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX provider_quota_leases_expiry_idx ON provider_quota_leases (quota_key, expires_at);

-- Reserve the durable continuation schema for the subsequent scheduling phase. Phase one does
-- not write or dispatch these rows; keeping the migration intact avoids a later DDL rewrite.
CREATE TABLE provider_deferred_jobs (
  id uuid PRIMARY KEY,
  queue_name text NOT NULL,
  current_job_id uuid NOT NULL UNIQUE,
  original_created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  options jsonb NOT NULL,
  failures_consumed integer NOT NULL DEFAULT 0 CHECK (failures_consumed >= 0),
  remaining_retries integer NOT NULL CHECK (remaining_retries >= 0),
  expires_at timestamptz NOT NULL,
  resume_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'dispatched', 'finished', 'expired')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_deferred_jobs_ready_idx ON provider_deferred_jobs (resume_at) WHERE status = 'waiting';
