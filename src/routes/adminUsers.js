import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../config/db.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/auth.js";
import { syncApplicationsDocusignStatus } from "../lib/docusignSync.js";

export const adminUsersRouter = Router();

// GET /api/admin/users — list all users (ADMIN+)
adminUsersRouter.get("/", requireAdmin, async (req, res) => {
  try {
    const { search, role, page = "1", limit = "50" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      AND: [
        search
          ? {
              OR: [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            }
          : {},
        role ? { role } : {},
      ],
    };

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          organisation: true,
          role: true,
          createdAt: true,
          _count: { select: { applications: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    return res.json({ users, total, page: parseInt(page) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load users" });
  }
});

// GET /api/admin/users/:id — single user with applications
adminUsersRouter.get("/:id", requireAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        organisation: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        applications: {
          include: {
            evidenceFiles: true,
            paymentEvents: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: "Not found" });

    user.applications = await syncApplicationsDocusignStatus(user.applications);

    return res.json({ user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load user" });
  }
});

// POST /api/admin/users — create new admin account (super admin only)
adminUsersRouter.post("/", requireSuperAdmin, async (req, res) => {
  try {
    const { firstName, lastName, email, password, role = "ADMIN" } = req.body || {};

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: "firstName, lastName, email and password are required" });
    }

    const validRoles = ["ADMIN", "SUPER_ADMIN"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role,
      },
      select: { id: true, firstName: true, lastName: true, email: true, role: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: "ADMIN_CREATED",
        targetId: user.id,
        targetType: "User",
        metadata: { role, email: user.email },
      },
    });

    return res.status(201).json({ user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create admin" });
  }
});

// PATCH /api/admin/users/:id/role — change role (super admin only)
adminUsersRouter.patch("/:id/role", requireSuperAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    const validRoles = ["USER", "ADMIN"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "Role must be USER or ADMIN" });
    }

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: "Not found" });

    // Cannot demote another SUPER_ADMIN
    if (target.role === "SUPER_ADMIN") {
      return res.status(403).json({ error: "Cannot change a SUPER_ADMIN's role" });
    }

    const [user] = await prisma.$transaction([
      prisma.user.update({
        where: { id: req.params.id },
        data: { role },
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      }),
      prisma.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: "ROLE_CHANGED",
          targetId: req.params.id,
          targetType: "User",
          metadata: { previousRole: target.role, newRole: role },
        },
      }),
    ]);

    return res.json({ user });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Failed to update role" });
  }
});

// DELETE /api/admin/users/:id — delete user (super admin only)
adminUsersRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: "Not found" });

    if (target.role === "SUPER_ADMIN") {
      return res.status(403).json({ error: "Cannot delete a SUPER_ADMIN account" });
    }

    await prisma.user.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: "USER_DELETED",
        targetId: req.params.id,
        targetType: "User",
        metadata: { email: target.email, role: target.role },
      },
    });

    return res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

// GET /api/admin/audit-log (super admin only)
adminUsersRouter.get("/audit-log/all", requireSuperAdmin, async (req, res) => {
  try {
    const { actorId, action, page = "1", limit = "50" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      AND: [
        actorId ? { actorId } : {},
        action ? { action: { contains: action, mode: "insensitive" } } : {},
      ],
    };

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        include: {
          actor: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: parseInt(limit),
      }),
      prisma.auditLog.count({ where }),
    ]);

    return res.json({ logs, total, page: parseInt(page) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load audit log" });
  }
});
