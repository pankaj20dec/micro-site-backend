import dns from "node:dns";

/**
 * Node's SRV lookup for mongodb+srv:// can fail on some Windows setups while
 * nslookup in another shell works. Setting explicit resolvers fixes many cases.
 * Call after dotenv/config has loaded.
 */
export function applyMongoDnsFromEnv() {
  const raw = process.env.MONGODB_DNS_SERVERS;
  if (typeof raw !== "string" || !raw.trim()) return;
  const servers = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!servers.length) return;
  dns.setServers(servers);
  console.log("[mongo] Using DNS servers for SRV:", servers.join(", "));
}
