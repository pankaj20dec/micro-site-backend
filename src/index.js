import "dotenv/config";
import { applyMongoDnsFromEnv } from "./config/mongoDns.js";
import express from "express";
import cors from "cors";
import { connectDb } from "./config/db.js";
import { authRouter } from "./routes/auth.js";
import { publicPagesRouter } from "./routes/publicPages.js";
import { adminPagesRouter } from "./routes/adminPages.js";

applyMongoDnsFromEnv();

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const corsOriginEnv = process.env.CORS_ORIGIN;
const corsAllowList = (corsOriginEnv || "http://localhost:3000,http://127.0.0.1:3000")
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
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/pages", publicPagesRouter);
app.use("/api/admin/pages", adminPagesRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

async function main() {
  await connectDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
