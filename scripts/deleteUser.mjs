import "dotenv/config";
import { prisma } from "../src/config/db.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/deleteUser.mjs <email>");
  process.exit(1);
}

const target = email.toLowerCase().trim();

const user = await prisma.user.findUnique({
  where: { email: target },
  include: { applications: true },
});

if (!user) {
  console.log(`No user found with email: ${target}`);
  process.exit(0);
}

console.log(
  `Deleting user ${user.email} (id: ${user.id}) — ${user.applications.length} application(s) will cascade.`
);

await prisma.user.delete({ where: { id: user.id } });

console.log("Deleted successfully.");
process.exit(0);
