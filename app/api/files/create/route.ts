import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { getStoredFilePath, getUploadRoot } from "@/lib/file-storage";
import { ensureTextFileExtension, normalizeOptionalUuid, uniqueDisplayName, validateWindowsDisplayName } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

type FileRow = RowDataPacket & CloudFile;
const FILE_SELECT = "id, folder_id, name, mime_type, size_bytes, created_at, updated_at";

function isDuplicateEntry(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

export async function POST(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  const payload = await request.json().catch(() => null);
  let name: string;
  let folderId: string | null;
  try {
    name = ensureTextFileExtension(validateWindowsDisplayName(payload?.name, { label: "파일 이름", maxLength: 180 }));
    if (name.length > 180) throw new Error("파일 이름이 너무 깁니다.");
    folderId = normalizeOptionalUuid(payload?.parentId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일 정보가 올바르지 않습니다.");
  }

  try {
    if (folderId) {
      const [folder] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [folderId, context.user.id]
      );
      if (!folder) {
        return jsonError("상위 폴더를 찾을 수 없습니다.", 404);
      }
    }

    const [files, folders] = await Promise.all([
      query<RowDataPacket & { name: string }>(
        "SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL",
        [context.user.id, folderId]
      ),
      query<RowDataPacket & { name: string }>(
        "SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL",
        [context.user.id, folderId]
      )
    ]);
    name = uniqueDisplayName(name, [...files, ...folders].map((row) => row.name), 180);

    const id = randomUUID();
    const filePath = getStoredFilePath(context.user.id, id);
    const ownerDirectory = join(getUploadRoot(), context.user.id);
    let fileCreated = false;
    let recordSaved = false;
    try {
      await mkdir(ownerDirectory, { recursive: true });
      await writeFile(filePath, Buffer.alloc(0), { flag: "wx" });
      fileCreated = true;
      await execute(
        "INSERT INTO cloud_files (id, owner_id, folder_id, name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, 0)",
        [id, context.user.id, folderId, name, "text/plain; charset=utf-8"]
      );
      recordSaved = true;
      const [file] = await query<FileRow>(
        `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? LIMIT 1`,
        [id, context.user.id]
      );
      if (!file) {
        throw new Error("만든 파일 정보를 찾을 수 없습니다.");
      }
      return NextResponse.json({ file }, { status: 201 });
    } catch (error) {
      if (recordSaved) {
        try {
          await execute("DELETE FROM cloud_files WHERE id = ? AND owner_id = ?", [id, context.user.id]);
        } catch {
          return jsonError("파일 저장 상태를 확인하지 못했습니다.", 500);
        }
      }
      if (fileCreated) {
        await unlink(filePath).catch(() => undefined);
      }
      if (isDuplicateEntry(error)) {
        return jsonError("같은 폴더에 같은 이름의 파일이 이미 있습니다.", 409);
      }
      throw error;
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일을 만들지 못했습니다.", 500);
  }
}
