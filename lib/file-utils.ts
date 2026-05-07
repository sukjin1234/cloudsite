import type { PreviewKind } from "@/lib/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TEXT_EXTENSIONS = new Set([
  "csv",
  "css",
  "html",
  "js",
  "json",
  "log",
  "md",
  "markdown",
  "rtf",
  "ts",
  "txt",
  "xml",
  "yaml",
  "yml"
]);

const OFFICE_EXTENSIONS = new Set([
  "doc",
  "ppt",
  "pptx",
  "xls"
]);

const DOCUMENT_EXTENSIONS = new Set([
  "docx",
  "docm",
  "dotx",
  "dotm"
]);

const SPREADSHEET_EXTENSIONS = new Set([
  "xlsx",
  "xlsm",
  "xltx",
  "xltm"
]);

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function normalizeOptionalUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "root" || trimmed === "null") {
    return null;
  }

  if (!isUuid(trimmed)) {
    throw new Error("Invalid UUID");
  }

  return trimmed;
}

export function validateDisplayName(
  value: unknown,
  options: { maxLength: number; label: string }
): string {
  if (typeof value !== "string") {
    throw new Error(`${options.label} is required`);
  }

  const name = value.trim();
  if (!name) {
    throw new Error(`${options.label} is required`);
  }

  if (name.length > options.maxLength) {
    throw new Error(`${options.label} is too long`);
  }

  if (/[\\/\0]/.test(name)) {
    throw new Error(`${options.label} cannot contain slashes`);
  }

  return name;
}

export function sanitizeStorageName(fileName: string): string {
  const fallback = "upload";
  const sanitized = fileName
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "-")
    .replace(/[\u0001-\u001f\u007f]/g, "")
    .trim();

  return sanitized.slice(0, 180) || fallback;
}

export function sanitizeStorageKeyName(fileName: string, fallbackBase: string): string {
  const extension = getFileExtension(fileName).replace(/[^a-z0-9]/g, "").slice(0, 16);
  const nameWithoutExtension = fileName.replace(/\.[^.]*$/, "");
  const asciiBase = nameWithoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "-")
    .replace(/[\s.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
  const base = asciiBase || fallbackBase;

  return extension ? `${base}.${extension}` : base;
}

export function getFileExtension(fileName: string): string {
  const name = fileName.toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

export function getPreviewKind(mimeType: string, fileName: string): PreviewKind {
  const mime = mimeType.toLowerCase();
  const extension = getFileExtension(fileName);

  if (mime.startsWith("image/")) {
    return "image";
  }

  if (mime === "application/pdf" || extension === "pdf") {
    return "pdf";
  }

  if (
    DOCUMENT_EXTENSIONS.has(extension) ||
    mime.includes("wordprocessingml")
  ) {
    return "document";
  }

  if (
    SPREADSHEET_EXTENSIONS.has(extension) ||
    mime.includes("spreadsheetml")
  ) {
    return "spreadsheet";
  }

  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return "text";
  }

  if (mime.startsWith("audio/")) {
    return "audio";
  }

  if (mime.startsWith("video/")) {
    return "video";
  }

  if (
    OFFICE_EXTENSIONS.has(extension) ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("ms-excel") ||
    mime.includes("ms-powerpoint")
  ) {
    return "office";
  }

  return "unsupported";
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
