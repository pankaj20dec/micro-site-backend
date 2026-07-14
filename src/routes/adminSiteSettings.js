import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  MODAL_KEYS,
  isModalKey,
  modalDefaults,
  validateModalContent,
} from "../lib/modalContent.js";
import {
  LAYOUT_KEYS,
  isLayoutKey,
  layoutDefaults,
  mergeSiteHeader,
  validateLayoutContent,
} from "../lib/layoutContent.js";

export const adminSiteSettingsRouter = Router();

adminSiteSettingsRouter.use(requireAdmin);

async function getSettingContent(key, defaults) {
  const row = await prisma.siteSetting.findUnique({ where: { key } });
  if (row?.value) return row.value;
  return defaults[key];
}

async function getModalContent(key) {
  return getSettingContent(key, modalDefaults);
}

async function getLayoutContent(key) {
  const content = await getSettingContent(key, layoutDefaults);
  if (key === LAYOUT_KEYS.SITE_HEADER) {
    return mergeSiteHeader(content);
  }
  return content;
}

adminSiteSettingsRouter.get("/modals", async (_req, res) => {
  try {
    const [siteDisclaimer, registerDisclaimer] = await Promise.all([
      getModalContent(MODAL_KEYS.SITE_DISCLAIMER),
      getModalContent(MODAL_KEYS.REGISTER_DISCLAIMER),
    ]);
    return res.json({
      siteDisclaimer,
      registerDisclaimer,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load modal content" });
  }
});

adminSiteSettingsRouter.put("/modals/:key", async (req, res) => {
  try {
    const { key } = req.params;
    if (!isModalKey(key)) {
      return res.status(404).json({ error: "Unknown modal key" });
    }

    const validated = validateModalContent(key, req.body?.content);
    if (!validated) {
      return res.status(400).json({ error: "Invalid modal content" });
    }

    const row = await prisma.siteSetting.upsert({
      where: { key },
      create: { key, value: validated },
      update: { value: validated },
    });

    return res.json({ key, content: row.value });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save modal content" });
  }
});

adminSiteSettingsRouter.get("/layout", async (_req, res) => {
  try {
    const [siteHeader, authHeader, siteFooter] = await Promise.all([
      getLayoutContent(LAYOUT_KEYS.SITE_HEADER),
      getLayoutContent(LAYOUT_KEYS.AUTH_HEADER),
      getLayoutContent(LAYOUT_KEYS.SITE_FOOTER),
    ]);
    return res.json({ siteHeader, authHeader, siteFooter });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load layout content" });
  }
});

adminSiteSettingsRouter.put("/layout/:key", async (req, res) => {
  try {
    const { key } = req.params;
    if (!isLayoutKey(key)) {
      return res.status(404).json({ error: "Unknown layout key" });
    }

    const validated = validateLayoutContent(key, req.body?.content);
    if (!validated) {
      return res.status(400).json({ error: "Invalid layout content" });
    }

    const row = await prisma.siteSetting.upsert({
      where: { key },
      create: { key, value: validated },
      update: { value: validated },
    });

    return res.json({ key, content: row.value });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save layout content" });
  }
});

adminSiteSettingsRouter.get("/faq", async (_req, res) => {
  try {
    const { FAQ_CONTENT_KEY } = await import("../lib/faqContent.js");
    const row = await prisma.siteSetting.findUnique({ where: { key: FAQ_CONTENT_KEY } });
    return res.json({ content: row?.value ?? null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load FAQ content" });
  }
});

adminSiteSettingsRouter.put("/faq", async (req, res) => {
  try {
    const { FAQ_CONTENT_KEY, validateFaqContent } = await import("../lib/faqContent.js");
    const validated = validateFaqContent(req.body?.content);
    if (!validated) {
      return res.status(400).json({ error: "Invalid FAQ content" });
    }

    const row = await prisma.siteSetting.upsert({
      where: { key: FAQ_CONTENT_KEY },
      create: { key: FAQ_CONTENT_KEY, value: validated },
      update: { value: validated },
    });

    return res.json({ content: row.value });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save FAQ content" });
  }
});

adminSiteSettingsRouter.get("/seo", async (_req, res) => {
  try {
    const { SEO_CONTENT_KEY } = await import("../lib/seoContent.js");
    const row = await prisma.siteSetting.findUnique({ where: { key: SEO_CONTENT_KEY } });
    return res.json({ content: row?.value ?? null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load SEO settings" });
  }
});

adminSiteSettingsRouter.put("/seo", async (req, res) => {
  try {
    const { SEO_CONTENT_KEY, validateSeoContent } = await import("../lib/seoContent.js");
    const validated = validateSeoContent(req.body?.content);
    if (!validated) {
      return res.status(400).json({ error: "Invalid SEO settings" });
    }

    const row = await prisma.siteSetting.upsert({
      where: { key: SEO_CONTENT_KEY },
      create: { key: SEO_CONTENT_KEY, value: validated },
      update: { value: validated },
    });

    return res.json({ content: row.value });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save SEO settings" });
  }
});
