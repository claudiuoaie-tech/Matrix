import "dotenv/config";
import express from "express";
import cors from "cors";
import { webhooksRouter } from "./routes/webhooks";
import { authRouter } from "./routes/auth";
import { workerRouter } from "./routes/worker";
import { adminRouter } from "./routes/admin";
import { externalRouter } from "./routes/external";
import { startRtwScheduler } from "./lib/rtw";

export const app = express();

// CORS allowlist. Set CORS_ORIGIN to a comma-separated list of allowed origins
// in production (e.g. "https://matrix-web-di5w.onrender.com"). When unset — as in
// local development — all origins are allowed so the dev frontend just works.
const corsAllowlist = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors(
    corsAllowlist.length === 0
      ? undefined // no allowlist configured → permissive (local dev)
      : {
          origin(origin, callback) {
            // Allow non-browser clients (curl, Twilio webhooks, server-to-server)
            // that send no Origin header, plus any explicitly allowlisted origin.
            // Deny everything else quietly: callback(null, false) omits the
            // Access-Control-Allow-Origin header so the browser blocks the
            // request, without throwing (which would log a stack trace per call
            // and return a 500 instead of a clean CORS denial).
            const allowed = !origin || corsAllowlist.includes(origin);
            callback(null, allowed);
          },
        }
  )
);

// Twilio posts application/x-www-form-urlencoded bodies. JSON is enabled too so
// the frontend and mock test harness can post either format. The larger JSON
// limit accommodates base64-encoded document uploads in the worker vault.
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "matrix" });
});

app.use("/api/webhooks", webhooksRouter);
app.use("/api/auth", authRouter);
app.use("/api/worker", workerRouter);
app.use("/api/admin", adminRouter);
app.use("/api/v1/external", externalRouter);

const PORT = Number(process.env.PORT ?? 3000);

// Only start listening when run directly — importing `app` (e.g. from tests)
// should not bind a port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Matrix backend listening on port ${PORT}`);
  });
  // Daily Right to Work expiry sweep → high-priority admin email alerts.
  startRtwScheduler();
}
