-- Apply once: npx wrangler d1 execute clankerinbox --remote --file=schema.sql
-- Keep in step with SCHEMA in worker.ts (a test checks they match).
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  rcpt TEXT NOT NULL,
  rcpt_base TEXT NOT NULL,
  mail_from TEXT,
  auth_results TEXT,
  raw_b64 TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_rcpt ON mail (rcpt_base, received_at);
CREATE INDEX IF NOT EXISTS mail_received ON mail (received_at);
