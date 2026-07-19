import "dotenv/config";
import { prisma } from "../src/config/db.js";
import { getEnvelopeStatus } from "../src/lib/docusignClient.js";

const apps = await prisma.application.findMany({
  where: { docusignEnvelopeId: { not: null } },
  select: {
    id: true,
    docusignEnvelopeId: true,
    docusignStatus: true,
    updatedAt: true,
    user: { select: { email: true } },
  },
  orderBy: { updatedAt: "desc" },
  take: 5,
});

for (const app of apps) {
  let remote = null;
  try {
    remote = await getEnvelopeStatus(app.docusignEnvelopeId);
  } catch (err) {
    remote = { error: err.message };
  }
  console.log(
    JSON.stringify(
      {
        email: app.user.email,
        dbStatus: app.docusignStatus,
        envelopeId: app.docusignEnvelopeId,
        remote,
      },
      null,
      2
    )
  );
}

process.exit(0);
