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

app.use(cors());

// Twilio posts application/x-www-form-urlencoded bodies. JSON is enabled too so
// the frontend and mock test harness can post either format. The larger JSON
// limit accommodates base64-encoded document uploads in the worker vault.
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "rota-matrix" });
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
    console.log(`Rota-Matrix backend listening on port ${PORT}`);
  });
  // Daily Right to Work expiry sweep → high-priority admin email alerts.
  startRtwScheduler();
}
