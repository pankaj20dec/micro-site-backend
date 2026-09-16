import { execFile } from "child_process";
import { constants as fsConstants } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);

let cachedSoffice;

function sofficeCandidates() {
  return [
    process.env.LIBREOFFICE_PATH,
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "soffice",
    "libreoffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ].filter(Boolean);
}

function looksLikeAbsoluteBin(bin) {
  return bin.startsWith("/") || /^[A-Za-z]:[\\/]/.test(bin);
}

export function detectOfficeBuffer(buffer) {
  if (!buffer || buffer.length < 4) return "unknown";
  if (buffer.slice(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (buffer.slice(0, 2).toString("latin1") === "PK") return "docx";
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return "doc";
  }
  return "unknown";
}

export async function findLibreOffice() {
  if (cachedSoffice !== undefined) return cachedSoffice;

  for (const bin of sofficeCandidates()) {
    if (looksLikeAbsoluteBin(bin)) {
      try {
        await fs.access(bin, fsConstants.X_OK);
        cachedSoffice = bin;
        return cachedSoffice;
      } catch {
        continue;
      }
    }
    try {
      await execFileAsync(bin, ["--version"], {
        timeout: 15000,
        windowsHide: true,
        killSignal: "SIGKILL",
      });
      cachedSoffice = bin;
      return cachedSoffice;
    } catch {
      // PATH lookup failed or --version hung
    }
  }

  cachedSoffice = null;
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

  const dearName = escapeXml(
    String(fields.name || fields.Name || fields["Full Name"] || "").trim()
  );

  for (const name of parts) {
    let xml = await zip.file(name).async("string");
    xml = collapseMergeTagXml(xml);
    xml = xml.replace(/Dear\s*\{\{/gi, "Dear {{");
    if (dearName) {
      xml = xml.replace(/Dear\s*\[Medical Practitioner\]/gi, `Dear ${dearName}`);
    }
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

function profileUri(dir) {
  const unix = dir.replace(/\\/g, "/");
  return unix.startsWith("/") ? `file://${unix}` : `file:///${unix}`;
}

export async function convertDocxToPdf(docxBuffer) {
  const soffice = await findLibreOffice();
  if (!soffice) {
    throw new Error(
      "LibreOffice is not installed. Install it on the server so Word letters convert to PDF with original fonts (sudo apt-get install -y libreoffice-writer)."
    );
  }

  const dir = await fs.mkdtemp(join(tmpdir(), "fipo-docx-"));
  const profileDir = await fs.mkdtemp(join(tmpdir(), "fipo-lo-"));
  const kind = detectOfficeBuffer(docxBuffer);
  const input = join(dir, kind === "doc" ? "letter.doc" : "letter.docx");
  const output = join(dir, "letter.pdf");
  try {
    await fs.writeFile(input, docxBuffer);
    try {
      await execFileAsync(
        soffice,
        [
          "--headless",
          "--norestore",
          "--nolockcheck",
          "--nologo",
          "--nofirststartwizard",
          `-env:UserInstallation=${profileUri(profileDir)}`,
          "--convert-to",
          "pdf:writer_pdf_Export",
          "--outdir",
          dir,
          input,
        ],
        {
          timeout: 120000,
          windowsHide: true,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            HOME: dir,
            SAL_USE_VCLPLUGIN: "svp",
          },
        }
      );
    } catch (err) {
      const files = await fs.readdir(dir).catch(() => []);
      const detail = String(err.stderr || err.stdout || err.message || err).trim();
      throw new Error(`LibreOffice convert failed (${detail || "no output"}); files: ${files.join(", ") || "none"}`);
    }

    try {
      return await fs.readFile(output);
    } catch {
      const files = await fs.readdir(dir);
      const pdf = files.find((name) => name.toLowerCase().endsWith(".pdf"));
      if (!pdf) {
        throw new Error(`LibreOffice produced no PDF (files: ${files.join(", ") || "none"})`);
      }
      return await fs.readFile(join(dir, pdf));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(profileDir, { recursive: true, force: true });
  }
}

export function isWordDocument(name = "", extension = "") {
  const haystack = `${name}.${extension}`.toLowerCase();
  return haystack.includes(".doc");
}
