function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return null;

  try {
    if (trimmed.includes("://")) {
      return new URL(trimmed).origin;
    }
  } catch {
    return null;
  }

  return trimmed;
}

export function getAllowedOrigins() {
  const origins = (process.env.CORS_ORIGIN || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

  const appBase = normalizeOrigin(process.env.APP_BASE_URL);
  if (appBase && !origins.includes(appBase)) {
    origins.push(appBase);
  }

  return origins;
}

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return getAllowedOrigins().includes(normalized);
}

/**
 * Resolve the public frontend base URL for redirects (PayPal return/cancel, emails).
 * Prefers an explicit client origin when it matches CORS_ORIGIN / APP_BASE_URL.
 */
export function resolveAppBaseUrl(req, requestedBaseUrl) {
  const candidates = [
    requestedBaseUrl,
    req?.headers?.origin,
  ];

  if (req?.headers?.referer) {
    try {
      candidates.push(new URL(req.headers.referer).origin);
    } catch {
      // ignore invalid referer
    }
  }

  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate);
    if (origin && isAllowedOrigin(origin)) {
      return origin;
    }
  }

  const fallback = normalizeOrigin(process.env.APP_BASE_URL) || "http://localhost:3000";
  return fallback;
}

export function registerPayPalReturnPath(baseUrl, params) {
  const url = new URL("/register", baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
