/**
 * Public, unauthenticated asset routes. Twilio's servers must be able to fetch
 * outbound media without credentials, so these are intentionally NOT behind
 * requireAdmin. Filenames are server-generated UUIDs (validated below) and only
 * resolve within the outbound media directory, so there's nothing sensitive or
 * traversable here.
 */
import { Router, Request, Response } from "express";
import fs from "fs";
import {
  isValidMediaName,
  outboundMediaPath,
  mediaContentType,
} from "../lib/outboundMedia";
import { parseWhapiInbound } from "../lib/whapi";
import { recordInboundMessage } from "../lib/inbox";

export const publicRouter = Router();

/** GET /api/public/media/:name — serve an outbound media file for Twilio + UI. */
publicRouter.get("/media/:name", (req: Request, res: Response): void => {
  const name = req.params.name;
  if (!isValidMediaName(name)) {
    res.status(404).send("Not found");
    return;
  }
  const abs = outboundMediaPath(name);
  if (!fs.existsSync(abs)) {
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("Content-Type", mediaContentType(name));
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(abs).pipe(res);
});

/**
 * POST /api/public/webhooks/whapi — inbound WhatsApp from Whapi.cloud.
 *
 * Intentionally unauthenticated (no admin key): Whapi's servers post here when a
 * worker or candidate messages our WhatsApp number. Each inbound message is
 * written to the threaded Live Inbox (linked to a Worker by phone where one
 * matches) and pushed to the admin console over SSE in real time.
 *
 * If WHAPI_WEBHOOK_SECRET is set, we require it as a `?token=` / `X-Whapi-Token`
 * to drop spoofed posts — otherwise we accept all (Whapi has no signature).
 * Always 200s quickly so Whapi doesn't retry; logging failures never block.
 */
publicRouter.post("/webhooks/whapi", async (req: Request, res: Response): Promise<void> => {
  const secret = process.env.WHAPI_WEBHOOK_SECRET;
  if (secret) {
    const provided = String(req.query.token ?? req.header("X-Whapi-Token") ?? "");
    if (provided !== secret) {
      res.sendStatus(401);
      return;
    }
  }

  // Acknowledge immediately; ingest asynchronously so a slow DB write can't make
  // Whapi time out and re-deliver.
  res.sendStatus(200);

  try {
    const inbound = parseWhapiInbound(req.body);
    for (const m of inbound) {
      // Skip empty heartbeats (no text and no media).
      if (!m.body && !m.mediaUrl) continue;
      await recordInboundMessage(m.fromNumber, m.body, "WHATSAPP", m.mediaUrl);
    }
  } catch (err) {
    console.error("[whapi webhook] failed to ingest inbound:", err);
  }
});
