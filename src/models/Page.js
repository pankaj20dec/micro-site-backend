import mongoose from "mongoose";

const pageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: "" },
    published: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Page = mongoose.models.Page || mongoose.model("Page", pageSchema);
