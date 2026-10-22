import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { isUuid, validateDisplayName } from "@/lib/file-utils";
import type { Folder } from "@/lib/types";

export const runtime = "nodejs";

type FolderRow = RowDataPacket & Folder;
type Params = { params: Promise<{ id: string }> };
const FOLDER_SELECT = "id, parent_id, name, created_at, updated_at";

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
    return jsonError("폴더 ID가 올바르지 않습니다.");
  }

  const payload = await request.json().catch(() => null);
  let name: string;
  try {
    name = validateDisplayName(payload?.name, { label: "폴더 이름", maxLength: 80 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "폴더 정보가 올바르지 않습니다.");
  }

  try {
    const result = await execute(
      "UPDATE cloud_folders SET name = ? WHERE id = ? AND owner_id = ?",
      [name, id, context.user.id]
    );
    if (result.affectedRows === 0) {
      const [existing] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? LIMIT 1",
        [id, context.user.id]
      );
      if (!existing) {
        return jsonError("폴더를 찾을 수 없습니다.", 404);
      }
    }
    const [folder] = await query<FolderRow>(
      `SELECT ${FOLDER_SELECT} FROM cloud_folders WHERE id = ? AND owner_id = ? LIMIT 1`,
      [id, context.user.id]
    );
    return NextResponse.json({ folder });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      return jsonError("같은 이름의 폴더가 이미 있습니다.", 409);
    }
    return jsonError(error instanceof Error ? error.message : "폴더 이름을 바꾸지 못했습니다.", 500);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  if (!isUuid(id)) {
    return jsonError("폴더 ID가 올바르지 않습니다.");
  }

  try {
    const [folder] = await query<RowDataPacket & { id: string }>(
      "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? LIMIT 1",
      [id, context.user.id]
    );
    if (!folder) {
      return jsonError("폴더를 찾을 수 없습니다.", 404);
    }

    const [childFolder] = await query<RowDataPacket & { id: string }>(
      "SELECT id FROM cloud_folders WHERE parent_id = ? AND owner_id = ? LIMIT 1",
      [id, context.user.id]
    );
    const [childFile] = await query<RowDataPacket & { id: string }>(
      "SELECT id FROM cloud_files WHERE folder_id = ? AND owner_id = ? LIMIT 1",
      [id, context.user.id]
    );
    if (childFolder || childFile) {
      return jsonError("비어 있는 폴더만 삭제할 수 있습니다.", 409);
    }

    await execute("DELETE FROM cloud_folders WHERE id = ? AND owner_id = ?", [id, context.user.id]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "폴더를 삭제하지 못했습니다.", 500);
  }
}
