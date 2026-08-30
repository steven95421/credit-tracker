-- Durable provider identity, separate from one-shot link Sessions.
CREATE TABLE IF NOT EXISTS provider_profiles (
  provider    TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
