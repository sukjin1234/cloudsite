import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { normalizeArchivePath } from "@/lib/archive-utils";

export type ZipListedEntry = { path: string; sourcePath: string; size: number; folder: boolean };

function openZip(filePath: string) {
  return yauzl.openPromise(filePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false });
}

export async function listZipEntries(filePath: string, signal?: AbortSignal): Promise<ZipListedEntry[]> {
  const zip = await openZip(filePath);
  return new Promise((resolve, reject) => {
    const entries: ZipListedEntry[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      zip.close();
      if (error) reject(error);
      else resolve(entries);
    };
    const abort = () => finish(new DOMException("ZIP 파일 작업이 취소되었습니다.", "AbortError"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    zip.on("error", (error) => finish(error));
    zip.on("entry", (entry) => {
      const normalized = normalizeArchivePath(entry.fileName);
      if (normalized) entries.push({ path: normalized, sourcePath: entry.fileName, size: entry.uncompressedSize, folder: entry.fileName.endsWith("/") || entry.fileName.endsWith("\\") });
      zip.readEntry();
    });
    zip.once("end", () => finish());
    zip.readEntry();
  });
}

export async function extractZipEntry(filePath: string, entryPath: string, outputDirectory: string, signal?: AbortSignal): Promise<{ path: string }> {
  const zip = await openZip(filePath);
  return new Promise<{ path: string }>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { path: string }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      zip.close();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("ZIP 파일 내부 항목을 찾을 수 없습니다."));
    };
    const abort = () => finish(new DOMException("ZIP 파일 작업이 취소되었습니다.", "AbortError"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    zip.on("error", (error) => finish(error));
    zip.on("entry", (entry) => {
      if (normalizeArchivePath(entry.fileName) !== entryPath || entry.fileName.endsWith("/") || entry.fileName.endsWith("\\")) {
        zip.readEntry();
        return;
      }
      const destination = path.join(outputDirectory, ...entryPath.split("/"));
      void mkdir(path.dirname(destination), { recursive: true }).then(() => new Promise<void>((streamResolve, streamReject) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) { streamReject(error); return; }
          void pipeline(stream, createWriteStream(destination), { signal }).then(streamResolve, streamReject);
        });
      })).then(() => finish(undefined, { path: destination }), (error: unknown) => finish(error instanceof Error ? error : new Error("ZIP 내부 파일을 추출하지 못했습니다.")));
    });
    zip.once("end", () => finish());
    zip.readEntry();
  });
}
