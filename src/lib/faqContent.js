export const FAQ_CONTENT_KEY = "faq_content";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeParagraphs(value) {
  if (!Array.isArray(value)) return null;
  const paragraphs = value.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  return paragraphs.length > 0 ? paragraphs : null;
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => {
      const paragraphs = normalizeParagraphs(item?.answerParagraphs);
      const question = typeof item?.question === "string" ? item.question.trim() : "";
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      if (!question || !paragraphs) return null;
      return {
        id: id || question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        question,
        answerParagraphs: paragraphs,
      };
    })
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export function validateFaqContent(body) {
  if (!body || typeof body !== "object") return null;

  const items = normalizeItems(body.items);
  const intro = body.intro;
  const contact = body.contact;

  if (
    !items ||
    !intro ||
    !isNonEmptyString(intro.eyebrow) ||
    !contact ||
    !isNonEmptyString(contact.eyebrow) ||
    !contact.legal ||
    !isNonEmptyString(contact.legal.title) ||
    !isNonEmptyString(contact.legal.description) ||
    !isNonEmptyString(contact.legal.email) ||
    !contact.admin ||
    !isNonEmptyString(contact.admin.title) ||
    !isNonEmptyString(contact.admin.description) ||
    !isNonEmptyString(contact.admin.email) ||
    !isNonEmptyString(contact.disclaimer)
  ) {
    return null;
  }

  return {
    intro: { eyebrow: intro.eyebrow.trim() },
    items,
    contact: {
      eyebrow: contact.eyebrow.trim(),
      legal: {
        title: contact.legal.title.trim(),
        description: contact.legal.description.trim(),
        email: contact.legal.email.trim(),
      },
      admin: {
        title: contact.admin.title.trim(),
        description: contact.admin.description.trim(),
        email: contact.admin.email.trim(),
      },
      disclaimer: contact.disclaimer.trim(),
    },
  };
}
