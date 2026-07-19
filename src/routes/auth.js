import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../config/db.js";
import { sendWelcomeEmail, sendPasswordResetEmail } from "../lib/mailer.js";

export const authRouter = Router();

function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    secret,
    { expiresIn: "7d" }
  );
}

// POST /api/auth/register
authRouter.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, organisation } =
      req.body || {};

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password) {
      return res
        .status(400)
        .json({ error: "firstName, lastName, email and password are required" });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        phone: phone?.trim() || null,
        organisation: organisation?.trim() || null,
        role: "USER",
        applications: {
          create: { currentStep: 1, status: "DRAFT" },
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
      },
    });

    const token = signToken(user);

    // Fire-and-forget welcome email — never block or fail registration on it.
    sendWelcomeEmail(user).catch((err) =>
      console.error("Welcome email failed:", err?.message || err)
    );

    return res.status(201).json({ token, user });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.passwordHash) {
      return res.status(401).json({
        error: "This account uses Google Sign-In. Please continue with Google.",
      });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

async function resolveGoogleProfile({ accessToken, credential }) {
  if (credential) {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    if (!res.ok) return null;
    const payload = await res.json();
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (clientId && payload.aud !== clientId) return null;
    if (payload.email_verified !== "true" && payload.email_verified !== true) {
      return null;
    }
    const fullName = typeof payload.name === "string" ? payload.name.trim() : "";
    const parts = fullName.split(/\s+/).filter(Boolean);
    return {
      googleId: payload.sub,
      email: payload.email?.toLowerCase?.()?.trim?.() || null,
      firstName: payload.given_name?.trim() || parts[0] || "User",
      lastName:
        payload.family_name?.trim() ||
        (parts.length > 1 ? parts.slice(1).join(" ") : "Account"),
    };
  }

  if (accessToken) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const profile = await res.json();
    if (!profile.email || (profile.email_verified !== true && profile.email_verified !== "true")) {
      return null;
    }
    const fullName = typeof profile.name === "string" ? profile.name.trim() : "";
    const parts = fullName.split(/\s+/).filter(Boolean);
    return {
      googleId: profile.sub,
      email: profile.email.toLowerCase().trim(),
      firstName: profile.given_name?.trim() || parts[0] || "User",
      lastName:
        profile.family_name?.trim() ||
        (parts.length > 1 ? parts.slice(1).join(" ") : "Account"),
    };
  }

  return null;
}

// POST /api/auth/google — sign in / register with a Google access token or ID token
authRouter.post("/google", async (req, res) => {
  try {
    const { accessToken, credential } = req.body || {};
    if (!accessToken && !credential) {
      return res.status(400).json({ error: "Google credential is required" });
    }

    const profile = await resolveGoogleProfile({ accessToken, credential });
    if (!profile?.email || !profile.googleId) {
      return res.status(401).json({ error: "Invalid or unverified Google account" });
    }

    let user = await prisma.user.findFirst({
      where: {
        OR: [{ googleId: profile.googleId }, { email: profile.email }],
      },
    });

    if (user) {
      if (!user.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId: profile.googleId },
        });
      }
    } else {
      user = await prisma.user.create({
        data: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
          googleId: profile.googleId,
          role: "USER",
          applications: {
            create: { currentStep: 1, status: "DRAFT" },
          },
        },
      });

      sendWelcomeEmail(user).catch((err) =>
        console.error("Welcome email failed:", err?.message || err)
      );
    }

    const token = signToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Google auth error:", err);
    return res.status(500).json({ error: "Google sign-in failed" });
  }
});

// POST /api/auth/forgot-password — generate a reset token and email a link
authRouter.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email?.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Always respond with success to avoid leaking which emails are registered.
    if (user) {
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken, resetTokenExpiresAt },
      });

      sendPasswordResetEmail(user, resetToken).catch((err) =>
        console.error("Reset email failed:", err?.message || err)
      );
    }

    return res.json({
      success: true,
      message: "If an account exists for that email, a reset link has been sent.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Could not process request" });
  }
});

// POST /api/auth/reset-password — verify token and set a new password
authRouter.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: "Token and new password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiresAt: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: "Reset link is invalid or has expired" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpiresAt: null },
    });

    return res.json({ success: true, message: "Password updated. You can now sign in." });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Could not reset password" });
  }
});
