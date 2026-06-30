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
