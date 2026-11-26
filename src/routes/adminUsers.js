import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/auth.js";
import { syncApplicationsDocusignStatus } from "../lib/docusignSync.js";

export const adminUsersRouter = Router();

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

function parsePagination(
  query,
  { pageKey = "page", limitKey = "limit", defaultLimit = 50, maxLimit = 100 } = {}
) {
  const page = Math.max(parseInt(query[pageKey], 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(query[limitKey], 10) || defaultLimit, 1),
    maxLimit
  );
  return { page, limit, skip: (page - 1) * limit };
}

// Compact list of page buttons, e.g. [1, "…", 4, 5, 6, "…", 20]
function getPageItems(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const items = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) items.push("…");
  for (let i = start; i <= end; i++) items.push(i);
  if (end < totalPages - 1) items.push("…");
  items.push(totalPages);
  return items;
}

function pageMeta(total, page, limit) {
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    // Bottom pagination buttons: only needed when there is more than one page
    showPagination: totalPages > 1,
    prevPage: page > 1 ? page - 1 : null,
    nextPage: page < totalPages ? page + 1 : null,
    pages: getPageItems(page, totalPages),
  };
}

// GET /api/admin/users — list all users (ADMIN+)
adminUsersRouter.get("/", requireAdmin, async (req, res) => {
  try {
    const { search, role } = req.query;
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });

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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return res.json({ users, ...pageMeta(total, page, limit) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load users" });
  }
});

// GET /api/admin/users/:id — single user with paginated applications
// Query: ?appPage=1&appLimit=10
adminUsersRouter.get("/:id", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, {
      pageKey: "appPage",
      limitKey: "appLimit",
      defaultLimit: 10,
      maxLimit: 50,
    });

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
        _count: { select: { applications: true } },
        applications: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: limit,
          include: {
            evidenceFiles: true,
            paymentEvents: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: "Not found" });

    user.applications = await syncApplicationsDocusignStatus(user.applications);

    const { _count, ...rest } = user;

    return res.json({
      user: rest,
      applicationsPagination: pageMeta(_count.applications, page, limit),
    });
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

// POST /api/admin/users/:id/impersonate — super admin opens a member session
adminUsersRouter.post("/:id/impersonate", requireSuperAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });
    if (!target) return res.status(404).json({ error: "Not found" });

    if (target.id === req.user.sub) {
      return res.status(400).json({ error: "You are already signed in as this account." });
    }
    if (target.role !== "USER") {
      return res.status(403).json({ error: "You can only log in as a registered member (USER)." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET missing");

    const token = jwt.sign(
      {
        sub: target.id,
        email: target.email,
        role: target.role,
        impersonatedBy: req.user.sub,
      },
      secret,
      { expiresIn: "8h" }
    );

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: "USER_IMPERSONATED",
        targetId: target.id,
        targetType: "User",
        metadata: { email: target.email },
      },
    });

    return res.json({
      token,
      user: target,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to start user session" });
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

    if (target.id === req.user.sub) {
      return res.status(403).json({ error: "You cannot delete your own account" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({
        where: {
          OR: [{ actorId: req.params.id }, { targetId: req.params.id }],
        },
      });
      await tx.user.delete({ where: { id: req.params.id } });
    });

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
    if (err.code === "P2003") {
      return res.status(409).json({
        error: "Cannot delete user because related records still exist. Contact support.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

// GET /api/admin/users/audit-log/all (super admin only)
adminUsersRouter.get("/audit-log/all", requireSuperAdmin, async (req, res) => {
  try {
    const { actorId, action } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return res.json({ logs, ...pageMeta(total, page, limit) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load audit log" });
  }
});