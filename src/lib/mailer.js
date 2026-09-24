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
 *   EMAIL_TRANSPORT=zoho        — Zoho Mail HTTPS API if OAuth is set, else SMTP
 *   EMAIL_TRANSPORT=zoho-api    — Zoho Mail REST API (HTTPS :443) — use on DigitalOcean
 *   EMAIL_TRANSPORT=zeptomail   — Zoho ZeptoMail HTTPS API
 *   EMAIL_TRANSPORT=smtp        — generic SMTP via SMTP_HOST / SMTP_PORT
 *   EMAIL_TRANSPORT=mailjet-api — Mailjet HTTPS (legacy)
 *   (neither)                   — console stub [EMAIL:STUB]
 *
 * DigitalOcean blocks outbound SMTP (25/465/587). Connection timeout on
 * smtppro.zoho.eu means use zoho-api or zeptomail, not SMTP.
 */
let transporter = null;
let transportInitialized = false;
let usingStub = false;
let transportMode = "stub";
let zohoAccessToken = null;
let zohoAccessTokenExpiresAt = 0;
let zohoAccountIdCache = process.env.ZOHO_ACCOUNT_ID?.trim() || "";

const EMAIL_FROM = process.env.EMAIL_FROM || "FIPO <noreply@fipo.co.uk>";

let cancellationFormAttachment;

function parseFromAddress(from) {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2].trim() };
  return { name: "", email: from.trim() };
}

function fromDisplayName() {
  return (
    process.env.EMAIL_FROM_NAME?.trim() ||
    parseFromAddress(EMAIL_FROM).name ||
    "FIPO"
  );
}

function zohoFromAddress() {
  const email =
    parseFromAddress(EMAIL_FROM).email || process.env.SMTP_USER?.trim() || "";
  const name = fromDisplayName();
  return name ? `${name} <${email}>` : email;
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

function zohoRegion() {
  return (process.env.ZOHO_REGION || "").trim().toLowerCase();
}

function zohoTld() {
  const region = zohoRegion();
  if (region === "eu") return "eu";
  if (region === "in") return "in";
  if (region === "uk") return "uk";
  if (region === "au") return "com.au";
  return "com";
}

function zohoAccountsBase() {
  return `https://accounts.zoho.${zohoTld()}`;
}

function zohoMailApiBase() {
  return `https://mail.zoho.${zohoTld()}`;
}

function zohoSmtpHost() {
  if (process.env.SMTP_HOST?.trim()) return process.env.SMTP_HOST.trim();

  const region = zohoRegion();
  const pro =
    (process.env.ZOHO_PRO || "").trim().toLowerCase() === "true" ||
    (process.env.ZOHO_PRO || "").trim() === "1";
  const prefix = pro ? "smtppro" : "smtp";

  if (region === "eu") return `${prefix}.zoho.eu`;
  if (region === "in") return `${prefix}.zoho.in`;
  if (region === "uk") return `${prefix}.zoho.uk`;
  return `${prefix}.zoho.com`;
}

function zeptoMailApiUrl() {
  const explicit = process.env.ZEPTOMAIL_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const tld = zohoTld();
  if (tld === "eu") return "https://api.zeptomail.eu/v1.1/email";
  if (tld === "in") return "https://api.zeptomail.in/v1.1/email";
  return "https://api.zeptomail.com/v1.1/email";
}

function hasZohoOauth() {
  return Boolean(
    process.env.ZOHO_CLIENT_ID?.trim() &&
      process.env.ZOHO_CLIENT_SECRET?.trim() &&
      process.env.ZOHO_REFRESH_TOKEN?.trim()
  );
}

function hasZeptoMailToken() {
  return Boolean(
    process.env.ZEPTOMAIL_TOKEN?.trim() ||
      process.env.ZEPTOMAIL_SEND_MAIL_TOKEN?.trim()
  );
}

function resolveTransportMode() {
  const explicit = (process.env.EMAIL_TRANSPORT || "").trim().toLowerCase();
  if (explicit === "mailjet-api" || explicit === "mailjet") return "mailjet-api";
  if (explicit === "zoho-api" || explicit === "zoho_api") return "zoho-api";
  if (explicit === "zeptomail" || explicit === "zepto") return "zeptomail";
  if (explicit === "zoho") {
    if (hasZohoOauth()) return "zoho-api";
    if (hasZeptoMailToken()) return "zeptomail";
    return "smtp";
  }
  if (explicit === "smtp") return "smtp";

  if (hasZohoOauth()) return "zoho-api";
  if (hasZeptoMailToken()) return "zeptomail";

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (SMTP_HOST && SMTP_PORT) return "smtp";
  if (SMTP_USER && SMTP_PASS && !SMTP_HOST) return "mailjet-api";

  return "stub";
}

function getTransporter() {
  if (transportInitialized) return transporter;

  transportMode = resolveTransportMode();
  transportInitialized = true;
  const explicit = (process.env.EMAIL_TRANSPORT || "").trim().toLowerCase();
  const useZoho = explicit === "zoho" || explicit === "smtp";

  if (transportMode === "zoho-api" || transportMode === "zeptomail" || transportMode === "mailjet-api") {
    usingStub = false;
    const label =
      transportMode === "zoho-api"
        ? `Zoho Mail HTTPS API (${zohoMailApiBase()})`
        : transportMode === "zeptomail"
          ? `ZeptoMail HTTPS (${zeptoMailApiUrl()})`
          : "Mailjet API transport (HTTPS)";
    console.log(`[EMAIL] ${label}`);
    return null;
  }

  if (transportMode === "smtp") {
    const SMTP_HOST = useZoho || explicit === "zoho" ? zohoSmtpHost() : process.env.SMTP_HOST;
    const SMTP_PORT = Number(process.env.SMTP_PORT || (explicit === "zoho" ? 465 : 587));
    const { SMTP_USER, SMTP_PASS } = process.env;
    const secure =
      process.env.SMTP_SECURE === "true" ||
      SMTP_PORT === 465 ||
      (explicit === "zoho" && process.env.SMTP_SECURE !== "false");
    usingStub = false;
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure,
      requireTLS: !secure,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER.trim(), pass: SMTP_PASS.trim() } : undefined,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 20000,
    });
    console.log(
      `[EMAIL] SMTP transport: ${SMTP_HOST}:${SMTP_PORT} ssl=${secure} (auth=${Boolean(SMTP_USER && SMTP_PASS)})`
    );
    const fromEmail = parseFromAddress(EMAIL_FROM).email;
    if (SMTP_USER && fromEmail && SMTP_USER.toLowerCase() !== fromEmail.toLowerCase()) {
      console.warn(
        `[EMAIL] EMAIL_FROM (${fromEmail}) should match SMTP_USER (${SMTP_USER}) for Zoho.`
      );
    }
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

function zohoApiError(data, statusText, status) {
  return (
    data?.data?.moreInfo ||
    data?.data?.errorCode ||
    data?.message ||
    data?.status?.description ||
    data?.error_description ||
    data?.error ||
    statusText ||
    `Zoho Mail API HTTP ${status}`
  );
}

async function getZohoAccessToken() {
  const now = Date.now();
  if (zohoAccessToken && now < zohoAccessTokenExpiresAt - 60_000) {
    return zohoAccessToken;
  }

  const clientId = process.env.ZOHO_CLIENT_ID?.trim();
  const clientSecret = process.env.ZOHO_CLIENT_SECRET?.trim();
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Zoho Mail API needs ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN"
    );
  }

  const res = await fetch(`${zohoAccountsBase()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || `Zoho OAuth HTTP ${res.status}`
    );
  }

  zohoAccessToken = data.access_token;
  const expiresIn = Number(data.expires_in || 3600);
  zohoAccessTokenExpiresAt = Date.now() + expiresIn * 1000;
  return zohoAccessToken;
}

async function getZohoAccountId(accessToken) {
  if (zohoAccountIdCache) return zohoAccountIdCache;

  const res = await fetch(`${zohoMailApiBase()}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(zohoApiError(data, res.statusText, res.status));
  }

  const accounts = Array.isArray(data.data) ? data.data : data.data ? [data.data] : [];
  const fromEmail = (
    parseFromAddress(EMAIL_FROM).email ||
    process.env.SMTP_USER ||
    ""
  ).toLowerCase();
  const match =
    accounts.find((account) => {
      const emails = [
        account.primaryEmailAddress,
        account.mailboxAddress,
        account.incomingUserName,
        ...(Array.isArray(account.emailAddress)
          ? account.emailAddress.map((entry) => entry.mailId || entry.emailAddress)
          : []),
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return fromEmail && emails.includes(fromEmail);
    }) || accounts[0];

  const accountId = match?.accountId || match?.account_id;
  if (!accountId) {
    throw new Error("Zoho Mail API could not find an accountId. Set ZOHO_ACCOUNT_ID.");
  }
  zohoAccountIdCache = String(accountId);
  return zohoAccountIdCache;
}

async function uploadZohoAttachment(accessToken, accountId, file) {
  const filename = file.filename || "attachment";
  const buffer = Buffer.isBuffer(file.content)
    ? file.content
    : Buffer.from(file.content);
  const params = new URLSearchParams({ fileName: filename });
  const res = await fetch(
    `${zohoMailApiBase()}/api/accounts/${accountId}/messages/attachments?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: buffer,
      signal: AbortSignal.timeout(60000),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(zohoApiError(data, res.statusText, res.status));
  }
  const uploaded = data.data || {};
  if (!uploaded.storeName || !uploaded.attachmentPath) {
    throw new Error(`Zoho attachment upload did not return a store path (${filename})`);
  }
  return {
    storeName: uploaded.storeName,
    attachmentPath: uploaded.attachmentPath,
    attachmentName: uploaded.attachmentName || filename,
  };
}

async function sendViaZohoMailApi({ to, subject, html, text, attachments = [] }) {
  const accessToken = await getZohoAccessToken();
  const accountId = await getZohoAccountId(accessToken);
  const fromEmail =
    parseFromAddress(EMAIL_FROM).email || process.env.SMTP_USER?.trim();
  if (!fromEmail) {
    throw new Error("EMAIL_FROM or SMTP_USER is required for Zoho Mail API");
  }

  const uploaded = [];
  for (const file of attachments.filter((item) => item?.content && item?.filename)) {
    uploaded.push(await uploadZohoAttachment(accessToken, accountId, file));
  }

  const res = await fetch(`${zohoMailApiBase()}/api/accounts/${accountId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fromAddress: zohoFromAddress(),
      toAddress: to,
      subject,
      content: html || text || "",
      mailFormat: html ? "html" : "plaintext",
      encoding: "UTF-8",
      ...(uploaded.length ? { attachments: uploaded } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(zohoApiError(data, res.statusText, res.status));
  }

  const messageId =
    data?.data?.messageId ||
    data?.data?.id ||
    data?.data?.[0]?.messageId;
  return { ok: true, id: messageId ? String(messageId) : undefined };
}

async function sendViaZeptoMail({ to, subject, html, text, attachments = [] }) {
  const token =
    process.env.ZEPTOMAIL_TOKEN?.trim() ||
    process.env.ZEPTOMAIL_SEND_MAIL_TOKEN?.trim();
  if (!token) {
    throw new Error("ZEPTOMAIL_TOKEN is required for ZeptoMail");
  }

  const { name, email } = parseFromAddress(EMAIL_FROM);
  const files = attachments
    .filter((file) => file?.content && file?.filename)
    .map((file) => ({
      name: file.filename,
      mime_type: file.contentType || "application/octet-stream",
      content: Buffer.isBuffer(file.content)
        ? file.content.toString("base64")
        : Buffer.from(file.content).toString("base64"),
    }));

  const res = await fetch(zeptoMailApiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Zoho-enczapikey ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: { address: email, ...(name ? { name } : {}) },
      to: [{ email_address: { address: to } }],
      subject,
      ...(html ? { htmlbody: html } : {}),
      ...(text ? { textbody: text } : {}),
      ...(files.length ? { attachments: files } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiError =
      data?.error?.message ||
      data?.message ||
      data?.error?.details?.[0]?.message ||
      res.statusText;
    throw new Error(apiError || `ZeptoMail HTTP ${res.status}`);
  }

  const messageId =
    data?.data?.[0]?.message_id ||
    data?.data?.message_id ||
    data?.message_id ||
    data?.request_id;
  return { ok: true, id: messageId ? String(messageId) : undefined };
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
  getTransporter();
  const mode = transportMode;
  const files = Array.isArray(attachments) ? attachments.filter(Boolean) : [];

  try {
    if (mode === "zoho-api" || mode === "zeptomail" || mode === "mailjet-api") {
      const result =
        mode === "zoho-api"
          ? await sendViaZohoMailApi({ to, subject, html, text, attachments: files })
          : mode === "zeptomail"
            ? await sendViaZeptoMail({ to, subject, html, text, attachments: files })
            : await sendViaMailjetApi({ to, subject, html, text, attachments: files });
      console.log(`[EMAIL] Sent to ${to} | Subject: ${subject} | id=${result.id || "n/a"}`);
      return result;
    }

    const tx = transporter;
    const info = await tx.sendMail({
      from: zohoFromAddress() || EMAIL_FROM,
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
      ${
        options.witnessPending
          ? `<p ${p}>
               Your witness has not yet signed the Litigation Management Agreement.
               Once they have signed, we will email you the complete signed documents
               for your records.
             </p>`
          : ""
      }
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
${
    options.witnessPending
      ? "\nYour witness has not yet signed the Litigation Management Agreement. Once they have signed, we will email you the complete signed documents for your records.\n"
      : ""
  }
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
 * Follow-up after the witness signs, if the consultant already received the
 * welcome email with an incomplete (claimant-only) PDF.
 */
export async function sendFullySignedDocumentsEmail(user, application, options = {}) {
  const name = consultantName(user);
  const safeName = escapeHtml(name);
  const p =
    'style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;"';

  const html = baseTemplate(
    "Your legal documents are now fully signed",
    `
      <p ${p}>Dear ${safeName},</p>
      <p ${p}>
        Your witness has now signed the Litigation Management Agreement.
        We attach the complete signed legal documents for your records.
      </p>
      <p ${p}>Kind regards,</p>
      <p style="font-size:14px;line-height:1.6;color:#263238;font-weight:bold;margin:0;">
        Harcus Parker Limited
      </p>
    `
  );

  const text = `Dear ${name},

Your witness has now signed the Litigation Management Agreement. We attach the complete signed legal documents for your records.

Kind regards,

Harcus Parker Limited`;

  const attachments = [];
  const signedPdf = options.signedDocumentsPdf;
  if (signedPdf) {
    attachments.push({
      filename: "FIPO-Legal-Documents-Fully-Signed.pdf",
      content: signedPdf,
      contentType: "application/pdf",
    });
  }

  return sendMail({
    to: user.email,
    subject: "Your FIPO legal documents are now fully signed",
    html,
    text,
    attachments,
  });
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
  validDays = 30,
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
        Click the button below when you are ready to review and sign in DocuSign.
        This invitation stays valid for ${Number(validDays) || 30} days.
        When you have finished, you will be returned to the FIPO homepage.
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

Open this link when you are ready to review and sign in DocuSign (valid for ${Number(validDays) || 30} days):
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
