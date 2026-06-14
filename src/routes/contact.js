import { Router } from "express";
import { Lead } from "../models/Lead.js";

export const contactRouter = Router();

contactRouter.post("/", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    const missing = [];
    if (!name?.trim()) missing.push("name");
    if (!email?.trim()) missing.push("email");
    if (!subject?.trim()) missing.push("subject");
    if (!message?.trim()) missing.push("message");

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const lead = await Lead.create({ name, email, subject, message, ip });

    return res.status(201).json({
      success: true,
      message: "Your message has been received. We will get back to you soon.",
      id: lead._id,
    });
  } catch (err) {
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ error: messages.join("; ") });
    }
    console.error("Contact form error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: list all leads (JWT protected — import requireAdmin where you mount this)
contactRouter.get("/leads", async (_req, res) => {
  try {
    const leads = await Lead.find().sort({ createdAt: -1 });
    return res.json({ leads });
  } catch (err) {
    console.error("Fetch leads error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
