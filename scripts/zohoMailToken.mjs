import "dotenv/config";

/**
 * Exchange a Zoho Self Client grant code for a refresh token.
 *
 * 1. Open https://api-console.zoho.eu/  (EU — matches smtppro.zoho.eu)
 * 2. Add Client → Self Client. Copy Client ID and Client Secret into .env
 * 3. Generate Code with scopes:
 *      ZohoMail.messages.CREATE,ZohoMail.accounts.READ
 *    Duration: 10 minutes
 * 4. Run immediately:
 *      node scripts/zohoMailToken.mjs <grant-code>
 */

const code = process.argv[2];
const region = (process.env.ZOHO_REGION || "eu").trim().toLowerCase();
const tld =
  region === "eu"
    ? "eu"
    : region === "in"
      ? "in"
      : region === "uk"
        ? "uk"
        : region === "au"
          ? "com.au"
          : "com";
const accountsBase = `https://accounts.zoho.${tld}`;
const clientId = process.env.ZOHO_CLIENT_ID?.trim();
const clientSecret = process.env.ZOHO_CLIENT_SECRET?.trim();

if (!code || code === "-h" || code === "--help") {
  console.log(`Usage: node scripts/zohoMailToken.mjs <grant-code>

Create a Self Client at https://api-console.zoho.${tld}/
Scopes: ZohoMail.messages.CREATE,ZohoMail.accounts.READ

Then put ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env and run this with the code.`);
  process.exit(code ? 0 : 1);
}

if (!clientId || !clientSecret) {
  console.error("Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const res = await fetch(`${accountsBase}/oauth/v2/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
  }),
});

const data = await res.json().catch(() => ({}));
if (!res.ok || !data.refresh_token) {
  console.error("Token exchange failed:", data.error_description || data.error || data);
  process.exit(1);
}

console.log("Add this to .env (do not commit it):");
console.log(`ZOHO_REFRESH_TOKEN=${data.refresh_token}`);
if (data.access_token) {
  console.log("Access token received; the API will refresh it automatically.");
}
