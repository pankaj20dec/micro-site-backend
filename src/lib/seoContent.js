export const SEO_CONTENT_KEY = "seo_settings";

const PAGE_KEYS = [
  "home",
  "about",
  "contact",
  "claim",
  "faq",
  "news",
  "explanations",
  "register",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePageSeo(value) {
  if (!value || typeof value !== "object") return null;
  if (!isNonEmptyString(value.title) || !isNonEmptyString(value.description)) {
    return null;
  }
  return {
    title: value.title.trim(),
    description: value.description.trim(),
    noIndex: Boolean(value.noIndex),
  };
}

export function validateSeoContent(body) {
  if (!body || typeof body !== "object") return null;

  const siteName = typeof body.siteName === "string" ? body.siteName.trim() : "";
  const siteUrl = typeof body.siteUrl === "string" ? body.siteUrl.trim() : "";
  const defaultOgImage =
    typeof body.defaultOgImage === "string" ? body.defaultOgImage.trim() : "";

  if (!isNonEmptyString(siteName) || !body.pages || typeof body.pages !== "object") {
    return null;
  }

  if (siteUrl) {
    try {
      new URL(siteUrl);
    } catch {
      return null;
    }
  }

  const pages = {};
  for (const key of PAGE_KEYS) {
    const page = normalizePageSeo(body.pages[key]);
    if (!page) return null;
    pages[key] = page;
  }

  return {
    siteName,
    siteUrl,
    defaultOgImage,
    pages,
  };
}
