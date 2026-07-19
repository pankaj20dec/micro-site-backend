import "dotenv/config";
import express from "express";
import cors from "cors";

import { prisma } from "./config/db.js";
import { authRouter } from "./routes/auth.js";
import { publicPagesRouter } from "./routes/publicPages.js";
import { adminPagesRouter } from "./routes/adminPages.js";
import { contactRouter } from "./routes/contact.js";
import { applicationRouter } from "./routes/application.js";
import { paymentRouter } from "./routes/payment.js";
import { adminApplicationsRouter } from "./routes/adminApplications.js";
import { adminUsersRouter } from "./routes/adminUsers.js";
import { adminSetupRouter } from "./routes/adminSetup.js";
import { siteSettingsRouter } from "./routes/siteSettings.js";
import { adminSiteSettingsRouter } from "./routes/adminSiteSettings.js";
import { docusignRouter } from "./routes/docusign.js";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const corsAllowList = (process.env.CORS_ORIGIN || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsAllowList.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  })
);

// ─── Raw body for webhook signature verification ─────────────────────────────
app.use("/api/payment/stripe/webhook", express.raw({ type: "application/json" }));
app.use("/api/docusign/webhook", express.raw({ type: "*/*" }));

// ─── JSON body parser for all other routes ────────────────────────────────────
app.use(express.json());

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, db: true });
  } catch (err) {
    console.error("Health DB check failed:", err);
    return res.status(503).json({
      ok: false,
      db: false,
      error: err?.message ?? "database unavailable",
    });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/pages", publicPagesRouter);
app.use("/api/admin/pages", adminPagesRouter);
app.use("/api/contact", contactRouter);
app.use("/api/application", applicationRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/docusign", docusignRouter);
app.use("/api/admin/applications", adminApplicationsRouter);
app.use("/api/admin/setup", adminSetupRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/site-settings", siteSettingsRouter);
app.use("/api/admin/site-settings", adminSiteSettingsRouter);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error("Unhandled API error:", err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  // Verify DB connection
  await prisma.$connect();
  console.log("Connected to PostgreSQL");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
