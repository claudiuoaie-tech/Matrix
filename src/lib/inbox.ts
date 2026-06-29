/**
 * Shared inbound-message recorder. Persists an INBOUND message to the Live Inbox,
 * links it to a Worker by phone (so it threads under their name), and emits the
 * real-time `message.received` SSE event for the admin console.
 *
 * Used by every inbound channel — the Twilio SMS webhook and the Whapi WhatsApp
 * webhook — so the threaded-inbox shape and SSE payload stay identical.
 */
import type { MessageChannel } from "@prisma/client";
import { prisma } from "./prisma";
import { emitRotaEvent } from "./events";

export interface RecordedInbound {
  id: string;
  worker: { id: string; name: string } | null;
}

export async function recordInboundMessage(
  fromNumber: string,
  messageBody: string,
  channel: MessageChannel,
  mediaUrl: string | null
): Promise<RecordedInbound> {
  const worker = await prisma.worker.findUnique({
    where: { phone: fromNumber },
    select: { id: true, name: true },
  });

  const msg = await prisma.incomingMessage.create({
    data: {
      fromNumber,
      messageBody,
      channel,
      direction: "INBOUND",
      workerId: worker?.id ?? null,
      mediaUrl,
    },
  });

  emitRotaEvent({
    type: "message.received",
    payload: {
      id: msg.id,
      fromNumber: msg.fromNumber,
      messageBody: msg.messageBody,
      channel: msg.channel,
      direction: msg.direction,
      mediaUrl: msg.mediaUrl,
      receivedAt: msg.receivedAt.toISOString(),
      isRead: msg.isRead,
      workerName: worker?.name ?? null,
    },
  });

  return { id: msg.id, worker: worker ?? null };
}
