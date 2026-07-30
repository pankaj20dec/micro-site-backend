import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAllowedOrigins, resolveAppBaseUrl } from "../lib/appBaseUrl.js";
import {
  createEnvelopeFromTemplate,
  createRecipientView,
  clearEnvelopeStatusCache,
  cleanupStaleEnvelopeRecipients,
  createWitnessRecipientView,
  assignWitnessRecipient,
  getDocusignConsentUrl,
  getEnvelopeStatus,
  getEnvelopeCombinedPdf,
  getTemplateDetails,
  resolveConfiguredWitnessRoleName,
  pickWitnessRemoteSigner,
  isDocusignConfigured,
  isDocusignWebhookConfigured,
  resolveDocusignWebhookUrl,
} from "../lib/docusignClient.js";
import { syncDocusignStatusFromApi, getApplicationDocusignSnapshot } from "../lib/docusignSync.js";
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
import { sendWitnessSigningEmail } from "../lib/mailer.js";

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

/** After witness finishes email signing, DocuSign returns them to the homepage. */
function buildWitnessHomeReturnUrl(req, requestedBaseUrl) {
  const appBase = resolveAppBaseUrl(req, requestedBaseUrl);
  const allowedOrigins = getAllowedOrigins();
  let origin = appBase;

  if (requestedBaseUrl) {
    try {
      const parsed = new URL(
        requestedBaseUrl.includes("://")
          ? requestedBaseUrl
          : `${appBase}${requestedBaseUrl.startsWith("/") ? "" : "/"}${requestedBaseUrl}`
      );
      if (allowedOrigins.includes(parsed.origin)) {
        origin = parsed.origin;
      }
    } catch {
      // use appBase
    }
  }

  const url = new URL("/", origin);
  url.searchParams.set("docusign", "witness-complete");
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
          .map((tab) => tab.tabLabel || tab.name),
        allTextTabs: (signer.tabs?.textTabs || []).map((tab) => ({
          label: tab.tabLabel || tab.name,
          required: tab.required === "true" || tab.required === true,
        })),
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
    const forceRefresh = req.query.refresh === "1";
    const witnessEmail = String(
      loaded.application.stage2Data?.witness?.email || ""
    ).trim();

    if (forceRefresh && loaded.application.docusignEnvelopeId) {
      await cleanupStaleEnvelopeRecipients(loaded.application.docusignEnvelopeId, {
        activeWitnessEmail: witnessEmail || undefined,
      });
    }

    const { application: synced, remote, rateLimited } =
      await getApplicationDocusignSnapshot(loaded.application, { forceRefresh });

    return res.json({
      envelopeId: synced.docusignEnvelopeId,
      status: remote?.status || synced.docusignStatus,
      completedDateTime: remote?.completedDateTime || synced.legalSignedAt || null,
      allSignersCompleted: remote?.allSignersCompleted ?? false,
      legalSignedAt: synced.legalSignedAt,
      configured: isDocusignConfigured(),
      webhookConfigured: isDocusignWebhookConfigured(),
      signerEmail: user.email,
      signers: remote?.signers || [],
      multipleSigners: !!remote?.multipleSigners,
      pendingSigners: remote?.pendingSigners || [],
      rateLimited,
    });
  } catch (err) {
    console.error("DocuSign status error:", err);
    return res.status(500).json({ error: "Failed to load DocuSign status" });
  }
});

// GET /api/docusign/download — combined signed PDF for the logged-in user's envelope
docusignRouter.get("/download", requireAuth, async (req, res) => {
  try {
    const loaded = await loadApplicationForUser(req.user.sub, res);
    if (!loaded) return;

    const { application } = loaded;

    if (!application.docusignEnvelopeId) {
      return res.status(404).json({ error: "No DocuSign envelope for this application" });
    }

    if (String(application.docusignEnvelopeId).startsWith("stub_")) {
      return res.status(404).json({ error: "Signed PDF is not available in dev stub mode" });
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

    const fileName = `fipo-engagement-${synced.docusignEnvelopeId.slice(0, 8)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    return res.send(pdf);
  } catch (err) {
    console.error("DocuSign download error:", err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to download signed DocuSign document",
    });
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
    let recreateForMissingWitness = false;

    if (
      application.docusignStatus === "COMPLETED" &&
      !forceNew &&
      application.docusignEnvelopeId &&
      isDocusignConfigured()
    ) {
      try {
        const remote = await getEnvelopeStatus(application.docusignEnvelopeId);
        const template = await getTemplateDetails();
        const primaryRoleName = process.env.DOCUSIGN_TEMPLATE_ROLE_NAME || "Signer";
        const witnessRoleName = resolveConfiguredWitnessRoleName(template, primaryRoleName);
        const witness = pickWitnessRemoteSigner(remote.signers, { witnessRoleName });
        const witnessDone =
          witness &&
          ["completed", "signed", "autoresponded"].includes(
            String(witness.status || "").toLowerCase()
          );
        if (!witnessDone) {
          recreateForMissingWitness = true;
        } else {
          return res.json({
            envelopeId: application.docusignEnvelopeId,
            signingUrl: null,
            docusignStatus: application.docusignStatus,
            legalSignedAt: application.legalSignedAt,
            alreadyCompleted: true,
          });
        }
      } catch {
        recreateForMissingWitness = true;
      }
    } else if (application.docusignStatus === "COMPLETED" && !forceNew) {
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
      recreateForMissingWitness ||
      !envelopeId ||
      application.docusignStatus === "DECLINED" ||
      application.docusignStatus === "COMPLETED";

    if (!needsNewEnvelope && envelopeId && isDocusignConfigured()) {
      try {
        const remote = await getEnvelopeStatus(envelopeId);
        const signerCount = remote.signers?.length ?? 0;
        const hasStalePlaceholder = (remote.signers || []).some(
          (signer) =>
            String(signer.email || "").includes("@fipo-sign.local") &&
            !["completed", "signed", "autoresponded"].includes(
              String(signer.status || "").toLowerCase()
            )
        );
        // Two signers (claimant + witness) is expected — only recreate for extra/stale recipients.
        if ((signerCount > 2 || hasStalePlaceholder) && remote.status !== "COMPLETED") {
          needsNewEnvelope = true;
        }
      } catch {
        // keep existing envelope
      }
    }

    if (needsNewEnvelope) {
      const attachPmiEvidence = req.body?.attachPmiEvidence !== false;
      let documents = [];

      if (attachPmiEvidence) {
        documents = await loadPmiEvidenceDocuments(application.id);
        if (documents.length === 0) {
          return res.status(400).json({
            error: "Please upload your PMI evidence documents before signing with DocuSign.",
          });
        }
      }

      envelopeId = await createEnvelopeFromTemplate({
        signerEmail: user.email,
        signerName,
        clientUserId: user.id,
        documents,
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

// POST /api/docusign/witness/send — assign witness, email them a signing link
// (DocuSign returns the witness to the homepage when they finish). Claimant stays
// on the registration form and can continue.
docusignRouter.post("/witness/send", requireAuth, async (req, res) => {
  try {
    const loaded = await loadApplicationForUser(req.user.sub, res);
    if (!loaded) return;

    const { user } = loaded;
    let application = await syncDocusignStatusFromApi(loaded.application);
    const witnessEmail = String(req.body?.witnessEmail || "").trim();
    const witnessName = String(req.body?.witnessName || "").trim();
    const witnessAddress = String(req.body?.witnessAddress || "").trim();
    const homeReturnUrl = buildWitnessHomeReturnUrl(req, req.body?.returnBaseUrl);

    if (!witnessEmail || !witnessName) {
      return res.status(400).json({ error: "Witness name and email are required." });
    }

    if (!application.docusignEnvelopeId) {
      return res.status(400).json({
        error: "No DocuSign envelope found. Complete Stage 1 signing first.",
      });
    }

    if (!isDocusignConfigured()) {
      const stage2Stub =
        application.stage2Data && typeof application.stage2Data === "object"
          ? application.stage2Data
          : {};
      await prisma.application.update({
        where: { id: application.id },
        data: {
          stage2Data: {
            ...stage2Stub,
            witness: {
              ...(stage2Stub.witness ?? {}),
              fullName: witnessName,
              email: witnessEmail,
              ...(witnessAddress ? { address: witnessAddress } : {}),
              invitationSentAt: new Date().toISOString(),
            },
          },
        },
      });
      return res.json({
        stub: true,
        envelopeId: application.docusignEnvelopeId,
        signingUrl: null,
        emailSent: true,
        witnessStatus: "SENT",
        message: "Dev mode: DocuSign is not configured. Witness invitation recorded.",
      });
    }

    const witnessClientUserId = `witness-${req.user.sub}`;
    clearEnvelopeStatusCache(application.docusignEnvelopeId);
    await assignWitnessRecipient(application.docusignEnvelopeId, {
      email: witnessEmail,
      name: witnessName,
      clientUserId: witnessClientUserId,
    });

    const remote = await getEnvelopeStatus(application.docusignEnvelopeId, {
      forceRefresh: true,
    });
    const template = await getTemplateDetails();
    const primaryRoleName = process.env.DOCUSIGN_TEMPLATE_ROLE_NAME || "Signer";
    const witnessRoleName = resolveConfiguredWitnessRoleName(template, primaryRoleName);
    const witnessSigner = pickWitnessRemoteSigner(remote.signers, {
      witnessEmail,
      witnessRoleName,
    });
    const witnessDone =
      witnessSigner &&
      ["completed", "signed", "autoresponded"].includes(
        String(witnessSigner.status || "").toLowerCase()
      );
    const envelopeComplete = remote.status === "COMPLETED";

    if (witnessDone && envelopeComplete) {
      const synced = await syncDocusignStatusFromApi(application);
      return res.json({
        envelopeId: synced.docusignEnvelopeId,
        signingUrl: null,
        emailSent: false,
        witnessStatus: witnessSigner.status,
        docusignStatus: synced.docusignStatus,
        alreadyCompleted: true,
      });
    }

    const signingUrl = await createWitnessRecipientView({
      envelopeId: application.docusignEnvelopeId,
      witnessEmail,
      witnessName,
      witnessClientUserId,
      returnUrl: homeReturnUrl,
    });

    if (!signingUrl) {
      return res.status(400).json({
        error:
          "Could not create a witness signing link. Try Refresh status, or go to Stage 1 and click Sign again.",
        code: "CANNOT_REOPEN_SIGNING",
        docusignStatus: remote.status,
        signers: remote.signers,
      });
    }

    const claimantName = `${user.firstName} ${user.lastName}`.trim() || user.email;
    const mailResult = await sendWitnessSigningEmail({
      to: witnessEmail,
      witnessName,
      claimantName,
      signingUrl,
    });

    if (!mailResult?.ok) {
      return res.status(502).json({
        error:
          mailResult?.error ||
          "Witness signing link was created but the invitation email could not be sent.",
        code: "WITNESS_EMAIL_FAILED",
      });
    }

    const stage2 =
      application.stage2Data && typeof application.stage2Data === "object"
        ? application.stage2Data
        : {};
    await prisma.application.update({
      where: { id: application.id },
      data: {
        stage2Data: {
          ...stage2,
          witness: {
            ...(stage2.witness ?? {}),
            fullName: witnessName,
            email: witnessEmail,
            ...(witnessAddress ? { address: witnessAddress } : {}),
            invitationSentAt: new Date().toISOString(),
          },
        },
      },
    });

    return res.json({
      envelopeId: application.docusignEnvelopeId,
      signingUrl: null,
      emailSent: true,
      witnessStatus: witnessSigner?.status || "SENT",
      docusignStatus: remote.status || application.docusignStatus,
      message: `A signing invitation was sent to ${witnessEmail}. You can continue your registration while they sign.`,
    });
  } catch (err) {
    if (
      err.code === "ENVELOPE_ALREADY_COMPLETED" ||
      err.code === "ENVELOPE_INVALID_STATUS" ||
      /invalid envelope status/i.test(String(err.message || ""))
    ) {
      const message =
        "This document was already fully signed without a witness slot. Click Sign again in Stage 1 to start a fresh envelope with witness signing.";
      console.warn("DocuSign witness send:", message);
      return res.status(400).json({
        error: message,
        code: "ENVELOPE_ALREADY_COMPLETED",
      });
    }
    if (err.code === "CLAIMANT_SIGNING_INCOMPLETE") {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "TEMPLATE_WITNESS_ROLE_MISSING") {
      return res.status(400).json({
        error: err.message,
        availableRoles: err.availableRoles,
      });
    }

    console.error("DocuSign witness send error:", err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to start witness signing",
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
    const completedDateTime =
      payload?.data?.envelopeSummary?.completedDateTime ||
      payload?.data?.envelopeSummary?.statusDateTime ||
      null;
    updateData.legalSignedAt = completedDateTime ? new Date(completedDateTime) : new Date();
  } else if (application.docusignStatus === "COMPLETED") {
    updateData.legalSignedAt = null;
  }

  clearEnvelopeStatusCache(envelopeId);

  if (status === "COMPLETED") {
    try {
      const remote = await getEnvelopeStatus(envelopeId, { forceRefresh: true });
      const signers = remote.signers || [];
      const allDone =
        signers.length >= 2 &&
        signers.every((signer) =>
          ["completed", "signed", "autoresponded"].includes(
            String(signer.status || "").toLowerCase()
          )
        );
      if (allDone || remote.allSignersCompleted) {
        const stage2 =
          application.stage2Data && typeof application.stage2Data === "object"
            ? application.stage2Data
            : {};
        const witness =
          stage2.witness && typeof stage2.witness === "object" ? stage2.witness : {};
        updateData.stage2Data = {
          ...stage2,
          witness: {
            ...witness,
            declarationSigned: true,
          },
        };
      }
    } catch (err) {
      console.warn(
        "DocuSign webhook: could not sync witness completion flags:",
        err.message
      );
    }
  }

  await prisma.application.update({
    where: { id: application.id },
    data: updateData,
  });

  console.log(`DocuSign webhook: application ${application.id} → ${status}`);
  return res.status(200).json({ received: true, applicationId: application.id, status });
});
