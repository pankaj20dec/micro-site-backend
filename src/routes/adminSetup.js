import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../config/db.js";

export const adminSetupRouter = Router();

// GET /api/admin/setup/status — check if first super admin can be created
adminSetupRouter.get("/status", async (_req, res) => {
  try {
    const superAdminCount = await prisma.user.count({
      where: { role: "SUPER_ADMIN" },
    });
    return res.json({ needsSetup: superAdminCount === 0 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to check setup status" });
  }
});

// POST /api/admin/setup — create the first SUPER_ADMIN (only when none exists)
adminSetupRouter.post("/setup", async (req, res) => {
  try {
    const superAdminCount = await prisma.user.count({
      where: { role: "SUPER_ADMIN" },
    });
    if (superAdminCount > 0) {
      return res.status(403).json({
        error: "Setup already complete. Sign in as Super Admin to register accounts.",
      });
    }

    const { firstName, lastName, email, password } = req.body || {};
    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password) {
      return res
        .status(400)
        .json({ error: "firstName, lastName, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: normalizedEmail,
        passwordHash,
        role: "SUPER_ADMIN",
      },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });

    return res.status(201).json({ user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to complete setup" });
  }
});
