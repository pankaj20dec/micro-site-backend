import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/db.js";

const withPmi = process.argv.includes("--pmi");
const emailArg = process.argv.find((a) => !a.startsWith("-") && a.endsWith(".mjs") === false && !a.includes("node"));
const email = emailArg && !emailArg.includes("\\") && emailArg.includes("@")
  ? emailArg
  : "pankajgupta20dec@gmail.com";

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

const body = {
  returnBaseUrl: "http://localhost:3000",
  attachPmiEvidence: withPmi,
};

const base = process.argv.includes("--via-next")
  ? "http://127.0.0.1:3000"
  : "http://127.0.0.1:5000";

const res = await fetch(`${base}/api/docusign/send`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log("status", res.status);
console.log(text);

await prisma.$disconnect();
