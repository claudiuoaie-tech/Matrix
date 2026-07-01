-- AlterTable: add the worker's preferred outbound messaging channel.
-- Additive + NOT NULL with a default, so it is safe on a populated table
-- (every existing row backfills to 'SMS'). The MessageChannel enum already
-- exists (used by incoming_messages).
ALTER TABLE "workers" ADD COLUMN "preferredChannel" "MessageChannel" NOT NULL DEFAULT 'SMS';
