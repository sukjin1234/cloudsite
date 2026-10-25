import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { listArchiveEntries, normalizeArchivePath, runArchiveWorker } from "@/lib/archive-utils";
import { query } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { getFileExtension, isUuid } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
type FileRow = RowDataPacket & CloudFile;

const CONTENT_TYPES: Record<string, string> = {
  aac: "audio/aac", csv: "text/csv; charset=utf-8", css: "text/css; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  flac: "audio/flac", gif: "image/gif", html: "text/html; charset=utf-8", jpeg: "image/jpeg", jpg: "image/jpeg", js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", m4a: "audio/mp4", md: "text/markdown; charset=utf-8", mkv: "video/x-matroska", mov: "video/quicktime",
  mp3: "audio/mpeg", mp4: "video/mp4", ogg: "audio/ogg", pdf: "application/pdf", png: "image/png", svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8", wav: "audio/wav", webm: "video/webm", webp: "image/webp", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml; charset=utf-8", yml: "text/yaml; charset=utf-8", yaml: "text/yaml; charset=utf-8"
};

export async function GET(request: Request, { params }: Params) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("파일 ID가 올바르지 않습니다.");
  const entryPath = new URL(request.url).searchParams.get("path") ?? "";
  const safePath = normalizeArchivePath(entryPath);
  if (!safePath) return jsonError("압축 파일 경로가 올바르지 않습니다.");
  try {
    const [file] = await query<FileRow>("SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at FROM cloud_files WHERE id = ? AND owner_id = ? LIMIT 1", [id, context.user.id]);
    if (!file || !["zip", "7z", "tar"].includes(getFileExtension(file.name))) return jsonError("압축 파일을 찾을 수 없습니다.", 404);
    const archivePath = getStoredFilePath(context.user.id, id);
    const entry = (await listArchiveEntries(archivePath, request.signal)).find((item) => item.path === safePath && !item.folder);
    if (!entry) return jsonError("압축 파일 내부 파일을 찾을 수 없습니다.", 404);
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "cloud-preview-"));
    try {
      await runArchiveWorker({ type: "extract", archivePath, outputPath: outputDirectory, entryPath: entry.sourcePath }, request.signal);
      const extractedPath = path.join(outputDirectory, ...entry.path.split("/"));
      const details = await stat(extractedPath);
      if (!details.isFile()) throw new Error("압축 파일 내부 파일을 찾지 못했습니다.");
      const rangeHeader = request.headers.get("range");
      let start = 0;
      let end = details.size - 1;
      let status = 200;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match || (!match[1] && !match[2]) || details.size === 0) {
          await rm(outputDirectory, { force: true, recursive: true });
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${details.size}`, "Accept-Ranges": "bytes" } });
        }
        if (!match[1]) start = Math.max(0, details.size - Number(match[2]));
        else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), details.size - 1) : details.size - 1; }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= details.size) {
          await rm(outputDirectory, { force: true, recursive: true });
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${details.size}`, "Accept-Ranges": "bytes" } });
        }
        status = 206;
      }
      const output = createReadStream(extractedPath, status === 206 ? { start, end } : undefined);
      output.once("close", () => { void rm(outputDirectory, { force: true, recursive: true }); });
      const mime = CONTENT_TYPES[getFileExtension(safePath)] ?? "application/octet-stream";
      const headers = new Headers({ "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "Content-Length": String(end - start + 1), "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Type": mime, "X-Content-Type-Options": "nosniff" });
      if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${details.size}`);
      return new Response(Readable.toWeb(output) as ReadableStream, { headers, status });
    } catch (error) {
      await rm(outputDirectory, { force: true, recursive: true });
      throw error;
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "압축 파일 내부 미리보기를 열지 못했습니다.", 422);
  }
}
