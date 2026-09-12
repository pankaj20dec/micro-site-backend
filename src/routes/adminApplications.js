import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/auth.js";
import {
  getEvidenceFileBuffer,
  sanitizeFileName,
} from "../lib/spacesStorage.js";
import { syncDocusignStatusFromApi } from "../lib/docusignSync.js";
import {
  getEnvelopeCombinedPdf,
  isDocusignConfigured,
} from "../lib/docusignClient.js";

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

const REFUND_WINDOW_DAYS = 15;

function resolvePaidAt(application) {
  if (application.paidAt) return new Date(application.paidAt);
  const paidEvent = (application.paymentEvents || []).find(
    (event) =>
      event.status === "succeeded" ||
      event.type === "payment_intent.confirm" ||
      event.type === "payment_intent.succeeded" ||
      event.type === "PAYMENT.CAPTURE.COMPLETED"
  );
  if (paidEvent?.createdAt) return new Date(paidEvent.createdAt);
  return null;
}

function refundDeadline(paidAt) {
  return new Date(paidAt.getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

// GET /api/admin/applications/refundable — must be before /:id
adminApplicationsRouter.get("/refundable", requireSuperAdmin, async (_req, res) => {
  try {
    const applications = await prisma.application.findMany({
      where: {
        paymentStatus: "PAID",
        paymentProvider: "STRIPE",
        stripePaymentIntentId: { not: null },
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        paymentEvents: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { updatedAt: "desc" },
    });

    const now = Date.now();
    const refundable = applications
      .map((application) => {
        const paidAt = resolvePaidAt(application);
        if (!paidAt) return null;
        const deadline = refundDeadline(paidAt);
        const msLeft = deadline.getTime() - now;
        if (msLeft <= 0) return null;
        return {
          ...application,
          paidAt: paidAt.toISOString(),
          refundDeadline: deadline.toISOString(),
          daysRemaining: Math.ceil(msLeft / (24 * 60 * 60 * 1000)),
        };
      })
      .filter(Boolean);

    return res.json({ applications: refundable, windowDays: REFUND_WINDOW_DAYS });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load refundable payments" });
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

    const synced = await syncDocusignStatusFromApi(application);

    return res.json({ application: synced });
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

// POST /api/admin/applications/:id/refund — Stripe refund (super admin, within 15 days)
adminApplicationsRouter.post("/:id/refund", requireSuperAdmin, async (req, res) => {
  try {
    const application = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { paymentEvents: { orderBy: { createdAt: "asc" } } },
    });

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (application.paymentStatus === "REFUNDED") {
      return res.status(400).json({ error: "Payment already refunded" });
    }

    if (application.paymentStatus !== "PAID") {
      return res.status(400).json({ error: "Only paid applications can be refunded" });
    }

    if (application.paymentProvider !== "STRIPE" || !application.stripePaymentIntentId) {
      return res.status(400).json({ error: "Only Stripe payments can be refunded here" });
    }

    const paidAt = resolvePaidAt(application);
    if (!paidAt) {
      return res.status(400).json({
        error: "Cannot determine payment date; refund window cannot be verified",
      });
    }

    const deadline = refundDeadline(paidAt);
    if (Date.now() > deadline.getTime()) {
      return res.status(400).json({
        error: `Refund window expired. Refunds are only allowed within ${REFUND_WINDOW_DAYS} days of payment.`,
        paidAt: paidAt.toISOString(),
        refundDeadline: deadline.toISOString(),
      });
    }

    const amount = Number(application.membershipFee ?? 0);
    const currency = "gbp";
    let providerEventId = `local_refund_${application.id}_${Date.now()}`;
    let refundStatus = "succeeded";
    let stub = false;

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const isStub =
      !stripeKey ||
      stripeKey === "sk_test_placeholder" ||
      String(application.stripePaymentIntentId).startsWith("stub_pi_");

    if (isStub) {
      stub = true;
    } else {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey);
      const refund = await stripe.refunds.create({
        payment_intent: application.stripePaymentIntentId,
        reason: "requested_by_customer",
        metadata: {
          applicationId: application.id,
          refundedBy: req.user.sub,
        },
      });
      providerEventId = refund.id;
      refundStatus = refund.status || "succeeded";
    }

    const [updated] = await prisma.$transaction([
      prisma.application.update({
        where: { id: application.id },
        data: {
          paymentStatus: "REFUNDED",
          refundedAt: new Date(),
          paidAt: application.paidAt ?? paidAt,
        },
        include: {
          paymentEvents: { orderBy: { createdAt: "desc" } },
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      }),
      prisma.paymentEvent.create({
        data: {
          applicationId: application.id,
          provider: "STRIPE",
          providerEventId,
          type: "refund",
          amount,
          currency,
          status: refundStatus,
        },
      }),
      prisma.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: "PAYMENT_REFUND",
          targetId: application.id,
          targetType: "Application",
          metadata: {
            provider: "STRIPE",
            stripePaymentIntentId: application.stripePaymentIntentId,
            providerEventId,
            amount,
            stub,
            paidAt: paidAt.toISOString(),
          },
        },
      }),
    ]);

    return res.json({
      application: updated,
      stub,
      message: stub
        ? "Dev mode: payment marked as refunded locally."
        : "Stripe refund created successfully.",
    });
  } catch (err) {
    console.error("Refund error:", err);
    const message =
      err?.raw?.message || err?.message || "Failed to refund payment";
    return res.status(500).json({ error: message });
  }
});

adminApplicationsRouter.get(
  "/:applicationId/docusign/download",
  requireAdmin,
  async (req, res) => {
    try {
      const application = await prisma.application.findUnique({
        where: { id: req.params.applicationId },
      });

      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (!application.docusignEnvelopeId) {
        return res.status(404).json({ error: "No DocuSign envelope for this application" });
      }

      if (!isDocusignConfigured()) {
        return res.status(503).json({ error: "DocuSign is not configured" });
      }

      const synced = await syncDocusignStatusFromApi(application);
      if (synced.docusignStatus !== "COMPLETED") {
        return res.status(400).json({
          error: "Signed PDF is available only after DocuSign signing is completed",
        });
      }

      const pdf = await getEnvelopeCombinedPdf(synced.docusignEnvelopeId);
      if (!pdf) {
        return res.status(404).json({ error: "Signed document not found" });
      }

      const fileName = `fipo-signed-${synced.docusignEnvelopeId.slice(0, 8)}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
      return res.send(pdf);
    } catch (err) {
      console.error(err);
      return res.status(err.status || 500).json({
        error: err.message || "Failed to download signed DocuSign document",
      });
    }
  }
);

adminApplicationsRouter.get(
  "/:applicationId/evidence/:fileId/download",
  requireAdmin,
  async (req, res) => {
    try {
      const file = await prisma.evidenceFile.findFirst({
        where: {
          id: req.params.fileId,
          applicationId: req.params.applicationId,
        },
      });

      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }

      const buffer = await getEvidenceFileBuffer(file.fileUrl);
      if (!buffer) {
        return res.status(404).json({ error: "File not found in storage" });
      }

      res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${sanitizeFileName(file.fileName)}"`
      );
      return res.send(buffer);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to download file" });
    }
  }
);
