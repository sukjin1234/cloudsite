import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { path7za } from "7zip-bin";

const run7za = promisify(execFile);

export type ArchiveEntry = { name: string; path: string; size: number; type: "file" | "folder" };
type ListedEntry = { path: string; sourcePath: string; size: number; folder: boolean };

export function normalizeArchivePath(value: string) {
  let normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) return null;
  return parts.join("/");
}

export async function listArchiveEntries(filePath: string): Promise<ListedEntry[]> {
  const { stdout } = await run7za(path7za, ["l", "-slt", filePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60000
  });
  const result: ListedEntry[] = [];
  let inEntries = false;
  let values = new Map<string, string>();
  const addEntry = () => {
    const rawPath = values.get("Path");
    if (!rawPath) return;
    const path = normalizeArchivePath(rawPath);
    if (!path) return;
    result.push({ path, sourcePath: rawPath, folder: values.get("Folder") === "+" || rawPath.endsWith("/") || rawPath.endsWith("\\"), size: Number(values.get("Size") ?? 0) || 0 });
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "----------") {
      if (values.size) addEntry();
      values = new Map<string, string>();
      inEntries = true;
      continue;
    }
    if (!inEntries) continue;
    if (!line.trim()) { addEntry(); values = new Map<string, string>(); continue; }
    const separator = line.indexOf(" = ");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 3));
  }
  addEntry();
  return result;
}

export function listArchiveChildren(entries: ListedEntry[], currentPath: string): ArchiveEntry[] {
  const prefix = currentPath ? currentPath + "/" : "";
  const children = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || entry.path === currentPath) continue;
    const relative = entry.path.slice(prefix.length);
    const slash = relative.indexOf("/");
    const name = slash < 0 ? relative : relative.slice(0, slash);
    if (!name) continue;
    const path = prefix + name;
    const type = slash >= 0 || entry.folder ? "folder" : "file";
    const existing = children.get(path);
    children.set(path, { name, path, size: type === "folder" ? 0 : entry.size, type: existing?.type === "folder" ? "folder" : type });
  }
  return [...children.values()].sort((a, b) => Number(b.type === "folder") - Number(a.type === "folder") || a.name.localeCompare(b.name, "ko-KR", { numeric: true, sensitivity: "base" }));
}
