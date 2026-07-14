import { Router } from "express";
import { prisma } from "../config/db.js";
import { isLayoutKey, layoutDefaults, LAYOUT_KEYS, mergeSiteHeader } from "../lib/layoutContent.js";

export const siteSettingsRouter = Router();

async function getSettingContent(key, defaults) {
  const row = await prisma.siteSetting.findUnique({ where: { key } });
  if (row?.value) return row.value;
  return defaults[key];
}

async function getModalContent(key) {
  const { modalDefaults } = await import("../lib/modalContent.js");
  return getSettingContent(key, modalDefaults);
}

async function getLayoutContent(key) {
  const content = await getSettingContent(key, layoutDefaults);
  if (key === LAYOUT_KEYS.SITE_HEADER) {
    return mergeSiteHeader(content);
  }
  return content;
}

siteSettingsRouter.get("/modals/:key", async (req, res) => {
  try {
    const { modalDefaults, isModalKey } = await import("../lib/modalContent.js");
    const { key } = req.params;
    if (!isModalKey(key)) {
      return res.status(404).json({ error: "Unknown modal key" });
    }
    const content = await getSettingContent(key, modalDefaults);
    return res.json({ key, content });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load modal content" });
  }
});

siteSettingsRouter.get("/modals", async (_req, res) => {
  try {
    const { MODAL_KEYS } = await import("../lib/modalContent.js");
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

siteSettingsRouter.get("/layout/:key", async (req, res) => {
  try {
    const { key } = req.params;
    if (!isLayoutKey(key)) {
      return res.status(404).json({ error: "Unknown layout key" });
    }
    const content = await getLayoutContent(key);
    return res.json({ key, content });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load layout content" });
  }
});

siteSettingsRouter.get("/layout", async (_req, res) => {
  try {
    const { LAYOUT_KEYS } = await import("../lib/layoutContent.js");
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

siteSettingsRouter.get("/faq", async (_req, res) => {
  try {
    const { FAQ_CONTENT_KEY } = await import("../lib/faqContent.js");
    const row = await prisma.siteSetting.findUnique({ where: { key: FAQ_CONTENT_KEY } });
    return res.json({ content: row?.value ?? null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load FAQ content" });
  }
});

siteSettingsRouter.get("/seo", async (_req, res) => {
  try {
    const { SEO_CONTENT_KEY } = await import("../lib/seoContent.js");
    const row = await prisma.siteSetting.findUnique({ where: { key: SEO_CONTENT_KEY } });
    return res.json({ content: row?.value ?? null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load SEO settings" });
  }
});
