-- Inbound media support: store Twilio's first media attachment URL (MediaUrl0).
-- Additive and nullable — safe on a populated table.
ALTER TABLE "incoming_messages" ADD COLUMN "mediaUrl" TEXT;
