import { execFile } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);

function sofficeCandidates() {
  return [
    process.env.LIBREOFFICE_PATH,
    "soffice",
    "libreoffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ].filter(Boolean);
}

export async function findLibreOffice() {
  for (const bin of sofficeCandidates()) {
    try {
      await execFileAsync(bin, ["--version"], { timeout: 8000, windowsHide: true });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

function collapseMergeTagXml(xml) {
  return xml.replace(/\{\{[\s\S]*?\}\}/g, (match) => match.replace(/<[^>]+>/g, ""));
}

function replacePlain(xml, search, replacement) {
  if (!search) return xml;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml.replace(new RegExp(escaped, "gi"), replacement);
}

export function fillDocxMergeFields(docxBuffer, fields) {
  return fillDocxMergeFieldsAsync(docxBuffer, fields);
}

async function fillDocxMergeFieldsAsync(docxBuffer, fields) {
  const zip = await JSZip.loadAsync(docxBuffer);
  const replacements = Object.entries(fields)
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => [String(key), escapeXml(String(value).trim())]);

  const parts = Object.keys(zip.files).filter(
    (name) =>
      name.startsWith("word/") &&
      name.endsWith(".xml") &&
      !name.includes("/_rels/")
  );

  for (const name of parts) {
    let xml = await zip.file(name).async("string");
    xml = collapseMergeTagXml(xml);
    for (const [key, value] of replacements) {
      xml = replacePlain(xml, `{{${key}}}`, value);
      xml = replacePlain(xml, `«${key}»`, value);
      xml = replacePlain(xml, `&lt;&lt;${key}&gt;&gt;`, value);
    }
    zip.file(name, xml);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function convertDocxToPdf(docxBuffer) {
  const soffice = await findLibreOffice();
  if (!soffice) {
    throw new Error(
      "LibreOffice is not installed. Install it on the server so Word letters convert to PDF with original fonts (sudo apt-get install -y libreoffice-writer)."
    );
  }

  const dir = await fs.mkdtemp(join(tmpdir(), "fipo-docx-"));
  const input = join(dir, "letter.docx");
  const output = join(dir, "letter.pdf");
  try {
    await fs.writeFile(input, docxBuffer);
    await execFileAsync(
      soffice,
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        dir,
        input,
      ],
      { timeout: 90000, windowsHide: true }
    );
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function isWordDocument(name = "", extension = "") {
  const haystack = `${name}.${extension}`.toLowerCase();
  return haystack.includes(".doc");
}
