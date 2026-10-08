-- Additive, independent topic attention snapshots; no changes to historic story/selected ledgers.
CREATE TABLE topic_hot_rankings (
  id bigserial PRIMARY KEY,
  computed_at timestamptz NOT NULL,
  rule_version text NOT NULL,
  article_ids text[] NOT NULL DEFAULT '{}',
  board jsonb NOT NULL
);
CREATE INDEX topic_hot_rankings_latest_idx ON topic_hot_rankings (computed_at DESC, id DESC);
