import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAllowedOrigins, resolveAppBaseUrl } from "../lib/appBaseUrl.js";
import {
  createEnvelopeFromTemplate,
  createRecipientView,
  getDocusignConsentUrl,
  getEnvelopeStatus,
  getTemplateDetails,
  isDocusignConfigured,
} from "../lib/docusignClient.js";
import { syncDocusignStatusFromApi } from "../lib/docusignSync.js";
import {
  getDocusignSignatures,
  mapConnectEventToStatus,
  verifyDocusignHmac,
} from "../lib/docusignHmac.js";
import {
  getEvidenceFileBuffer,
  getFileExtension,
  isPmiEvidenceFileKey,
  isPmiEvidenceUploadKey,
  PMI_EVIDENCE_UPLOAD_KEYS,
} from "../lib/spacesStorage.js";

export const docusignRouter = Router();

function resolveDocusignOAuthRedirectUri(req, requestedBaseUrl) {
  const custom = process.env.DOCUSIGN_OAUTH_REDIRECT_URI?.trim();
  if (custom) return custom.replace(/\/$/, "");
  const appBase = resolveAppBaseUrl(req, requestedBaseUrl);
  return `${appBase}/callback`;
}

function buildReturnUrl(req, requestedBaseUrl) {
  const appBase = resolveAppBaseUrl(req, requestedBaseUrl);
  const allowedOrigins = getAllowedOrigins();

  if (requestedBaseUrl) {
    try {
      const parsed = new URL(
        requestedBaseUrl.includes("://")
          ? requestedBaseUrl
          : `${appBase}${requestedBaseUrl.startsWith("/") ? "" : "/"}${requestedBaseUrl}`
      );
      if (allowedOrigins.includes(parsed.origin)) {
        parsed.searchParams.set("docusign", "complete");
        return parsed.toString();
      }
    } catch {
      // fall through to default
    }
  }

  const url = new URL("/register", appBase);
  url.searchParams.set("form", "1");
  url.searchParams.set("docusign", "complete");
  return url.toString();
}

async function loadApplicationForUser(userId, res) {
  let [application, user] = await Promise.all([
    prisma.application.findFirst({ where: { userId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, email: true },
    }),
  ]);

  if (!user) {
    res.status(401).json({ error: "Session expired. Please register again." });
    return null;
  }

  if (!application) {
    application = await prisma.application.create({
      data: { userId, currentStep: 1, status: "DRAFT" },
    });
  }

  if (!user.email) {
    res.status(400).json({ error: "User email is required for DocuSign" });
    return null;
  }

  return { application, user };
}

async function loadPmiEvidenceDocuments(applicationId) {
  const files = await prisma.evidenceFile.findMany({
    where: {
      applicationId,
      OR: [
        { uploadKey: { in: PMI_EVIDENCE_UPLOAD_KEYS } },
        // Legacy rows before uploadKey column existed
        { uploadKey: "general", fileUrl: { contains: "/pmi-evidence-a/" } },
        { uploadKey: "general", fileUrl: { contains: "/pmi-evidence-b/" } },
      ],
    },
    orderBy: { uploadedAt: "asc" },
  });

  const pmiFiles = files.filter(
    (file) => isPmiEvidenceUploadKey(file.uploadKey) || isPmiEvidenceFileKey(file.fileUrl)
  );
  const documents = [];

  for (const file of pmiFiles) {
    const buffer = await getEvidenceFileBuffer(file.fileUrl);
    if (!buffer) continue;
    documents.push({
      name: file.fileName.replace(/\.[^.]+$/, "") || "PMI Evidence",
      extension: getFileExtension(file.fileName),
      base64: buffer.toString("base64"),
    });
  }

  return documents;
}

// GET /api/docusign/template — inspect configured template roles (for setup/debug)
docusignRouter.get("/template", requireAuth, async (_req, res) => {
  try {
    if (!isDocusignConfigured()) {
      return res.status(503).json({ error: "DocuSign is not configured" });
    }

    const template = await getTemplateDetails();
    const signers = template.recipients?.signers || [];

    return res.json({
      templateId: template.templateId,
      name: template.name,
      emailSubject: template.emailSubject,
      configuredRoleName: process.env.DOCUSIGN_TEMPLATE_ROLE_NAME || "Signer",
      signerRoles: signers.map((signer) => ({
        roleName: signer.roleName,
        placeholderEmail: signer.email || null,
        placeholderName: signer.name || null,
        requiredTextTabs: (signer.tabs?.textTabs || [])
          .filter((tab) => tab.required === "true" || tab.required === true)
          .map((tab) => tab.tabLabel),
        signatureTabs: (signer.tabs?.signHereTabs || []).length,
      })),
      warnings: signers
        .filter((signer) => signer.email && signer.email.includes("@"))
        .map(
          (signer) =>
            `Template role "${signer.roleName}" has a fixed email (${signer.email}). Clear name and email on the role in DocuSign so each registered user is the only signer.`
        ),
    });
  } catch (err) {
    console.error("DocuSign template error:", err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to load DocuSign template",
    });
  }
});

// GET /api/docusign/status — current DocuSign state for the logged-in user
docusignRouter.get("/status", requireAuth, async (req, res) => {
  try {
    const loaded = await loadApplicationForUser(req.user.sub, res);
    if (!loaded) return;

    const { user } = loaded;
    const synced = await syncDocusignStatusFromApi(loaded.application);

    let signers = [];
    let multipleSigners = false;
    let pendingSigners = [];
    if (synced.docusignEnvelopeId && isDocusignConfigured()) {
      try {
        const remote = await getEnvelopeStatus(synced.docusignEnvelopeId);
        signers = remote.signers || [];
        multipleSigners = !!remote.multipleSigners;
        pendingSigners = remote.pendingSigners || [];
      } catch {
        // ignore — return DB state
      }
    }

    return res.json({
      envelopeId: synced.docusignEnvelopeId,
      status: synced.docusignStatus,
      legalSignedAt: synced.legalSignedAt,
      configured: isDocusignConfigured(),
      signerEmail: user.email,
      signers,
      multipleSigners,
      pendingSigners,
    });
  } catch (err) {
    console.error("DocuSign status error:", err);
    return res.status(500).json({ error: "Failed to load DocuSign status" });
  }
});

// POST /api/docusign/send — create envelope (if needed) and return embedded signing URL
docusignRouter.post("/send", requireAuth, async (req, res) => {
  try {
    const loaded = await loadApplicationForUser(req.user.sub, res);
    if (!loaded) return;

    const { user } = loaded;
    let application = await syncDocusignStatusFromApi(loaded.application);
    const signerName = `${user.firstName} ${user.lastName}`.trim() || user.email;
    const returnUrl = buildReturnUrl(req, req.body?.returnBaseUrl);
    const forceNew = req.body?.forceNew === true;

    if (application.docusignStatus === "COMPLETED" && !forceNew) {
      return res.json({
        envelopeId: application.docusignEnvelopeId,
        signingUrl: null,
        docusignStatus: application.docusignStatus,
        legalSignedAt: application.legalSignedAt,
        alreadyCompleted: true,
      });
    }

    if (!isDocusignConfigured()) {
      const stubEnvelopeId = application.docusignEnvelopeId || `stub_${application.id}`;
      const updated = await prisma.application.update({
        where: { id: application.id },
        data: {
          docusignEnvelopeId: stubEnvelopeId,
          docusignStatus: "SENT",
        },
      });

      return res.json({
        stub: true,
        envelopeId: updated.docusignEnvelopeId,
        signingUrl: null,
        docusignStatus: updated.docusignStatus,
        message:
          "Dev mode: DocuSign credentials not configured. Add DOCUSIGN_* values to .env to enable real signing.",
      });
    }

    let envelopeId = application.docusignEnvelopeId;
    let needsNewEnvelope =
      forceNew ||
      !envelopeId ||
      application.docusignStatus === "DECLINED" ||
      application.docusignStatus === "COMPLETED";

    if (!needsNewEnvelope && envelopeId && isDocusignConfigured()) {
      try {
        const remote = await getEnvelopeStatus(envelopeId);
        if (remote.multipleSigners && remote.status !== "COMPLETED") {
          needsNewEnvelope = true;
        }
      } catch {
        // keep existing envelope
      }
    }

    if (needsNewEnvelope) {
      const pmiDocuments = await loadPmiEvidenceDocuments(application.id);
      if (pmiDocuments.length === 0) {
        return res.status(400).json({
          error: "Please upload your PMI evidence documents before signing with DocuSign.",
        });
      }

      envelopeId = await createEnvelopeFromTemplate({
        signerEmail: user.email,
        signerName,
        clientUserId: user.id,
        documents: pmiDocuments,
      });

      await prisma.application.update({
        where: { id: application.id },
        data: {
          docusignEnvelopeId: envelopeId,
          docusignStatus: "SENT",
          legalSignedAt: null,
        },
      });
    }

    const syncedApplication = await syncDocusignStatusFromApi(
      await prisma.application.findUnique({ where: { id: application.id } })
    );
    if (syncedApplication?.docusignStatus === "COMPLETED") {
      return res.json({
        envelopeId: syncedApplication.docusignEnvelopeId,
        signingUrl: null,
        docusignStatus: syncedApplication.docusignStatus,
        legalSignedAt: syncedApplication.legalSignedAt,
        alreadyCompleted: true,
      });
    }

    envelopeId = syncedApplication?.docusignEnvelopeId || envelopeId;

    const signingUrl = await createRecipientView({
      envelopeId,
      signerEmail: user.email,
      signerName,
      clientUserId: user.id,
      returnUrl,
    });

    const latest = await prisma.application.findUnique({ where: { id: application.id } });

    return res.json({
      envelopeId,
      signingUrl,
      docusignStatus: latest?.docusignStatus || "SENT",
    });
  } catch (err) {
    console.error("DocuSign send error:", err);

    if (err.code === "consent_required") {
      const redirectUri = resolveDocusignOAuthRedirectUri(req, req.body?.returnBaseUrl);
      return res.status(403).json({
        error: "DocuSign consent required",
        consentUrl: getDocusignConsentUrl(redirectUri),
      });
    }

    if (err.code === "TEMPLATE_NO_SIGNATURE_TABS") {
      return res.status(400).json({
        error: err.message,
        hint:
          "In DocuSign demo → Templates → open your template → drag a Signature field onto the document for the signer role → Save.",
      });
    }

    if (err.code === "ENVELOPE_IS_INCOMPLETE" || err.code === "TEMPLATE_ROLE_MISMATCH") {
      return res.status(400).json({
        error: err.message,
        hint:
          "Open DocuSign → Templates → your template. Ensure it has a document, subject line, one signer role, and signature tabs. Set DOCUSIGN_TEMPLATE_ROLE_NAME to the exact role name.",
        availableRoles: err.availableRoles,
      });
    }

    if (err.code === "TEMPLATE_NO_SIGNERS" || err.code === "TEMPLATE_MULTI_SIGNER") {
      return res.status(400).json({
        error: err.message,
        availableRoles: err.availableRoles,
      });
    }

    return res.status(err.status || 500).json({
      error: err.message || "Failed to start DocuSign signing",
    });
  }
});

// POST /api/docusign/webhook — DocuSign Connect fires this on envelope events
docusignRouter.post("/webhook", async (req, res) => {
  const rawBody = req.body;
  const secret = process.env.DOCUSIGN_WEBHOOK_HMAC_SECRET;
  const isStub = !secret || secret === "placeholder";

  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: "Expected raw request body" });
  }

  if (!isStub) {
    const signatures = getDocusignSignatures(req.headers);
    if (!verifyDocusignHmac(rawBody, secret, signatures)) {
      console.error("DocuSign webhook signature invalid");
      return res.status(400).json({ error: "Webhook signature invalid" });
    }
  } else {
    console.warn("DocuSign webhook: HMAC verification skipped (placeholder secret)");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("DocuSign webhook JSON parse error:", err.message);
    return res.status(200).json({ received: true, skipped: "unparseable payload" });
  }

  const envelopeId =
    payload?.data?.envelopeId ?? payload?.data?.envelopeSummary?.envelopeId ?? null;
  const status = mapConnectEventToStatus(payload?.event, payload?.data?.envelopeSummary);

  if (!envelopeId || !status) {
    console.log("DocuSign webhook: ignored event", {
      event: payload?.event,
      envelopeId,
    });
    return res.status(200).json({ received: true });
  }

  const application = await prisma.application.findFirst({
    where: { docusignEnvelopeId: envelopeId },
  });

  if (!application) {
    console.log("DocuSign webhook: no application for envelope", envelopeId);
    return res.status(200).json({ received: true });
  }

  const updateData = { docusignStatus: status };
  if (status === "COMPLETED") {
    updateData.legalSignedAt = new Date();
  }

  await prisma.application.update({
    where: { id: application.id },
    data: updateData,
  });

  console.log(`DocuSign webhook: application ${application.id} → ${status}`);
  return res.status(200).json({ received: true, applicationId: application.id, status });
});
