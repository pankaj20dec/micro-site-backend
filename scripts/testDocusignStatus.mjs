import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/db.js";

const refresh = process.argv.includes("--refresh");
const viaNext = process.argv.includes("--via-next");
const email =
  process.argv.find((a) => a.includes("@")) || "pankajgupta20dec@gmail.com";

const user = await prisma.user.findFirst({
  where: { email },
  select: { id: true, email: true, role: true },
});

if (!user) {
  console.error("User not found:", email);
  process.exit(1);
}

const token = jwt.sign(
  { sub: user.id, email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
);

const base = viaNext ? "http://127.0.0.1:3000" : "http://127.0.0.1:5000";
const path = refresh ? "/api/docusign/status?refresh=1" : "/api/docusign/status";

const res = await fetch(`${base}${path}`, {
  headers: { Authorization: `Bearer ${token}` },
});

const text = await res.text();
console.log("status", res.status);
console.log(text.slice(0, 1500));

await prisma.$disconnect();
