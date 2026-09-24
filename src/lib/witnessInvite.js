import jwt from "jsonwebtoken";
import { resolveAppBaseUrl } from "./appBaseUrl.js";

const PURPOSE = "docusign_witness_invite";

export function getWitnessInviteTtlDays() {
  const parsed = Number(process.env.DOCUSIGN_WITNESS_LINK_DAYS);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 120) {
    return Math.floor(parsed);
  }
  return 30;
}

export function signWitnessInviteToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  const days = getWitnessInviteTtlDays();
  return jwt.sign(
    {
      purpose: PURPOSE,
      applicationId: payload.applicationId,
      envelopeId: payload.envelopeId,
      email: payload.email,
      name: payload.name,
      address: payload.address || "",
      clientUserId: payload.clientUserId || "",
    },
    secret,
    { expiresIn: `${days}d` }
  );
}

export function verifyWitnessInviteToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  const payload = jwt.verify(String(token || ""), secret);
  if (payload.purpose !== PURPOSE) {
    const err = new Error("Invalid witness invitation");
    err.code = "INVALID_WITNESS_INVITE";
    throw err;
  }
  return payload;
}

export function buildWitnessInviteUrl(req, requestedBaseUrl, token) {
  const appBase = resolveAppBaseUrl(req, requestedBaseUrl);
  const url = new URL("/api/docusign/witness/open", appBase);
  url.searchParams.set("token", token);
  return url.toString();
}
