import { prisma } from "../config/db.js";
import { getEnvelopeStatus, isDocusignConfigured } from "./docusignClient.js";

export async function syncDocusignStatusFromApi(application) {
  if (
    !application?.docusignEnvelopeId ||
    !isDocusignConfigured() ||
    application.docusignStatus === "COMPLETED"
  ) {
    return application;
  }

  try {
    const remote = await getEnvelopeStatus(application.docusignEnvelopeId);
    if (!remote.status) {
      return application;
    }

    const shouldUpdate =
      remote.status !== application.docusignStatus ||
      (remote.status === "COMPLETED" && !application.legalSignedAt);

    if (!shouldUpdate) {
      return application;
    }

    const updateData = { docusignStatus: remote.status };
    if (remote.status === "COMPLETED") {
      updateData.legalSignedAt = remote.completedDateTime
        ? new Date(remote.completedDateTime)
        : new Date();
    }

    return await prisma.application.update({
      where: { id: application.id },
      data: updateData,
    });
  } catch (err) {
    console.warn("DocuSign status sync failed:", err.message);
    return application;
  }
}

export async function syncApplicationsDocusignStatus(applications) {
  if (!Array.isArray(applications) || applications.length === 0) {
    return applications;
  }

  return Promise.all(applications.map((app) => syncDocusignStatusFromApi(app)));
}
