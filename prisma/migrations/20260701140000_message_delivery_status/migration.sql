-- AlterTable: track Twilio message SID + delivery status on outbound messages,
-- so async status callbacks (sent/delivered/read) can update the chat ticks.
-- Both columns are nullable and additive, so this is safe on a populated table.
ALTER TABLE "incoming_messages" ADD COLUMN "providerSid" TEXT;
ALTER TABLE "incoming_messages" ADD COLUMN "deliveryStatus" TEXT;

-- CreateIndex: match a status callback back to its row by SID.
CREATE INDEX "incoming_messages_providerSid_idx" ON "incoming_messages"("providerSid");
