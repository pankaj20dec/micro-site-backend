import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/auth.js";

export const adminApplicationsRouter = Router();

// GET /api/admin/applications — list all with filters
adminApplicationsRouter.get("/", requireAdmin, async (req, res) => {
  try {
    const {
      search,
      applicationType,
      status,
      paymentStatus,
      paymentProvider,
      membershipType,
      page = "1",
      limit = "50",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      AND: [
        search
          ? {
              user: {
                OR: [
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ],
              },
            }
          : {},
        applicationType ? { applicationType } : {},
        status ? { status } : {},
        paymentStatus ? { paymentStatus } : {},
        paymentProvider ? { paymentProvider } : {},
        membershipType ? { membershipType } : {},
      ],
    };

    const [applications, total] = await prisma.$transaction([
      prisma.application.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              organisation: true,
              role: true,
            },
          },
          _count: { select: { evidenceFiles: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: parseInt(limit),
      }),
      prisma.application.count({ where }),
    ]);

    // Summary stats
    const [totalCount, supporterCount, claimantCount, paidCount, pendingCount, failedCount, draftCount] =
      await prisma.$transaction([
        prisma.application.count(),
        prisma.application.count({ where: { applicationType: "SUPPORTER" } }),
        prisma.application.count({ where: { applicationType: "CLAIMANT" } }),
        prisma.application.count({ where: { paymentStatus: "PAID" } }),
        prisma.application.count({ where: { paymentStatus: "PENDING" } }),
        prisma.application.count({ where: { paymentStatus: "FAILED" } }),
        prisma.application.count({ where: { status: "DRAFT" } }),
      ]);

    const revenueResult = await prisma.application.aggregate({
      where: { paymentStatus: "PAID" },
      _sum: { membershipFee: true },
    });

    return res.json({
      applications,
      total,
      page: parseInt(page),
      stats: {
        total: totalCount,
        supporters: supporterCount,
        claimants: claimantCount,
        paid: paidCount,
        pending: pendingCount,
        failed: failedCount,
        drafts: draftCount,
        totalRevenue: revenueResult._sum.membershipFee ?? 0,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load applications" });
  }
});

// GET /api/admin/applications/:id — full detail
adminApplicationsRouter.get("/:id", requireAdmin, async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            organisation: true,
            role: true,
            createdAt: true,
          },
        },
        evidenceFiles: { orderBy: { uploadedAt: "asc" } },
        paymentEvents: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!application) return res.status(404).json({ error: "Not found" });

    return res.json({ application });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load application" });
  }
});

// PATCH /api/admin/applications/:id — override status / payment (admin action)
adminApplicationsRouter.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { paymentStatus, status } = req.body || {};

    const data = {};
    if (paymentStatus) data.paymentStatus = paymentStatus;
    if (status) data.status = status;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const [application] = await prisma.$transaction([
      prisma.application.update({
        where: { id: req.params.id },
        data,
      }),
      prisma.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: paymentStatus
            ? `PAYMENT_OVERRIDE_${paymentStatus}`
            : `STATUS_CHANGE_${status}`,
          targetId: req.params.id,
          targetType: "Application",
          metadata: { changes: data },
        },
      }),
    ]);

    return res.json({ application });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Failed to update application" });
  }
});

// DELETE /api/admin/applications/:id — hard delete (super admin only)
adminApplicationsRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  try {
    await prisma.application.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: "APPLICATION_DELETED",
        targetId: req.params.id,
        targetType: "Application",
      },
    });

    return res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Failed to delete application" });
  }
});
