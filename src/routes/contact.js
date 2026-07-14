import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAdmin } from "../middleware/auth.js";

export const contactRouter = Router();

contactRouter.post("/", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};

    const missing = [];
    if (!name?.trim()) missing.push("name");
    if (!email?.trim()) missing.push("email");
    if (!subject?.trim()) missing.push("subject");
    if (!message?.trim()) missing.push("message");

    if (missing.length > 0) {
      return res
        .status(400)
        .json({ error: `Missing required fields: ${missing.join(", ")}` });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const submission = await prisma.contactSubmission.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        subject: subject.trim(),
        message: message.trim(),
        ip,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Your message has been received. We will get back to you soon.",
      id: submission.id,
    });
  } catch (err) {
    console.error("Contact form error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: list all contact submissions
contactRouter.get("/", requireAdmin, async (req, res) => {
  try {
    const { status, page = "1", limit = "50" } = req.query;
    const where = status ? { status } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [submissions, total] = await prisma.$transaction([
      prisma.contactSubmission.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: parseInt(limit),
      }),
      prisma.contactSubmission.count({ where }),
    ]);

    return res.json({ submissions, total, page: parseInt(page) });
  } catch (err) {
    console.error("Fetch contacts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: update contact status (read/replied/archived)
contactRouter.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    const valid = ["NEW", "READ", "REPLIED", "ARCHIVED"];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const submission = await prisma.contactSubmission.update({
      where: { id: req.params.id },
      data: { status },
    });
    return res.json({ submission });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Super admin: delete a submission
contactRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.contactSubmission.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
