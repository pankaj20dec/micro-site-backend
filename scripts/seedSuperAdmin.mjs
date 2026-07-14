import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/config/db.js";

const emailArg = process.argv[2]?.toLowerCase().trim();
const passwordArg = process.argv[3];

const email = (emailArg || process.env.ADMIN_EMAIL)?.toLowerCase().trim();
const password = passwordArg || process.env.ADMIN_PASSWORD;

if (!email) {
  console.error(
    "Usage: node scripts/seedSuperAdmin.mjs <email> [password]\n" +
      "   or set ADMIN_EMAIL and ADMIN_PASSWORD in .env"
  );
  process.exit(1);
}

const existing = await prisma.user.findUnique({ where: { email } });

if (existing) {
  if (existing.role === "SUPER_ADMIN") {
    console.log(`Already SUPER_ADMIN: ${email}`);
    process.exit(0);
  }

  await prisma.user.update({
    where: { id: existing.id },
    data: { role: "SUPER_ADMIN" },
  });

  console.log(`Promoted to SUPER_ADMIN: ${email}`);
  process.exit(0);
}

if (!password || password.length < 8) {
  console.error(
    `No user found for ${email}. Provide a password (min 8 chars) to create a new super admin:\n` +
      `  node scripts/seedSuperAdmin.mjs ${email} YourPassword123`
  );
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);

const user = await prisma.user.create({
  data: {
    firstName: "Super",
    lastName: "Admin",
    email,
    passwordHash,
    role: "SUPER_ADMIN",
  },
  select: { id: true, email: true, role: true },
});

console.log(`Created SUPER_ADMIN: ${user.email} (id: ${user.id})`);
process.exit(0);
