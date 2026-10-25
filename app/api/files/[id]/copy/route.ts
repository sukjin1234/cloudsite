import { copyFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { getStoredFilePath, getUploadRoot } from "@/lib/file-storage";
import { isUuid, normalizeOptionalUuid, uniqueDisplayName } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
type FileRow = RowDataPacket & CloudFile;

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  if (!isUuid(id)) return jsonError("파일 ID가 올바르지 않습니다.");
  const payload = await request.json().catch(() => null);
  let folderId: string | null;
  try { folderId = normalizeOptionalUuid(payload?.folderId); }
  catch { return jsonError("대상 폴더가 올바르지 않습니다."); }
  try {
    const [source] = await query<FileRow>(
      "SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at, tags FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
      [id, context.user.id]
    );
    if (!source) return jsonError("파일을 찾을 수 없습니다.", 404);
    if (folderId) {
      const [folder] = await query<RowDataPacket & { id: string }>("SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL", [folderId, context.user.id]);
      if (!folder) return jsonError("대상 폴더를 찾을 수 없습니다.", 404);
    }
    const [usage] = await query<RowDataPacket & { used_bytes: number; quota_bytes: number }>(
      "SELECT COALESCE(SUM(f.size_bytes), 0) AS used_bytes, u.storage_quota_bytes AS quota_bytes FROM cloud_users u LEFT JOIN cloud_files f ON f.owner_id = u.id WHERE u.id = ? GROUP BY u.id",
      [context.user.id]
    );
    if (usage && Number(usage.used_bytes) + Number(source.size_bytes) > Number(usage.quota_bytes)) return jsonError("저장 공간이 부족합니다.", 413);
    const [names, folderNames] = await Promise.all([
      query<RowDataPacket & { name: string }>(
        "SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL",
        [context.user.id, folderId]
      ),
      query<RowDataPacket & { name: string }>(
        "SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL",
        [context.user.id, folderId]
      )
    ]);
    const name = uniqueDisplayName(source.name, [...names, ...folderNames].map((row) => row.name), 180);
    const copyId = randomUUID();
    const destination = getStoredFilePath(context.user.id, copyId);
    await mkdir(join(getUploadRoot(), context.user.id), { recursive: true });
    await copyFile(getStoredFilePath(context.user.id, source.id), destination);
    try {
      await execute(
        "INSERT INTO cloud_files (id, owner_id, folder_id, name, mime_type, size_bytes, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [copyId, context.user.id, folderId, name, source.mime_type, source.size_bytes, JSON.stringify(source.tags ?? [])]
      );
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    const [file] = await query<FileRow>(
      "SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at, tags FROM cloud_files WHERE id = ? AND owner_id = ?",
      [copyId, context.user.id]
    );
    return NextResponse.json({ file }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일을 복사하지 못했습니다.", 500);
  }
}
