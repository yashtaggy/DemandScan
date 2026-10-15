-- DemandScan — Neon Postgres schema
-- Run once against your Neon database.
-- This script is idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS kite_sessions (
  -- SHA-256 hash of the opaque browser session cookie value.
  -- The plaintext cookie value is NEVER stored here.
  session_id_hash       TEXT        PRIMARY KEY,

  -- AES-256-GCM encrypted Kite access token.
  -- Wire format: base64( iv[12] || authTag[16] || ciphertext )
  encrypted_access_token TEXT       NOT NULL,

  -- Safe profile fields from Kite's generateSession response.
  user_id               TEXT        NOT NULL,
  user_name             TEXT        NOT NULL DEFAULT '',
  email                 TEXT        NOT NULL DEFAULT '',

  -- ISO timestamps
  login_time            TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient expiry-based cleanup
CREATE INDEX IF NOT EXISTS idx_kite_sessions_expires_at
  ON kite_sessions (expires_at);
