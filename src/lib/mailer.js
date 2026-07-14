import nodemailer from "nodemailer";

/**
 * SMTP transport. Configure via env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE
 * When SMTP is not configured we fall back to a JSON transport that
 * logs the message to the console — useful for local development.
 */
let transporter = null;
let usingStub = false;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (SMTP_HOST && SMTP_PORT) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true" || Number(SMTP_PORT) === 465,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  } else {
    usingStub = true;
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }

  return transporter;
}

const EMAIL_FROM = process.env.EMAIL_FROM || "FIPO <noreply@fipo.co.uk>";

export async function sendMail({ to, subject, html, text }) {
  const tx = getTransporter();
  try {
    const info = await tx.sendMail({ from: EMAIL_FROM, to, subject, html, text });
    if (usingStub) {
      console.log(`\n[EMAIL:STUB] To: ${to} | Subject: ${subject}`);
      console.log(`[EMAIL:STUB] Body:\n${text || html}\n`);
    }
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error("sendMail failed:", err.message);
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
 * Confirmation email sent once an application is submitted for review.
 */
export async function sendApplicationSubmittedEmail(user, application) {
  const appBase = process.env.APP_BASE_URL || "http://localhost:3000";
  const dashboardUrl = `${appBase}/dashboard`;
  const name = user.firstName ? `${user.firstName}` : "there";
  const isClaimant = application?.applicationType === "CLAIMANT";

  const html = baseTemplate(
    "Your application has been submitted",
    `
      <p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
        Thank you, ${name}. Your ${isClaimant ? "claimant" : "supporter"}
        application has been submitted successfully and is now
        ${isClaimant ? "under review by the FIPO legal team" : "confirmed"}.
      </p>
      ${
        isClaimant
          ? `<p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
               Our team typically reviews applications within 5–10 working days.
               We'll email you as soon as there's an update.
             </p>`
          : `<p style="font-size:14px;line-height:1.6;color:#4a4a4a;margin:0 0 16px;">
               Thank you for supporting the FIPO Fair Pay Action Group.
             </p>`
      }
      <a href="${dashboardUrl}"
        style="display:inline-block;background:#802B7D;color:#ffffff;text-decoration:none;
        font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;letter-spacing:1px;">
        VIEW MY DASHBOARD
      </a>
    `
  );

  const text = `Thank you, ${name}.

Your ${isClaimant ? "claimant" : "supporter"} application has been submitted successfully${
    isClaimant ? " and is now under review by the FIPO legal team." : "."
  }

View your dashboard: ${dashboardUrl}

— FIPO Fair Pay Action Group`;

  return sendMail({
    to: user.email,
    subject: isClaimant
      ? "Your FIPO claimant application is under review"
      : "Your FIPO application is confirmed",
    html,
    text,
  });
}
