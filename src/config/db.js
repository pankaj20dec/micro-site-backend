import { readFileSync } from "node:fs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

function resolveSslConfig() {
  const explicit = (process.env.DATABASE_SSL || "").trim().toLowerCase();
  if (explicit === "false" || explicit === "disable" || explicit === "off") {
    return undefined;
  }

  const caPath = process.env.DATABASE_SSL_CA?.trim();
  if (caPath) {
    return {
      rejectUnauthorized: true,
      ca: readFileSync(caPath, "utf8"),
    };
  }

  const urlRequiresSsl = /(?:^|[?&])ssl(?:mode)?=(?:require|verify-ca|verify-full|true|1)(?:&|$)/i.test(
    connectionString
  );

  const shouldUseSsl =
    explicit === "true" || explicit === "require" || explicit === "on" || urlRequiresSsl;

  if (!shouldUseSsl) {
    return undefined;
  }

  const rejectUnauthorized =
    (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || "false").trim().toLowerCase() === "true";

  return { rejectUnauthorized };
}

const ssl = resolveSslConfig();
const pool = new pg.Pool(ssl ? { connectionString, ssl } : { connectionString });
const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter, log: ["error"] });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
