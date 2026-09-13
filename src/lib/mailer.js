import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANCELLATION_FORM_PATH = join(
  __dirname,
  "../assets/emails/FIPO-Cancellation-Form.docx"
);
const CANCELLATION_FORM_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Email transport:
 *   EMAIL_TRANSPORT=mailjet-api — HTTPS (works on DigitalOcean; SMTP port 587 is often blocked)
 *   SMTP_HOST + SMTP_PORT      — nodemailer SMTP
 *   (neither)                  — console stub [EMAIL:STUB]
 */
let transporter = null;
let usingStub = false;
let transportMode = "stub";

const EMAIL_FROM = process.env.EMAIL_FROM || "FIPO <noreply@fipo.co.uk>";

let cancellationFormAttachment;

function parseFromAddress(from) {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: "", email: from.trim() };
}

function consultantName(user) {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return name || "Consultant";
}

function formatUkDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function getCancellationFormAttachment() {
  if (cancellationFormAttachment !== undefined) return cancellationFormAttachment;
  try {
    cancellationFormAttachment = {
      filename: "FIPO-Cancellation-Form.docx",
      content: readFileSync(CANCELLATION_FORM_PATH),
      contentType: CANCELLATION_FORM_TYPE,
    };
  } catch (err) {
    console.error("Cancellation form missing:", err.message);
    cancellationFormAttachment = null;
  }
  return cancellationFormAttachment;
}

function resolveTransportMode() {
  const explicit = (process.env.EMAIL_TRANSPORT || "").trim().toLowerCase();
  if (explicit === "mailjet-api" || explicit === "mailjet") return "mailjet-api";
  if (explicit === "smtp") return "smtp";

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (SMTP_HOST && SMTP_PORT) return "smtp";
  if (SMTP_USER && SMTP_PASS && !SMTP_HOST) return "mailjet-api";

  return "stub";
}

function getTransporter() {
  if (transporter) return transporter;

  transportMode = resolveTransportMode();

  if (transportMode === "smtp") {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    usingStub = false;
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true" || Number(SMTP_PORT) === 465,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
    console.log(
      `[EMAIL] SMTP transport: ${SMTP_HOST}:${SMTP_PORT} (auth=${Boolean(SMTP_USER && SMTP_PASS)})`
    );
  } else if (transportMode === "mailjet-api") {
    usingStub = false;
    console.log("[EMAIL] Mailjet API transport (HTTPS)");
  } else {
    usingStub = true;
    transporter = nodemailer.createTransport({ jsonTransport: true });
    console.warn("[EMAIL] Not configured — emails logged only ([EMAIL:STUB])");
  }

  return transporter;
}

function getMailjetCredentials() {
  const apiKey = process.env.MAILJET_API_KEY || process.env.SMTP_USER;
  const secret = process.env.MAILJET_SECRET_KEY || process.env.SMTP_PASS;
  if (!apiKey || !secret) {
    throw new Error("Mailjet API key and secret are required (SMTP_USER / SMTP_PASS)");
  }
  return { apiKey, secret };
}

function toMailjetAttachments(attachments = []) {
  return attachments
    .filter((file) => file?.content && file?.filename)
    .map((file) => ({
      ContentType: file.contentType || "application/octet-stream",
      Filename: file.filename,
      Base64Content: Buffer.isBuffer(file.content)
        ? file.content.toString("base64")
        : Buffer.from(file.content).toString("base64"),
    }));
}

async function sendViaMailjetApi({ to, subject, html, text, attachments = [] }) {
  const { apiKey, secret } = getMailjetCredentials();
  const { name, email } = parseFromAddress(EMAIL_FROM);
  const auth = Buffer.from(`${apiKey}:${secret}`).toString("base64");
  const mailjetAttachments = toMailjetAttachments(attachments);

  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: email, ...(name ? { Name: name } : {}) },
          To: [{ Email: to }],
          Subject: subject,
          TextPart: text,
          HTMLPart: html,
          ...(mailjetAttachments.length ? { Attachments: mailjetAttachments } : {}),
        },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiError =
      data?.Messages?.[0]?.Errors?.[0]?.ErrorMessage ||
      data?.ErrorMessage ||
      data?.message ||
      res.statusText;
    throw new Error(apiError || `Mailjet API HTTP ${res.status}`);
  }

  const messageId =
    data?.Messages?.[0]?.To?.[0]?.MessageID ||
    data?.Messages?.[0]?.MessageID ||
    data?.Messages?.[0]?.MessageUUID;

  return { ok: true, id: messageId ? String(messageId) : undefined };
}

export async function sendMail({ to, subject, html, text, attachments = [] }) {
  const mode = transportMode === "stub" ? resolveTransportMode() : transportMode;
  transportMode = mode;
  const files = Array.isArray(attachments) ? attachments.filter(Boolean) : [];

  try {
    if (mode === "mailjet-api") {
      const result = await sendViaMailjetApi({ to, subject, html, text, attachments: files });
      console.log(`[EMAIL] Sent to ${to} | Subject: ${subject} | id=${result.id || "n/a"}`);
      return result;
    }

    const tx = getTransporter();
    const info = await tx.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      html,
      text,
      attachments: files.map((file) => ({
        filename: file.filename,
        content: file.content,
        contentType: file.contentType,
      })),
    });
    if (usingStub) {
      console.log(`\n[EMAIL:STUB] To: ${to} | Subject: ${subject}`);
      console.log(`[EMAIL:STUB] Body:\n${text || html}\n`);
      if (files.length) {
        console.log(
          `[EMAIL:STUB] Attachments: ${files.map((file) => file.filename).join(", ")}`
        );
      }
    } else {
      console.log(`[EMAIL] Sent to ${to} | Subject: ${subject} | id=${info.messageId || "n/a"}`);
    }
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error("sendMail failed:", err.message);
    if (err.response) console.error("sendMail SMTP response:", err.response);
    return { ok: false, error: err.message };
  }
}

function baseTemplate(title, bodyHtml) {
  return `
  <div style="margin:0;padding:0;background:#f7f2f8;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2f8;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ece3ef;">
          <tr><td style="background:#802B7D;padding:24px 32px;">
            <span style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:1px;">FIPO</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 16px;font-size:20px;color:#263238;">${title}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:20px 32px;background:#faf7fb;border-top:1px solid #ece3ef;">
            <p style="margin:0;font-size:12px;color:#9c8ba6;">
              Federation of Independent Practitioner Organisations —
              Fighting for Fair Pay in Private Practice.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}

/**
 * Welcome email sent immediately after a user registers.
 * Contains their login email and a link to sign in.
 */
export async function sendWelcomeEmail(user) {
  const appBase = process.env.APP_BASE_URL || "http://localhost:3000";
  const loginUrl = `${appBase}/login`;
  const name = user.firstName ? `${user.firstName}` : "there";

  const html = baseTemplate(
    `Welcome to FIPO, ${name}!`,
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Thank you for registering with the FIPO Fair Pay Action Group. Your
        account has been created successfully and you can now sign in to
        continue your application.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        <tr><td style="font-size:13px;color:#6b6b6b;padding:4px 0;">Login email</td></tr>
        <tr><td style="font-size:15px;color:#263238;font-weight:bold;padding:0 0 8px;">${user.email}</td></tr>
      </table>
      <a href="${loginUrl}"
        style="display:inline-block;background:#802B7D;color:#ffffff;text-decoration:none;
        font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;letter-spacing:1px;">
        SIGN IN TO YOUR ACCOUNT
      </a>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:24px 0 0;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${loginUrl}" style="color:#802B7D;">${loginUrl}</a>
      </p>
    `
  );

  const text = `Welcome to FIPO, ${name}!

Your account has been created successfully.

Login email: ${user.email}

Sign in to continue your application: ${loginUrl}

— FIPO Fair Pay Action Group`;

  return sendMail({
    to: user.email,
    subject: "Welcome to FIPO — your account is ready",
    html,
    text,
  });
}

/**
 * Password reset email — contains a time-limited link to set a new password.
 */
export async function sendPasswordResetEmail(user, resetToken) {
  const appBase = process.env.APP_BASE_URL || "http://localhost:3000";
  const resetUrl = `${appBase}/reset-password?token=${resetToken}`;
  const name = user.firstName ? `${user.firstName}` : "there";

  const html = baseTemplate(
    "Reset your FIPO password",
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Hi ${name}, we received a request to reset the password for your FIPO
        account. Click the button below to choose a new password. This link
        will expire in 1 hour.
      </p>
      <a href="${resetUrl}"
        style="display:inline-block;background:#802B7D;color:#ffffff;text-decoration:none;
        font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;letter-spacing:1px;">
        RESET MY PASSWORD
      </a>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:24px 0 0;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${resetUrl}" style="color:#802B7D;">${resetUrl}</a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:16px 0 0;">
        If you didn't request this, you can safely ignore this email — your
        password will remain unchanged.
        
      </p>
    `
  );

  const text = `Hi ${name},

We received a request to reset your FIPO password.

Reset your password (link expires in 1 hour): ${resetUrl}

If you didn't request this, you can safely ignore this email.

— FIPO Fair Pay Action Group`;

  return sendMail({
    to: user.email,
    subject: "Reset your FIPO password",
    html,
    text,
  });
}

/**
 * Welcome email sent after a consultant successfully registers onto the claim.
 * Attaches the signed legal documents (PDF) and the cancellation form (Word).
 */
export async function sendClaimWelcomeEmail(user, application, options = {}) {
  const name = consultantName(user);
  const safeName = escapeHtml(name);
  const signedDate =
    formatUkDate(application?.legalSignedAt) || formatUkDate(new Date());
  const cancelExample = `I hereby give you notice that I wish to cancel my involvement in the proposed proceedings, which I entered into on ${signedDate}.`;

  const p =
    'style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;"';
  const h =
    'style="font-size:14px;line-height:1.6;color:#263238;font-weight:bold;margin:24px 0 8px;"';

  const html = baseTemplate(
    "Welcome",
    `
      <p ${p}>Dear ${safeName},</p>
      <p ${p}>
        Many thanks for taking the time to join our proposed legal proceedings.
        We look forward to working with you on this over the coming months.
      </p>
      <p ${p}>
        To that end, we attach the formal legal documents which you have signed,
        so that you can keep them for your own records.
      </p>
      <p ${h}>Your right to cancel</p>
      <p ${p}>
        You have a 14-calendar-day period from the date you signed the documents
        in which you may cancel your involvement in these proceedings, with
        immediate effect and without giving any reason, at no cost to you.
        To cancel, simply email
        <a href="mailto:FIPO@harcusparker.co.uk" style="color:#802B7D;">FIPO@harcusparker.co.uk</a>,
        stating, for example: &ldquo;${escapeHtml(cancelExample)}&rdquo;
        A cancellation form is also attached for your convenience, should you
        prefer to use it.
      </p>
      <p ${h}>Who we are</p>
      <p ${p}>
        Harcus Parker Limited is the firm of solicitors advising on these legal
        proceedings. Its registered address is 80 Strand, London WC2R 0DT,
        Tel: <a href="tel:+442033988300" style="color:#802B7D;">+44 (0) 20 3398 8300</a>,
        <a href="https://www.harcusparker.co.uk" style="color:#802B7D;">www.harcusparker.co.uk</a>.
      </p>
      <p ${h}>What happens next</p>
      <p ${p}>
        Our next steps include involving as many other consultants as possible
        in this claim, before formally issuing proceedings against the PMIs,
        and, in due course, agreeing a new funding package with commercial
        litigation funders.
      </p>
      <p ${p}>Kind regards,</p>
      <p style="font-size:14px;line-height:1.6;color:#263238;font-weight:bold;margin:0;">
        Harcus Parker Limited
      </p>
    `
  );

  const text = `Dear ${name},

Many thanks for taking the time to join our proposed legal proceedings. We look forward to working with you on this over the coming months.

To that end, we attach the formal legal documents which you have signed, so that you can keep them for your own records.

Your right to cancel

You have a 14-calendar-day period from the date you signed the documents in which you may cancel your involvement in these proceedings, with immediate effect and without giving any reason, at no cost to you. To cancel, simply email FIPO@harcusparker.co.uk, stating, for example: "${cancelExample}" A cancellation form is also attached for your convenience, should you prefer to use it.

Who we are

Harcus Parker Limited is the firm of solicitors advising on these legal proceedings. Its registered address is 80 Strand, London WC2R 0DT, Tel: +44 (0) 20 3398 8300, www.harcusparker.co.uk.

What happens next

Our next steps include involving as many other consultants as possible in this claim, before formally issuing proceedings against the PMIs, and, in due course, agreeing a new funding package with commercial litigation funders.

Kind regards,

Harcus Parker Limited`;

  const attachments = [];
  const cancellationForm = getCancellationFormAttachment();
  if (cancellationForm) attachments.push(cancellationForm);

  const signedPdf = options.signedDocumentsPdf;
  if (signedPdf) {
    attachments.push({
      filename: "FIPO-Legal-Documents.pdf",
      content: signedPdf,
      contentType: "application/pdf",
    });
  }

  const result = await sendMail({
    to: user.email,
    subject: "Welcome — your registration onto the proposed legal proceedings",
    html,
    text,
    attachments,
  });

  if (!result.ok && attachments.length) {
    console.error(
      "Claim welcome email with attachments failed, retrying without signed PDF:",
      result.error
    );
    const formOnly = attachments.filter((file) =>
      String(file.filename).endsWith(".docx")
    );
    const retry = await sendMail({
      to: user.email,
      subject: "Welcome — your registration onto the proposed legal proceedings",
      html,
      text,
      attachments: formOnly,
    });
    return retry;
  }

  return result;
}

/**
 * Confirmation email sent once an application is submitted for review.
 * Claimants receive the Harcus Parker welcome letter with attachments.
 */
export async function sendApplicationSubmittedEmail(user, application, options = {}) {
  if (application?.applicationType === "CLAIMANT") {
    return sendClaimWelcomeEmail(user, application, options);
  }

  const appBase = process.env.APP_BASE_URL || "http://localhost:3000";
  const dashboardUrl = `${appBase}/dashboard`;
  const name = user.firstName ? `${user.firstName}` : "there";

  const html = baseTemplate(
    "Your application has been submitted",
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Thank you, ${name}. Your supporter application has been submitted
        successfully and is now confirmed.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Thank you for supporting the FIPO Fair Pay Action Group.
      </p>
      <a href="${dashboardUrl}"
        style="display:inline-block;background:#802B7D;color:#ffffff;text-decoration:none;
        font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;letter-spacing:1px;">
        VIEW MY DASHBOARD
      </a>
    `
  );

  const text = `Thank you, ${name}.

Your supporter application has been submitted successfully.

View your dashboard: ${dashboardUrl}

— FIPO Fair Pay Action Group`;

  return sendMail({
    to: user.email,
    subject: "Your FIPO application is confirmed",
    html,
    text,
  });
}

/**
 * Sent when the supporter registration step is completed (step 1 → step 2).
 */
export async function sendSupporterMemberEmail(user) {
  const appBase = process.env.APP_BASE_URL || "http://localhost:3000";
  const registerUrl = `${appBase}/register?form=1`;
  const name = user.firstName ? `${user.firstName}` : "there";

  const html = baseTemplate(
    "You are now a supporter member",
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Dear ${name}, you are now a supporter member of the FIPO Fair Pay Action Group.
        Thank you for registering your support.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        You can continue your registration to complete membership payment and the
        remaining steps at any time.
      </p>
      <a href="${registerUrl}"
        style="display:inline-block;background:#802B7D;color:#ffffff;text-decoration:none;
        font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;letter-spacing:1px;">
        CONTINUE REGISTRATION
      </a>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:24px 0 0;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${registerUrl}" style="color:#802B7D;">${registerUrl}</a>
      </p>
    `
  );

  const text = `Dear ${name},

You are now a supporter member of the FIPO Fair Pay Action Group.
Thank you for registering your support.

Continue your registration: ${registerUrl}

— FIPO Fair Pay Action Group`;

  return sendMail({
    to: user.email,
    subject: "You are now a supporter member",
    html,
    text,
  });
}

/**
 * Sent when a user saves their registration progress and requests a resume link.
 */
export async function sendSaveResumeEmail(user, resumeUrl) {
  const name = user.firstName ? `${user.firstName}` : "there";

  const html = baseTemplate(
    "Continue your FIPO registration",
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Hi ${name}, your registration progress has been saved. Use the link below
        to return and continue where you left off. This link is valid for 7 days
        and can be opened in any browser.
      </p>
      <a href="${resumeUrl}"
        style="display:inline-block;background:#802B7D;color:#ffffff;text-decoration:none;
        font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;letter-spacing:1px;">
        RESUME REGISTRATION
      </a>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:24px 0 0;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${resumeUrl}" style="color:#802B7D;">${resumeUrl}</a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:16px 0 0;">
        If you did not request this, you can safely ignore this email.
      </p>
    `
  );

  const text = `Hi ${name},

Your registration progress has been saved. Use this link to continue where you left off (valid for 7 days):

${resumeUrl}

If you did not request this, you can safely ignore this email.

— FIPO Fair Pay Action Group`;

  return sendMail({
    to: user.email,
    subject: "Your FIPO registration — resume link",
    html,
    text,
  });
}

/**
 * Email the witness a DocuSign signing link. After they finish, DocuSign
 * redirects to the homepage (returnUrl on the recipient view).
 */
export async function sendWitnessSigningEmail({
  to,
  witnessName,
  claimantName,
  signingUrl,
}) {
  const name = escapeHtml(witnessName?.trim() || "there");
  const who = escapeHtml(claimantName?.trim() || "a FIPO claimant");
  const href = escapeHtmlAttr(String(signingUrl || "").trim());

  const html = baseTemplate(
    "Please sign the Litigation Management Agreement",
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Hello ${name},
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        ${who} has asked you to witness and sign the Litigation Management Agreement
        for the FIPO Fair Pay Action Group.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 20px;">
        Click the button below to review and sign in DocuSign. When you have finished,
        you will be returned to the FIPO homepage.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
        <tr>
          <td align="center" bgcolor="#802B7D" style="border-radius:8px;background-color:#802B7D;">
            <a href="${href}" target="_blank" rel="noopener noreferrer"
              style="display:inline-block;background-color:#802B7D;color:#ffffff !important;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;line-height:20px;padding:14px 28px;border:1px solid #802B7D;border-radius:8px;letter-spacing:1px;">
              REVIEW AND SIGN
            </a>
          </td>
        </tr>
      </table>
      <p style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:0;">
        If the button doesn&apos;t work, copy and paste this link into your browser:<br/>
        <a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#802B7D;word-break:break-all;">${href}</a>
      </p>
    `
  );

  const text = `Hello ${witnessName?.trim() || "there"},

${claimantName?.trim() || "a FIPO claimant"} has asked you to witness and sign the Litigation Management Agreement for the FIPO Fair Pay Action Group.

Open this link to review and sign in DocuSign:
${signingUrl}

When you have finished, you will be returned to the FIPO homepage.

— FIPO Fair Pay Action Group`;

  return sendMail({
    to,
    subject: "FIPO — please sign as witness",
    html,
    text,
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value);
}
