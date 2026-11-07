-- 2026-11-06 Add Live Trade workspace tables.
--
-- Additive and idempotent. This migration does not alter, drop, truncate, or
-- delete any existing table or row. Applying it is a separate, explicit
-- operation (npm run db:migrate) and is not performed by application startup.
--
-- Ownership model:
--   owner_user_id is the stable Kite user_id resolved from the server-side
--   session. It has no foreign key because this schema has no users table.
--
-- Group ownership:
--   live_trade_groups has a UNIQUE (group_id, owner_user_id) target and
--   live_trade_items has a composite FK on (group_id, owner_user_id). This
--   makes it impossible to attach an item to another owner's group.
--
-- Group deletion:
--   The FK uses the default NO ACTION. The service ungroups items (setting
--   group_id = NULL and preserving owner_user_id) in the same transaction
--   before deleting the group. The FK blocks any deletion that skips that step.

CREATE TABLE IF NOT EXISTS live_trade_groups (
  group_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  TEXT NOT NULL,
  name           TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_trade_groups_owner_not_blank
    CHECK (btrim(owner_user_id) <> '' AND char_length(owner_user_id) <= 64),
  CONSTRAINT live_trade_groups_name_len
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT live_trade_groups_sort_nonneg
    CHECK (sort_order >= 0),
  CONSTRAINT live_trade_groups_version_pos
    CHECK (version >= 1),
  CONSTRAINT live_trade_groups_group_owner_uq
    UNIQUE (group_id, owner_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS live_trade_groups_owner_name_uq
  ON live_trade_groups (owner_user_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS live_trade_groups_owner_sort_idx
  ON live_trade_groups (owner_user_id, sort_order, group_id);

CREATE TABLE IF NOT EXISTS live_trade_items (
  item_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  TEXT NOT NULL,
  instrument_id  BIGINT NOT NULL REFERENCES instruments(instrument_id),
  group_id       UUID,
  priority       TEXT NOT NULL DEFAULT 'MEDIUM',
  direction      TEXT,
  timeframe      TEXT,
  entry_price    NUMERIC(18,4),
  target_price   NUMERIC(18,4),
  stop_loss      NUMERIC(18,4),
  notes          TEXT NOT NULL DEFAULT '',
  trade_status   TEXT NOT NULL DEFAULT 'WATCHING',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_trade_items_owner_not_blank
    CHECK (btrim(owner_user_id) <> '' AND char_length(owner_user_id) <= 64),
  CONSTRAINT live_trade_items_priority_chk
    CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
  CONSTRAINT live_trade_items_direction_chk
    CHECK (direction IS NULL OR direction IN ('BUY', 'SELL')),
  CONSTRAINT live_trade_items_timeframe_chk
    CHECK (timeframe IS NULL OR timeframe IN
           ('1H', '4H', '1D', '1W', '1M', '3M', '6M', '1Y')),
  CONSTRAINT live_trade_items_status_chk
    CHECK (trade_status IN ('WATCHING', 'WAITING_FOR_ENTRY', 'ACTIVE_TRADE',
                            'TARGET_HIT', 'STOP_LOSS_HIT', 'CLOSED')),
  CONSTRAINT live_trade_items_notes_len
    CHECK (char_length(notes) <= 2000),
  CONSTRAINT live_trade_items_prices_chk
    CHECK (
      (entry_price  IS NULL OR (entry_price  > 0 AND entry_price  <= 1000000000)) AND
      (target_price IS NULL OR (target_price > 0 AND target_price <= 1000000000)) AND
      (stop_loss    IS NULL OR (stop_loss    > 0 AND stop_loss    <= 1000000000))
    ),
  CONSTRAINT live_trade_items_sort_nonneg
    CHECK (sort_order >= 0),
  CONSTRAINT live_trade_items_version_pos
    CHECK (version >= 1),
  CONSTRAINT live_trade_items_group_owner_fk
    FOREIGN KEY (group_id, owner_user_id) REFERENCES live_trade_groups (group_id, owner_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS live_trade_items_owner_instrument_uq
  ON live_trade_items (owner_user_id, instrument_id);

CREATE INDEX IF NOT EXISTS live_trade_items_owner_sort_idx
  ON live_trade_items (owner_user_id, sort_order, item_id);

CREATE INDEX IF NOT EXISTS live_trade_items_owner_group_idx
  ON live_trade_items (owner_user_id, group_id);

CREATE INDEX IF NOT EXISTS live_trade_items_instrument_idx
  ON live_trade_items (instrument_id);

CREATE TABLE IF NOT EXISTS live_trade_quote_state (
  owner_user_id    TEXT PRIMARY KEY,
  last_request_at  TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_trade_quote_state_owner_not_blank
    CHECK (btrim(owner_user_id) <> '' AND char_length(owner_user_id) <= 64)
);
