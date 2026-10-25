import { Worker } from "node:worker_threads";
import path from "node:path";

export type ArchiveEntry = { name: string; path: string; size: number; type: "file" | "folder" };
type ListedEntry = { path: string; sourcePath: string; size: number; folder: boolean };
type ArchiveWorkerResult = { ok: true; output: string } | { ok: false; error: string };

export function runArchiveWorker(workerData: { type: "list"; archivePath: string } | { type: "extract"; archivePath: string; outputPath: string; entryPath: string } | { type: "create"; sourcePath: string; outputPath: string }, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(path.join(process.cwd(), "lib", "archive-worker.cjs"), { workerData });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      void worker.terminate();
      finish(() => reject(new DOMException("압축 파일 작업이 취소되었습니다.", "AbortError")));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: ArchiveWorkerResult) => {
      if (result.ok) finish(() => resolve(result.output));
      else finish(() => reject(new Error(result.error)));
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled) finish(() => reject(new Error(code === 0 ? "압축 파일 작업이 중단되었습니다." : "압축 파일을 읽지 못했습니다.")));
    });
  });
}

export function normalizeArchivePath(value: string) {
  let normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) return null;
  return parts.join("/");
}

export async function listArchiveEntries(filePath: string, signal?: AbortSignal): Promise<ListedEntry[]> {
  const stdout = await runArchiveWorker({ type: "list", archivePath: filePath }, signal);
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
