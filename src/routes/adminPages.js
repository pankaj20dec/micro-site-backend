import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAdmin } from "../middleware/auth.js";

export const adminPagesRouter = Router();

adminPagesRouter.use(requireAdmin);

adminPagesRouter.get("/", async (_req, res) => {
  try {
    const pages = await prisma.page.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return res.json({ pages });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load pages" });
  }
});

adminPagesRouter.post("/", async (req, res) => {
  try {
    const { slug, title, body, published } = req.body || {};
    if (!slug?.trim() || !title?.trim()) {
      return res.status(400).json({ error: "slug and title are required" });
    }
    const page = await prisma.page.create({
      data: {
        slug: slug.trim(),
        title: title.trim(),
        body: body ?? "",
        published: Boolean(published),
      },
    });
    return res.status(201).json({ page });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to create page" });
  }
});

adminPagesRouter.patch("/:id", async (req, res) => {
  try {
    const { title, body, published, slug } = req.body || {};
    const data = {};
    if (title !== undefined) data.title = title.trim();
    if (body !== undefined) data.body = body;
    if (published !== undefined) data.published = Boolean(published);
    if (slug !== undefined) data.slug = slug.trim();

    const page = await prisma.page.update({
      where: { id: req.params.id },
      data,
    });
    return res.json({ page });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    if (err.code === "P2002") return res.status(409).json({ error: "Slug already exists" });
    console.error(err);
    return res.status(500).json({ error: "Failed to update page" });
  }
});

adminPagesRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.page.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Failed to delete page" });
  }
});
