import "dotenv/config";
import { getEnvelopeStatus } from "../src/lib/docusignClient.js";

const envelopeId = process.argv[2];
if (!envelopeId) {
  console.error("Usage: node scripts/checkEnvelope.mjs <envelopeId>");
  process.exit(1);
}

const token = await import("../src/lib/docusignClient.js").then(async (m) => {
  // reuse internal request via getEnvelopeStatus + raw fetch
  return null;
});

async function getAccessToken() {
  const jwt = await import("jsonwebtoken");
  const privateKey = process.env.DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, "\n");
  const authHost =
    process.env.DOCUSIGN_ENV === "production"
      ? "account.docusign.com"
      : "account-d.docusign.com";
  const assertion = jwt.default.sign(
    {
      iss: process.env.DOCUSIGN_INTEGRATION_KEY,
      sub: process.env.DOCUSIGN_USER_ID,
      aud: authHost,
      scope: "signature impersonation",
    },
    privateKey,
    { algorithm: "RS256", expiresIn: "10m" }
  );
  const authBase =
    process.env.DOCUSIGN_ENV === "production"
      ? "https://account.docusign.com"
      : "https://account-d.docusign.com";
  const res = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await res.json();
  return data.access_token;
}

const accessToken = await getAccessToken();
const apiBase =
  process.env.DOCUSIGN_API_BASE ||
  (process.env.DOCUSIGN_ENV === "production"
    ? "https://na1.docusign.net/restapi"
    : "https://demo.docusign.net/restapi");
const url = `${apiBase}/v2.1/accounts/${process.env.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}?include=recipients,tabs`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const envelope = await res.json();
console.log(JSON.stringify(envelope, null, 2));
