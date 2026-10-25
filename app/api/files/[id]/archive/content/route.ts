import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { path7za } from "7zip-bin";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { listArchiveEntries, normalizeArchivePath } from "@/lib/archive-utils";
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
    const [file] = await query<FileRow>("SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1", [id, context.user.id]);
    if (!file || !["zip", "7z", "tar"].includes(getFileExtension(file.name))) return jsonError("압축 파일을 찾을 수 없습니다.", 404);
    const archivePath = getStoredFilePath(context.user.id, id);
    const entry = (await listArchiveEntries(archivePath)).find((item) => item.path === safePath && !item.folder);
    if (!entry) return jsonError("압축 파일 내부 파일을 찾을 수 없습니다.", 404);
    const extractor = spawn(path7za, ["x", "-so", "-spd", archivePath, entry.sourcePath], {
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true
    });
    const closed = once(extractor, "close");
    const output = Readable.from((async function* () {
      for await (const chunk of extractor.stdout) yield chunk;
      const [code] = await closed as [number | null, NodeJS.Signals | null];
      if (code !== 0) throw new Error("압축 파일에서 내용을 읽지 못했습니다.");
    })());
    output.on("close", () => {
      if (!output.readableEnded && extractor.exitCode === null) extractor.kill();
    });
    const mime = CONTENT_TYPES[getFileExtension(safePath)] ?? "application/octet-stream";
    return new Response(Readable.toWeb(output) as ReadableStream, { headers: { "Cache-Control": "private, no-store", "Content-Length": String(entry.size), "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Type": mime, "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "압축 파일 내부 미리보기를 열지 못했습니다.", 500);
  }
}
