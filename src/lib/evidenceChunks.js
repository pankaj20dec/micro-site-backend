import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

const CHUNK_ROOT = path.join(process.cwd(), "uploads", ".chunks");
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNKS = 40;

function chunkDir(fileKey) {
  const id = crypto.createHash("sha256").update(String(fileKey)).digest("hex");
  return path.join(CHUNK_ROOT, id);
}

export function parseChunkHeaders(req) {
  const indexRaw = req.headers["x-chunk-index"];
  const countRaw = req.headers["x-chunk-count"];
  if (indexRaw == null && countRaw == null) return null;

  const index = Number(indexRaw);
  const count = Number(countRaw);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 1) {
    throw Object.assign(new Error("Invalid upload chunk headers"), { status: 400 });
  }
  if (count > MAX_CHUNKS || index >= count) {
    throw Object.assign(new Error("Invalid upload chunk headers"), { status: 400 });
  }
  return { index, count };
}

export async function collectUploadBuffer(fileKey, buffer, chunk) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("Empty file upload"), { status: 400 });
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error("This file is too large. Please upload a PDF, JPG or PNG under 15 MB."), {
      status: 413,
    });
  }
  if (!chunk) {
    return buffer;
  }
  if (buffer.length > MAX_CHUNK_BYTES) {
    throw Object.assign(new Error("This file is too large. Please upload a PDF, JPG or PNG under 15 MB."), {
      status: 413,
    });
  }

  const dir = chunkDir(fileKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, String(chunk.index)), buffer);

  const names = new Set((await fs.readdir(dir)).filter((name) => /^\d+$/.test(name)));
  for (let i = 0; i < chunk.count; i++) {
    if (!names.has(String(i))) return null;
  }

  const parts = [];
  let total = 0;
  for (let i = 0; i < chunk.count; i++) {
    const part = await fs.readFile(path.join(dir, String(i)));
    total += part.length;
    if (total > MAX_FILE_BYTES) {
      await fs.rm(dir, { recursive: true, force: true });
      throw Object.assign(new Error("This file is too large. Please upload a PDF, JPG or PNG under 15 MB."), {
        status: 413,
      });
    }
    parts.push(part);
  }
  await fs.rm(dir, { recursive: true, force: true });
  return Buffer.concat(parts);
}
