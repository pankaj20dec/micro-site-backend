import "dotenv/config";
import { prisma } from "../src/config/db.js";

const users = await prisma.user.findMany({
  select: { id: true, email: true, role: true, firstName: true, lastName: true },
  orderBy: { createdAt: "desc" },
});

console.log(JSON.stringify(users, null, 2));
process.exit(0);
