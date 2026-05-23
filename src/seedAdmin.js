import "dotenv/config";
import { applyMongoDnsFromEnv } from "./config/mongoDns.js";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "./models/User.js";

applyMongoDnsFromEnv();

const uri = process.env.MONGODB_URI;
const email = process.env.ADMIN_EMAIL || "admin@example.com";
const password = process.env.ADMIN_PASSWORD || "changeme123";

async function run() {
  if (!uri) {
    console.error("Set MONGODB_URI in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const passwordHash = await bcrypt.hash(password, 10);
  await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { email: email.toLowerCase(), passwordHash, role: "admin" },
    { upsert: true, new: true }
  );
  console.log(`Admin ready: ${email}`);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
