import "dotenv/config";
import { saveEvidenceBuffer, isSpacesConfigured, getSpacesConfig } from "../src/lib/spacesStorage.js";

if (!isSpacesConfigured()) {
  console.error("Spaces is not configured. Check DO_SPACES_* in .env");
  process.exit(1);
}

const config = getSpacesConfig();
console.log("Spaces config:", {
  endpoint: config.endpoint,
  region: config.region,
  bucket: config.bucket,
  keySet: !!config.accessKeyId,
});

const testKey = `evidence/_diagnostic/${Date.now()}-test.txt`;

try {
  const storage = await saveEvidenceBuffer(testKey, Buffer.from("fipo spaces test"), "text/plain");
  console.log("Upload OK:", storage, testKey);
  process.exit(0);
} catch (err) {
  console.error("Upload FAILED:", err.message);
  process.exit(1);
}
