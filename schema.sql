CREATE TABLE IF NOT EXISTS cashflow (
  user_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Snapshot of state_json taken just before each overwrite, so an accidental
-- or bad write (from any client, including manual API testing) can be
-- undone. Pruned to the most recent 20 snapshots per user in application code.
CREATE TABLE IF NOT EXISTS cashflow_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  start REAL,
  event_count INTEGER,
  saved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cashflow_history_user ON cashflow_history(user_id, id DESC);