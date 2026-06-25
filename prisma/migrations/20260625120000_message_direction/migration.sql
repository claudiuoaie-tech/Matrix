-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- AlterTable
-- Additive: existing rows default to INBOUND (every message captured so far was
-- received from a contact), so this is safe to apply to a populated table.
ALTER TABLE "incoming_messages" ADD COLUMN "direction" "MessageDirection" NOT NULL DEFAULT 'INBOUND';
