import { Router } from "express";
import { prisma } from "../config/db.js";

export const publicPagesRouter = Router();

publicPagesRouter.get("/", async (_req, res) => {
  try {
    const pages = await prisma.page.findMany({
      where: { published: true },
      select: { id: true, slug: true, title: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    return res.json({ pages });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load pages" });
  }
});

publicPagesRouter.get("/:slug", async (req, res) => {
  try {
    const page = await prisma.page.findFirst({
      where: { slug: req.params.slug, published: true },
    });
    if (!page) return res.status(404).json({ error: "Not found" });
    return res.json({ page });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load page" });
  }
});
