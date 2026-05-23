import { Router } from "express";
import { Page } from "../models/Page.js";
import { requireAdmin } from "../middleware/auth.js";

export const adminPagesRouter = Router();

adminPagesRouter.use(requireAdmin);

adminPagesRouter.get("/", async (_req, res) => {
  try {
    const pages = await Page.find().sort({ updatedAt: -1 }).lean();
    res.json({ pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load pages" });
  }
});

adminPagesRouter.post("/", async (req, res) => {
  try {
    const { slug, title, body, published } = req.body || {};
    if (!slug || !title) {
      return res.status(400).json({ error: "slug and title are required" });
    }
    const page = await Page.create({
      slug: String(slug).trim(),
      title: String(title).trim(),
      body: body != null ? String(body) : "",
      published: Boolean(published),
    });
    res.status(201).json({ page });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to create page" });
  }
});

adminPagesRouter.patch("/:id", async (req, res) => {
  try {
    const { title, body, published, slug } = req.body || {};
    const updates = {};
    if (title !== undefined) updates.title = String(title).trim();
    if (body !== undefined) updates.body = String(body);
    if (published !== undefined) updates.published = Boolean(published);
    if (slug !== undefined) updates.slug = String(slug).trim();
    const page = await Page.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    }).lean();
    if (!page) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ page });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to update page" });
  }
});

adminPagesRouter.delete("/:id", async (req, res) => {
  try {
    const result = await Page.findByIdAndDelete(req.params.id);
    if (!result) {
      return res.status(404).json({ error: "Not found" });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete page" });
  }
});
