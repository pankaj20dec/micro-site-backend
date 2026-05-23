import { Router } from "express";
import { Page } from "../models/Page.js";

export const publicPagesRouter = Router();

publicPagesRouter.get("/", async (_req, res) => {
  try {
    const pages = await Page.find({ published: true })
      .select("slug title updatedAt")
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load pages" });
  }
});

publicPagesRouter.get("/:slug", async (req, res) => {
  try {
    const page = await Page.findOne({
      slug: req.params.slug,
      published: true,
    }).lean();
    if (!page) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ page });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load page" });
  }
});
