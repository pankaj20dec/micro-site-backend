import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const LOCAL_ROOT = path.join(process.cwd(), "uploads");

function isPlaceholder(value) {
  return !value || value === "placeholder" || value === "...";
}

export function getSpacesConfig() {
  return {
    endpoint: process.env.DO_SPACES_ENDPOINT,
    // AWS SDK requires us-east-1 for Spaces signing (even for lon1/ams3 buckets).
    region: process.env.DO_SPACES_SDK_REGION || "us-east-1",
    bucket: process.env.DO_SPACES_BUCKET,
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
    cdnEndpoint: process.env.DO_SPACES_CDN_ENDPOINT,
  };
}

export function isSpacesConfigured() {
  const config = getSpacesConfig();
  return (
    !isPlaceholder(config.endpoint) &&
    !isPlaceholder(config.bucket) &&
    !isPlaceholder(config.accessKeyId) &&
    !isPlaceholder(config.secretAccessKey)
  );
}

function getS3Client() {
  const config = getSpacesConfig();
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: false,
    // Avoid x-amz-checksum-* query params on presigned PUT URLs (breaks Spaces CORS).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || "file"));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "file";
}

export function buildEvidenceFileKey(applicationId, uploadKey, fileName) {
  const safeKey = String(uploadKey || "general").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeName = sanitizeFileName(fileName);
  return `evidence/${applicationId}/${safeKey}/${crypto.randomBytes(8).toString("hex")}-${safeName}`;
}

export const PMI_EVIDENCE_UPLOAD_KEYS = ["pmi-evidence-a", "pmi-evidence-b"];

export function isPmiEvidenceUploadKey(uploadKey) {
  return PMI_EVIDENCE_UPLOAD_KEYS.includes(String(uploadKey || ""));
}

export function isPmiEvidenceFileKey(fileKey) {
  if (isPmiEvidenceUploadKey(fileKey)) return true;
  const key = String(fileKey || "");
  return key.includes("/pmi-evidence-a/") || key.includes("/pmi-evidence-b/");
}

export function parseUploadKeyFromFileKey(fileKey) {
  const parts = String(fileKey || "").split("/");
  if (parts.length >= 4 && parts[0] === "evidence") {
    return parts[2] || "general";
  }
  return "general";
}

function getLocalPath(fileKey) {
  if (!fileKey || fileKey.includes("..")) {
    throw new Error("Invalid file key");
  }
  return path.join(LOCAL_ROOT, fileKey);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function createEvidenceUploadTarget({ applicationId, uploadKey, fileName, mimeType }) {
  const normalizedUploadKey = String(uploadKey || "general").replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileKey = buildEvidenceFileKey(applicationId, normalizedUploadKey, fileName);

  if (isSpacesConfigured()) {
    return {
      fileKey,
      uploadKey: normalizedUploadKey,
      uploadUrl: "/api/application/evidence/upload",
      method: "POST",
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "X-File-Key": fileKey,
        "X-File-Name": encodeURIComponent(fileName),
      },
      storage: "spaces",
    };
  }

  return {
    fileKey,
    uploadKey: normalizedUploadKey,
    uploadUrl: "/api/application/evidence/upload",
    method: "POST",
    headers: {
      "Content-Type": mimeType || "application/octet-stream",
      "X-File-Key": fileKey,
      "X-File-Name": encodeURIComponent(fileName),
    },
    storage: "local",
    stub: true,
  };
}

export async function saveEvidenceBufferLocal(fileKey, buffer) {
  const fullPath = getLocalPath(fileKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

export async function saveEvidenceBuffer(fileKey, buffer, mimeType) {
  if (isSpacesConfigured()) {
    const { bucket, endpoint } = getSpacesConfig();
    const client = getS3Client();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fileKey,
          Body: buffer,
          ContentType: mimeType || "application/octet-stream",
        })
      );
      return "spaces";
    } catch (err) {
      const details = {
        name: err.name,
        message: err.message,
        code: err.Code || err.code,
        endpoint,
        bucket,
        fileKey,
      };
      console.error("Spaces upload failed:", details);
      throw new Error(details.message || "Spaces upload failed");
    }
  }

  await saveEvidenceBufferLocal(fileKey, buffer);
  return "local";
}

export async function getEvidenceFileBuffer(fileKey) {
  if (!fileKey) return null;

  if (isSpacesConfigured()) {
    const { bucket } = getSpacesConfig();
    const client = getS3Client();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: fileKey,
      })
    );
    if (!response.Body) return null;
    return streamToBuffer(response.Body);
  }

  try {
    return await fs.readFile(getLocalPath(fileKey));
  } catch {
    return null;
  }
}

export async function deleteEvidenceFile(fileKey) {
  if (!fileKey) return;

  if (isSpacesConfigured()) {
    const { bucket } = getSpacesConfig();
    const client = getS3Client();
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: fileKey,
        })
      )
      .catch(() => null);
    return;
  }

  await fs.unlink(getLocalPath(fileKey)).catch(() => null);
}

export function getFileExtension(fileName) {
  const ext = path.extname(String(fileName || "")).replace(".", "").toLowerCase();
  return ext || "pdf";
}
