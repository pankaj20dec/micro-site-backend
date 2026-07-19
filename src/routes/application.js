import { Router } from "express";
import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { sendApplicationSubmittedEmail, sendSupporterMemberEmail, sendSaveResumeEmail } from "../lib/mailer.js";
import { resolveAppBaseUrl } from "../lib/appBaseUrl.js";
import {
  createEvidenceUploadTarget,
  deleteEvidenceFile,
  getEvidenceFileBuffer,
  parseUploadKeyFromFileKey,
  saveEvidenceBufferLocal,
  sanitizeFileName,
} from "../lib/spacesStorage.js";

function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    secret,
    { expiresIn: "7d" }
  );
}

// Frontend uses friendlier status labels; map them onto the schema enum.
const STATUS_MAP = {
  UNDER_REVIEW: "SUBMITTED",
  COMPLETE: "SUBMITTED",
  SUBMITTED: "SUBMITTED",
  DRAFT: "DRAFT",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

export const applicationRouter = Router();

// GET /api/application/resume/:token — PUBLIC. Validates the resume token from
// the emailed link (works in any browser / incognito, with no session), then
// returns the application plus a fresh JWT so the user can continue the form.
applicationRouter.get("/resume/:token", async (req, res) => {
  try {
    const application = await prisma.application.findFirst({
      where: {
        resumeToken: req.params.token,
        resumeTokenExpiresAt: { gt: new Date() },
      },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, role: true },
        },
        evidenceFiles: true,
      },
    });

    if (!application) {
      return res.status(404).json({ error: "Resume link is invalid or has expired" });
    }

    // Clear the token after use so it can't be replayed.
    await prisma.application.update({
      where: { id: application.id },
      data: { resumeToken: null, resumeTokenExpiresAt: null },
    });

    const token = signToken(application.user);

    return res.json({ application, token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to resume application" });
  }
});

// Everything below requires an authenticated session.
applicationRouter.use(requireAuth);

async function requireExistingUser(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { id: true },
  });
  if (!user) {
    res.status(401).json({ error: "Session expired. Please register again." });
    return null;
  }
  return user.id;
}

// GET /api/application — get current user's application
applicationRouter.get("/", async (req, res) => {
  try {
    const userId = await requireExistingUser(req, res);
    if (!userId) return;

    const application = await prisma.application.findFirst({
      where: { userId },
      include: {
        evidenceFiles: { orderBy: { uploadedAt: "asc" } },
        paymentEvents: { orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!application) {
      return res.json({ application: null });
    }

    return res.json({ application });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load application" });
  }
});

// PATCH /api/application/step — save step data and optionally advance
applicationRouter.patch("/step", async (req, res) => {
  try {
    const {
      applicationType,
      currentStep,
      membershipType,
      membershipFee,
      pmiRelationshipType,
      pmiPolicyNumber,
      pmiInsurerName,
      pmiPolicyStartDate,
      pmiPolicyEndDate,
      stage1Data,
      stage2Data,
      riskAccepted,
      status,
    } = req.body || {};

    const userId = await requireExistingUser(req, res);
    if (!userId) return;

    let application = await prisma.application.findFirst({
      where: { userId },
    });

    if (!application) {
      application = await prisma.application.create({
        data: { userId, currentStep: 1, status: "DRAFT" },
      });
    }

    const data = {};
    if (applicationType !== undefined) data.applicationType = applicationType;
    if (currentStep !== undefined) data.currentStep = currentStep;
    if (membershipType !== undefined) data.membershipType = membershipType;
    if (membershipFee !== undefined) data.membershipFee = membershipFee;
    if (pmiRelationshipType !== undefined) data.pmiRelationshipType = pmiRelationshipType;
    if (pmiPolicyNumber !== undefined) data.pmiPolicyNumber = pmiPolicyNumber;
    if (pmiInsurerName !== undefined) data.pmiInsurerName = pmiInsurerName;
    if (pmiPolicyStartDate !== undefined) data.pmiPolicyStartDate = new Date(pmiPolicyStartDate);
    if (pmiPolicyEndDate !== undefined) data.pmiPolicyEndDate = new Date(pmiPolicyEndDate);
    if (stage1Data !== undefined) data.stage1Data = stage1Data;
    if (stage2Data !== undefined) data.stage2Data = stage2Data;
    if (riskAccepted === true) data.riskAcceptedAt = new Date();

    let normalizedStatus;
    if (status !== undefined) {
      normalizedStatus = STATUS_MAP[status] || undefined;
      if (normalizedStatus) data.status = normalizedStatus;
    }

    const updated = await prisma.application.update({
      where: { id: application.id },
      data,
    });

    const nextStep =
      currentStep !== undefined ? currentStep : application.currentStep;
    const nextType =
      applicationType !== undefined ? applicationType : application.applicationType;
    const supporterStepJustCompleted =
      nextType === "SUPPORTER" &&
      nextStep >= 2 &&
      application.currentStep < 2;

    if (supporterStepJustCompleted) {
      prisma.user
        .findUnique({
          where: { id: req.user.sub },
          select: { firstName: true, email: true },
        })
        .then((user) => {
          if (user) return sendSupporterMemberEmail(user);
        })
        .catch((err) =>
          console.error("Supporter member email failed:", err?.message || err)
        );
    }

    // Send the confirmation email once, on the transition into SUBMITTED.
    if (
      normalizedStatus === "SUBMITTED" &&
      application.status !== "SUBMITTED"
    ) {
      prisma.user
        .findUnique({
          where: { id: req.user.sub },
          select: { firstName: true, email: true },
        })
        .then((user) => {
          if (user) return sendApplicationSubmittedEmail(user, updated);
        })
        .catch((err) =>
          console.error("Submitted email failed:", err?.message || err)
        );
    }

    return res.json({ application: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save step" });
  }
});

// POST /api/application/save-resume — generate resume token and email link
applicationRouter.post("/save-resume", async (req, res) => {
  try {
    const userId = await requireExistingUser(req, res);
    if (!userId) return;

    const [application, user] = await Promise.all([
      prisma.application.findFirst({ where: { userId } }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, email: true },
      }),
    ]);

    if (!application) {
      return res.status(404).json({ error: "No application found" });
    }

    if (!user?.email) {
      return res.status(400).json({ error: "User email not found" });
    }

    const resumeToken = crypto.randomBytes(32).toString("hex");
    const resumeTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.application.update({
      where: { id: application.id },
      data: { resumeToken, resumeTokenExpiresAt },
    });

    const appBase = resolveAppBaseUrl(req, req.body?.returnBaseUrl);
    const resumeUrl = `${appBase}/register/resume/${resumeToken}`;

    const emailResult = await sendSaveResumeEmail(user, resumeUrl);
    if (!emailResult.ok) {
      console.error("Save-resume email failed:", emailResult.error);
      return res.status(502).json({
        error: "Progress was saved but the resume email could not be sent. Please try again.",
      });
    }

    return res.json({
      success: true,
      message: "Resume link sent to your email address.",
      // Include URL in dev mode for easy testing
      ...(process.env.NODE_ENV !== "production" && { resumeUrl }),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate resume link" });
  }
});

// POST /api/application/evidence/presign — get upload target (Spaces presign or local upload URL)
applicationRouter.post("/evidence/presign", async (req, res) => {
  try {
    const { fileName, mimeType, uploadKey } = req.body || {};

    if (!fileName || !mimeType) {
      return res.status(400).json({ error: "fileName and mimeType are required" });
    }

    const application = await prisma.application.findFirst({
      where: { userId: req.user.sub },
    });

    if (!application) {
      return res.status(404).json({ error: "No application found" });
    }

    const target = await createEvidenceUploadTarget({
      applicationId: application.id,
      uploadKey: uploadKey || "general",
      fileName,
      mimeType,
    });

    return res.json(target);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// POST /api/application/evidence/upload — local storage fallback when Spaces is not configured
applicationRouter.post(
  "/evidence/upload",
  express.raw({ type: () => true, limit: "20mb" }),
  async (req, res) => {
    try {
      const fileKey = String(req.headers["x-file-key"] || "");
      const rawName = req.headers["x-file-name"];
      const fileName = rawName ? decodeURIComponent(String(rawName)) : "upload.bin";
      const buffer = req.body;

      if (!fileKey || fileKey.includes("..")) {
        return res.status(400).json({ error: "Invalid file key" });
      }
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res.status(400).json({ error: "Empty file upload" });
      }

      const userId = await requireExistingUser(req, res);
      if (!userId) return;

      const application = await prisma.application.findFirst({ where: { userId } });
      if (!application || !fileKey.includes(application.id)) {
        return res.status(403).json({ error: "Upload not allowed for this application" });
      }

      await saveEvidenceBufferLocal(fileKey, buffer);

      return res.status(201).json({
        fileKey,
        fileName: sanitizeFileName(fileName),
        storage: "local",
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to upload evidence file" });
    }
  }
);

// POST /api/application/evidence — save file metadata after upload
applicationRouter.post("/evidence", async (req, res) => {
  try {
    const { fileName, fileUrl, fileKey, fileSize, mimeType, uploadKey } = req.body || {};
    const storageKey = fileKey || fileUrl;

    if (!fileName || !storageKey) {
      return res.status(400).json({ error: "fileName and fileKey are required" });
    }

    const application = await prisma.application.findFirst({
      where: { userId: req.user.sub },
    });

    if (!application) {
      return res.status(404).json({ error: "No application found" });
    }

    if (!storageKey.includes(application.id)) {
      return res.status(403).json({ error: "File key does not belong to this application" });
    }

    const resolvedUploadKey =
      String(uploadKey || "").trim() || parseUploadKeyFromFileKey(storageKey);

    const file = await prisma.evidenceFile.create({
      data: {
        applicationId: application.id,
        fileName: sanitizeFileName(fileName),
        fileUrl: storageKey,
        fileSize: fileSize ?? 0,
        mimeType: mimeType || "application/octet-stream",
        uploadKey: resolvedUploadKey,
      },
    });

    return res.status(201).json({ file });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save file" });
  }
});

// GET /api/application/evidence/:id/download — download stored evidence (owner only)
applicationRouter.get("/evidence/:id/download", async (req, res) => {
  try {
    const userId = await requireExistingUser(req, res);
    if (!userId) return;

    const file = await prisma.evidenceFile.findUnique({
      where: { id: req.params.id },
      include: { application: { select: { userId: true } } },
    });

    if (!file || file.application.userId !== userId) {
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
});

// DELETE /api/application/evidence/:id — remove an uploaded file
applicationRouter.delete("/evidence/:id", async (req, res) => {
  try {
    const file = await prisma.evidenceFile.findUnique({
      where: { id: req.params.id },
      include: { application: { select: { userId: true } } },
    });

    if (!file || file.application.userId !== req.user.sub) {
      return res.status(404).json({ error: "File not found" });
    }

    // Delete from storage when configured
    await deleteEvidenceFile(file.fileUrl);

    await prisma.evidenceFile.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});
