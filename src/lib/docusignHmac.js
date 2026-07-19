import crypto from "crypto";

const EVENT_STATUS_MAP = {
  "envelope-sent": "SENT",
  "envelope-delivered": "DELIVERED",
  "envelope-completed": "COMPLETED",
  "envelope-declined": "DECLINED",
};

export function getDocusignSignatures(headers) {
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase().startsWith("x-docusign-signature-"))
    .map(([, value]) => value);
}

export function verifyDocusignHmac(rawBody, secret, signatures) {
  if (!secret || signatures.length === 0) return false;

  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const computed = crypto.createHmac("sha256", secret).update(payload).digest("base64");

  return signatures.some((signature) => {
    if (!signature) return false;
    try {
      const received = Buffer.from(signature);
      const expected = Buffer.from(computed);
      return received.length === expected.length && crypto.timingSafeEqual(received, expected);
    } catch {
      return false;
    }
  });
}

export function mapConnectEventToStatus(eventName, envelopeSummary) {
  if (eventName && EVENT_STATUS_MAP[eventName]) {
    return EVENT_STATUS_MAP[eventName];
  }

  const status = envelopeSummary?.status?.toUpperCase();
  if (status && Object.values(EVENT_STATUS_MAP).includes(status)) {
    return status;
  }

  return null;
}
