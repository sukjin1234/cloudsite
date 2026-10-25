import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { listArchiveChildren, listArchiveEntries, normalizeArchivePath } from "@/lib/archive-utils";
import { query } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { getFileExtension, isUuid } from "@/lib/file-utils";
import { listZipEntries } from "@/lib/zip-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
type FileRow = RowDataPacket & CloudFile;

export async function GET(request: Request, { params }: Params) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("파일 ID가 올바르지 않습니다.");
  try {
    const [file] = await query<FileRow>("SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at FROM cloud_files WHERE id = ? AND owner_id = ? LIMIT 1", [id, context.user.id]);
    if (!file || !["zip", "7z", "tar"].includes(getFileExtension(file.name))) return jsonError("압축 파일을 찾을 수 없습니다.", 404);
    const rawPath = new URL(request.url).searchParams.get("path") ?? "";
    const currentPath = rawPath ? normalizeArchivePath(rawPath) : "";
    if (currentPath === null) return jsonError("압축 파일 경로가 올바르지 않습니다.");
    const archivePath = getStoredFilePath(context.user.id, id);
    const entries = getFileExtension(file.name) === "zip"
      ? await listZipEntries(archivePath, request.signal)
      : await listArchiveEntries(archivePath, request.signal);
    if (currentPath && !entries.some((entry) => entry.path === currentPath || entry.path.startsWith(currentPath + "/"))) return jsonError("압축 파일 내부 경로를 찾을 수 없습니다.", 404);
    return NextResponse.json({ file, path: currentPath, entries: listArchiveChildren(entries, currentPath) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "압축 파일을 열지 못했습니다.", 500);
  }
}
