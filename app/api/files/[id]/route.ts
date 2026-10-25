import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import type { ExecuteValues } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { isUuid, normalizeOptionalUuid, uniqueDisplayName, validateDisplayName } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

type FileRow = RowDataPacket & CloudFile;
type Params = { params: Promise<{ id: string }> };
const FILE_SELECT =
  "id, folder_id, name, mime_type, size_bytes, created_at, updated_at, tags, deleted_at";

function isDuplicateEntry(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  if (!isUuid(id)) {
    return jsonError("파일 ID가 올바르지 않습니다.");
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError("파일 정보가 올바르지 않습니다.");
  }

  const updates: string[] = [];
  const values: ExecuteValues[] = [];
  let requestedName: string | undefined;
  if ("name" in payload) {
    try {
      requestedName = validateDisplayName(payload.name, { label: "파일 이름", maxLength: 180 });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "파일 이름이 올바르지 않습니다.");
    }
  }
  try {
    const [current] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, context.user.id]
    );
    if (!current) return jsonError("파일을 찾을 수 없습니다.", 404);
    let folderId = current.folder_id;
    if ("folderId" in payload) {
    try {
      folderId = normalizeOptionalUuid(payload.folderId);
    } catch {
      return jsonError("폴더가 올바르지 않습니다.");
    }
    if (folderId) {
      try {
        const [folder] = await query<RowDataPacket & { id: string }>(
          "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
          [folderId, context.user.id]
        );
        if (!folder) {
          return jsonError("폴더를 찾을 수 없습니다.", 404);
        }
      } catch {
        return jsonError("폴더를 확인하지 못했습니다.", 500);
      }
    }
      updates.push("folder_id = ?");
      values.push(folderId);
    }
    let name = requestedName ?? current.name;
    if (requestedName !== undefined || folderId !== current.folder_id) {
      const [siblings, siblingFolders] = await Promise.all([
        query<RowDataPacket & { name: string }>(
          "SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND id <> ? AND deleted_at IS NULL",
          [context.user.id, folderId, id]
        ),
        query<RowDataPacket & { name: string }>(
          "SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL",
          [context.user.id, folderId]
        )
      ]);
      name = uniqueDisplayName(name, [...siblings, ...siblingFolders].map((row) => row.name), 180);
    }
    if (requestedName !== undefined) {
      updates.push("name = ?");
      values.push(name);
    }
    if (!updates.length) return NextResponse.json({ file: current });

    values.push(id, context.user.id);
    await execute(
      `UPDATE cloud_files SET ${updates.join(", ")} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
      values
    );
    const [file] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, context.user.id]
    );
    if (!file) {
      return jsonError("파일을 찾을 수 없습니다.", 404);
    }
    return NextResponse.json({ file });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      return jsonError("같은 폴더에 같은 이름의 파일이 이미 있습니다.", 409);
    }
    return jsonError(error instanceof Error ? error.message : "파일을 수정하지 못했습니다.", 500);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  if (!isUuid(id)) {
    return jsonError("파일 ID가 올바르지 않습니다.");
  }

  try {
    const [file] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, context.user.id]
    );
    if (!file) {
      return jsonError("파일을 찾을 수 없습니다.", 404);
    }

    await execute(
      "UPDATE cloud_files SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
      [id, context.user.id]
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일을 삭제하지 못했습니다.", 500);
  }
}
