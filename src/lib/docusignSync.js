import { prisma } from "../config/db.js";
import { getEnvelopeStatus, isDocusignConfigured } from "./docusignClient.js";

/**
 * Fetch DocuSign envelope state once and persist changes to the application.
 * Returns cached data when available unless forceRefresh is true.
 */
export async function getApplicationDocusignSnapshot(application, options = {}) {
  const { forceRefresh = false } = options;

  if (!application?.docusignEnvelopeId || !isDocusignConfigured()) {
    return { application, remote: null, rateLimited: false };
  }

    if (
      !forceRefresh &&
      application.docusignStatus === "COMPLETED" &&
      application.legalSignedAt
    ) {
      // Still return a minimal remote snapshot so the UI can show completion
      // without another DocuSign API call.
      return {
        application,
        remote: {
          status: "COMPLETED",
          completedDateTime: application.legalSignedAt,
          signers: [],
          multipleSigners: true,
          pendingSigners: [],
          allSignersCompleted: true,
        },
        rateLimited: false,
      };
    }

  try {
    const remote = await getEnvelopeStatus(application.docusignEnvelopeId, {
      forceRefresh,
    });
    if (!remote.status) {
      return { application, remote, rateLimited: false };
    }

    let resolvedRemote = remote;
    if (
      forceRefresh &&
      remote.allSignersCompleted &&
      remote.status !== "COMPLETED"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      resolvedRemote = await getEnvelopeStatus(application.docusignEnvelopeId, {
        forceRefresh: true,
      });
    }

    const shouldUpdate =
      resolvedRemote.status !== application.docusignStatus ||
      (resolvedRemote.status === "COMPLETED" && !application.legalSignedAt);

    if (!shouldUpdate) {
      return { application, remote: resolvedRemote, rateLimited: false };
    }

    const updateData = { docusignStatus: resolvedRemote.status };
    if (resolvedRemote.status === "COMPLETED") {
      updateData.legalSignedAt = resolvedRemote.completedDateTime
        ? new Date(resolvedRemote.completedDateTime)
        : application.legalSignedAt || new Date();

      const signers = resolvedRemote.signers || [];
      const allDone =
        resolvedRemote.allSignersCompleted ||
        (signers.length >= 2 &&
          signers.every((signer) =>
            ["completed", "signed", "autoresponded"].includes(
              String(signer.status || "").toLowerCase()
            )
          ));
      if (allDone) {
        const stage2 =
          application.stage2Data && typeof application.stage2Data === "object"
            ? application.stage2Data
            : {};
        const witness =
          stage2.witness && typeof stage2.witness === "object" ? stage2.witness : {};
        if (!witness.declarationSigned) {
          updateData.stage2Data = {
            ...stage2,
            witness: { ...witness, declarationSigned: true },
          };
        }
      }
    } else if (application.docusignStatus === "COMPLETED") {
      updateData.legalSignedAt = null;
    }

    const updated = await prisma.application.update({
      where: { id: application.id },
      data: updateData,
    });

    return { application: updated, remote: resolvedRemote, rateLimited: false };
  } catch (err) {
    const rateLimited = !!err.rateLimited;
    if (rateLimited) {
      console.warn("DocuSign status sync rate-limited — using saved application status.");
    } else {
      console.warn("DocuSign status sync failed:", err.message);
    }
    return { application, remote: null, rateLimited };
  }
}

export async function syncDocusignStatusFromApi(application, options = {}) {
  const { application: next } = await getApplicationDocusignSnapshot(application, options);
  return next;
}

export async function syncApplicationsDocusignStatus(applications) {
  if (!Array.isArray(applications) || applications.length === 0) {
    return applications;
  }

  return Promise.all(applications.map((app) => syncDocusignStatusFromApi(app)));
}
