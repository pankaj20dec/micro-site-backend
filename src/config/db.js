import { readFileSync } from "node:fs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const rawConnectionString = process.env.DATABASE_URL;
if (!rawConnectionString) throw new Error("DATABASE_URL is not set");

function parseDatabaseUrl(urlString) {
  try {
    return new URL(urlString.replace(/^postgresql:/i, "postgres:"));
  } catch {
    return null;
  }
}

function isManagedPostgresHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return (
    host.includes("ondigitalocean.com") ||
    host.includes("db.ondigitalocean.com") ||
    host.includes("rds.amazonaws.com") ||
    host.endsWith(".postgres.database.azure.com")
  );
}

function connectionRequiresTls(urlString) {
  const explicit = (process.env.DATABASE_SSL || "").trim().toLowerCase();
  if (explicit === "false" || explicit === "disable" || explicit === "off") {
    return false;
  }
  if (explicit === "true" || explicit === "require" || explicit === "on") {
    return true;
  }

  const url = parseDatabaseUrl(urlString);
  if (!url) return false;

  const sslParam = (url.searchParams.get("sslmode") || url.searchParams.get("ssl") || "").toLowerCase();
  if (["require", "verify-ca", "verify-full", "true", "1", "prefer"].includes(sslParam)) {
    return true;
  }
  if (["disable", "false", "0", "off"].includes(sslParam)) {
    return false;
  }

  const port = Number(url.port || 5432);
  if (port === 25060) return true;

  if (isManagedPostgresHost(url.hostname)) return true;

  return false;
}

function stripTlsQueryParams(urlString) {
  const url = parseDatabaseUrl(urlString);
  if (!url) return urlString;

  let changed = false;
  for (const key of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return urlString;
  return url.toString().replace(/^postgres:/i, "postgresql:");
}

function resolveSslConfig(needsTls, urlString) {
  if (!needsTls) return undefined;

  const url = parseDatabaseUrl(urlString);
  const sslmode = (url?.searchParams.get("sslmode") || "").toLowerCase();
  const caPath =
    process.env.DATABASE_SSL_CA?.trim() || url?.searchParams.get("sslrootcert")?.trim();

  // DigitalOcean verify-full: https://docs.digitalocean.com/products/databases/postgresql/how-to/connect/
  if (caPath && (sslmode === "verify-full" || sslmode === "verify-ca" || process.env.DATABASE_SSL_CA)) {
    return {
      rejectUnauthorized: true,
      ca: readFileSync(caPath, "utf8"),
    };
  }

  // DigitalOcean default sslmode=require: encrypt in transit, no CA file needed.
  // Node pg still needs rejectUnauthorized:false (unlike psql).
  return { rejectUnauthorized: false };
}

const needsTls = connectionRequiresTls(rawConnectionString);
const connectionString = needsTls ? stripTlsQueryParams(rawConnectionString) : rawConnectionString;
const ssl = resolveSslConfig(needsTls, rawConnectionString);
if (needsTls) {
  console.log(
    `PostgreSQL TLS enabled (rejectUnauthorized=${ssl?.rejectUnauthorized === true ? "true" : "false"})`
  );
}
const pool = new pg.Pool(ssl ? { connectionString, ssl } : { connectionString });
const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter, log: ["error"] });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
