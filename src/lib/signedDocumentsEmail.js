import { prisma } from "../config/db.js";
import { getEnvelopeCombinedPdf } from "./docusignClient.js";
import { sendFullySignedDocumentsEmail } from "./mailer.js";

function stage2Witness(application) {
  const stage2 =
    application?.stage2Data && typeof application.stage2Data === "object"
      ? application.stage2Data
      : {};
  const witness =
    stage2.witness && typeof stage2.witness === "object" ? stage2.witness : {};
  return { stage2, witness };
}

export function isWitnessDeclarationSigned(application) {
  return !!stage2Witness(application).witness.declarationSigned;
}

export function fullySignedDocumentsEmailSent(application) {
  return !!stage2Witness(application).witness.fullySignedDocumentsSentAt;
}

export async function markFullySignedDocumentsEmailSent(application) {
  const { stage2, witness } = stage2Witness(application);
  const updated = await prisma.application.update({
    where: { id: application.id },
    data: {
      stage2Data: {
        ...stage2,
        witness: {
          ...witness,
          fullySignedDocumentsSentAt: new Date().toISOString(),
        },
      },
    },
  });
  return updated;
}

/**
 * If the consultant already submitted, and the witness has now signed,
 * email the complete signed PDF once.
 */
export async function maybeSendFullySignedDocumentsEmail(application) {
  if (!application?.id || application.applicationType !== "CLAIMANT") {
    return { sent: false };
  }
  if (!["SUBMITTED", "APPROVED"].includes(String(application.status || ""))) {
    return { sent: false };
  }
  if (fullySignedDocumentsEmailSent(application)) {
    return { sent: false, already: true };
  }
  if (!isWitnessDeclarationSigned(application)) {
    return { sent: false, pending: true };
  }

  const user = await prisma.user.findUnique({
    where: { id: application.userId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!user?.email) return { sent: false };

  let signedDocumentsPdf = null;
  if (application.docusignEnvelopeId) {
    try {
      signedDocumentsPdf = await getEnvelopeCombinedPdf(application.docusignEnvelopeId);
    } catch (err) {
      console.error(
        "Could not attach fully signed legal documents:",
        err?.message || err
      );
    }
  }

  const result = await sendFullySignedDocumentsEmail(user, application, {
    signedDocumentsPdf,
  });
  if (!result?.ok) {
    console.error("Fully signed documents email failed:", result?.error);
    return { sent: false, error: result?.error };
  }

  await markFullySignedDocumentsEmailSent(application);
  console.log(`Fully signed documents emailed to ${user.email} (${application.id})`);
  return { sent: true };
}
