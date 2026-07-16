import "dotenv/config";
import { sendMail } from "../src/lib/mailer.js";

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/testEmail.mjs <recipient@email.com>");
  process.exit(1);
}

const result = await sendMail({
  to,
  subject: "FIPO SMTP test",
  text: "If you received this, Mailjet SMTP is working.",
  html: "<p>If you received this, <strong>Mailjet SMTP</strong> is working.</p>",
});

if (result.ok) {
  console.log("Test email accepted by SMTP server.", result.id ? `id=${result.id}` : "");
} else {
  console.error("Test email failed:", result.error);
  process.exit(1);
}
