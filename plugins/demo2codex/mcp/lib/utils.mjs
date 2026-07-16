import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

export async function atomicWriteFile(filePath, contents, options = {}) {
  await ensureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, contents, options);
  await rename(temporaryPath, filePath);

  if (options.mode !== undefined) {
    await chmod(filePath, options.mode).catch(() => {});
  }
}

export function isoTimestamp(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

export function makeId(prefix, randomBytes) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}_${stamp}_${randomBytes.toString("hex")}`;
}

export function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function safeRelative(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside repository: ${targetPath}`);
  }
  return relative.split(path.sep).join("/");
}

export function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

export function escapeMarkdown(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+.!|>-])/g, "\\$1")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function sanitizeFileExtension(contentType = "") {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  const known = new Map([
    ["audio/webm", ".webm"],
    ["audio/ogg", ".ogg"],
    ["audio/mp4", ".m4a"],
    ["audio/mpeg", ".mp3"],
    ["audio/wav", ".wav"],
    ["audio/x-wav", ".wav"],
    ["application/octet-stream", ".bin"],
  ]);
  return known.get(normalized) ?? ".bin";
}

export function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
