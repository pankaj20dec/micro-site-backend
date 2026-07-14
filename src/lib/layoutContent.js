export const LAYOUT_KEYS = {
  SITE_HEADER: "site_header",
  AUTH_HEADER: "auth_header",
  SITE_FOOTER: "site_footer",
};

export const defaultSiteHeader = {
  ctaLabel: "Join the Claim",
  ctaHref: "/#join",
  navLinks: [
    { label: "The Claim", href: "/" },
    { label: "Explanations", href: "/explanations" },
    { label: "FAQs", href: "/faq" },
    { label: "About us", href: "/about" },
    { label: "News", href: "/news" },
    { label: "Contact", href: "/contact" },
    { label: "Login", href: "/login" },
  ],
};

export const defaultAuthHeader = {
  email: "fipo@harcusparker.co.uk",
  helpline: "020 7205 4166",
  helplineHours: "(Mon-Fri 9am-5pm)",
  faqLabel: "Visit FAQs",
  faqHref: "/faq",
};

export const defaultSiteFooter = {
  contactCardLabel: "Contact Us",
  contactCardEmail: "office@fipo.uk",
  quickLinksTitle: "Quick Links",
  quickLinks: [
    { label: "The Claim", href: "/" },
    { label: "Explanations", href: "/explanations" },
    { label: "FAQs", href: "/faq" },
    { label: "About us", href: "/about" },
    { label: "News", href: "/news" },
    { label: "Contact", href: "/contact" },
    { label: "Login", href: "/login" },
  ],
  contactInfoTitle: "Contact Info",
  contactEmail: "fipo@harcusparker.co.uk",
  contactPhone: "020 7205 4166",
  addressLines: [
    "The Harley Building",
    "77-79 New Cavendish Street",
    "London",
    "W1W 6XB",
  ],
  legalLine1:
    "The Federation of Independent Practitioner Organisations is a company limited by guarantee, registered in England number 4148752.",
  legalLine2:
    "Registered office: The Harley Building, 77-79 New Cavendish Street, London, W1W 6XB.",
  partnerUrl: "https://harcusparker.co.uk",
};

export const layoutDefaults = {
  [LAYOUT_KEYS.SITE_HEADER]: defaultSiteHeader,
  [LAYOUT_KEYS.AUTH_HEADER]: defaultAuthHeader,
  [LAYOUT_KEYS.SITE_FOOTER]: defaultSiteFooter,
};

export function isLayoutKey(key) {
  return Object.values(LAYOUT_KEYS).includes(key);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeQuickLinks(value) {
  if (!Array.isArray(value)) return null;
  const links = value
    .map((item) => ({
      label: typeof item?.label === "string" ? item.label.trim() : "",
      href: typeof item?.href === "string" ? item.href.trim() : "",
    }))
    .filter((item) => item.label && item.href);
  return links.length > 0 ? links : null;
}

function normalizeAddressLines(value) {
  if (!Array.isArray(value)) return null;
  const lines = value.map((line) => (typeof line === "string" ? line.trim() : "")).filter(Boolean);
  return lines.length > 0 ? lines : null;
}

export function mergeSiteHeader(content) {
  const navLinks = normalizeQuickLinks(content?.navLinks);
  return {
    ctaLabel: isNonEmptyString(content?.ctaLabel)
      ? content.ctaLabel.trim()
      : defaultSiteHeader.ctaLabel,
    ctaHref: isNonEmptyString(content?.ctaHref)
      ? content.ctaHref.trim()
      : defaultSiteHeader.ctaHref,
    navLinks: navLinks ?? defaultSiteHeader.navLinks,
  };
}

export function validateSiteHeader(body) {
  if (!body || typeof body !== "object") return null;
  const navLinks = normalizeQuickLinks(body.navLinks);
  if (!navLinks || !isNonEmptyString(body.ctaLabel) || !isNonEmptyString(body.ctaHref)) {
    return null;
  }
  return {
    ctaLabel: body.ctaLabel.trim(),
    ctaHref: body.ctaHref.trim(),
    navLinks,
  };
}

export function validateAuthHeader(body) {
  if (!body || typeof body !== "object") return null;
  if (
    !isNonEmptyString(body.email) ||
    !isNonEmptyString(body.helpline) ||
    !isNonEmptyString(body.faqLabel) ||
    !isNonEmptyString(body.faqHref)
  ) {
    return null;
  }
  return {
    email: body.email.trim(),
    helpline: body.helpline.trim(),
    helplineHours: isNonEmptyString(body.helplineHours)
      ? body.helplineHours.trim()
      : defaultAuthHeader.helplineHours,
    faqLabel: body.faqLabel.trim(),
    faqHref: body.faqHref.trim(),
  };
}

export function validateSiteFooter(body) {
  if (!body || typeof body !== "object") return null;
  const quickLinks = normalizeQuickLinks(body.quickLinks);
  const addressLines = normalizeAddressLines(body.addressLines);
  if (
    !isNonEmptyString(body.contactCardLabel) ||
    !isNonEmptyString(body.contactCardEmail) ||
    !isNonEmptyString(body.quickLinksTitle) ||
    !quickLinks ||
    !isNonEmptyString(body.contactInfoTitle) ||
    !isNonEmptyString(body.contactEmail) ||
    !isNonEmptyString(body.contactPhone) ||
    !addressLines ||
    !isNonEmptyString(body.legalLine1) ||
    !isNonEmptyString(body.legalLine2)
  ) {
    return null;
  }
  return {
    contactCardLabel: body.contactCardLabel.trim(),
    contactCardEmail: body.contactCardEmail.trim(),
    quickLinksTitle: body.quickLinksTitle.trim(),
    quickLinks,
    contactInfoTitle: body.contactInfoTitle.trim(),
    contactEmail: body.contactEmail.trim(),
    contactPhone: body.contactPhone.trim(),
    addressLines,
    legalLine1: body.legalLine1.trim(),
    legalLine2: body.legalLine2.trim(),
    partnerUrl: isNonEmptyString(body.partnerUrl)
      ? body.partnerUrl.trim()
      : defaultSiteFooter.partnerUrl,
  };
}

export function validateLayoutContent(key, body) {
  if (key === LAYOUT_KEYS.SITE_HEADER) return validateSiteHeader(body);
  if (key === LAYOUT_KEYS.AUTH_HEADER) return validateAuthHeader(body);
  if (key === LAYOUT_KEYS.SITE_FOOTER) return validateSiteFooter(body);
  return null;
}
