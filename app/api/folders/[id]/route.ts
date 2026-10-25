import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { isUuid, normalizeOptionalUuid, uniqueDisplayName, validateDisplayName } from "@/lib/file-utils";
import type { Folder } from "@/lib/types";

export const runtime = "nodejs";

type FolderRow = RowDataPacket & Folder;
type Params = { params: Promise<{ id: string }> };
const FOLDER_SELECT = "id, parent_id, name, created_at, updated_at, is_pinned, pin_order";

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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return jsonError("폴더 정보가 올바르지 않습니다.");
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  let nextName: string | undefined;
  let nextParentId: string | null | undefined;
  let nextPinned: boolean | undefined;
  let nextPinOrder: number | undefined;
  if ("isPinned" in payload) {
    if (typeof payload.isPinned !== "boolean") return jsonError("고정 상태가 올바르지 않습니다.");
    nextPinned = payload.isPinned;
  }
  if ("pinOrder" in payload) {
    const order = Number(payload.pinOrder);
    if (!Number.isInteger(order) || order < 0) return jsonError("고정 순서가 올바르지 않습니다.");
    nextPinOrder = order;
  }
  if ("name" in payload) {
    try {
      nextName = validateDisplayName(payload.name, { label: "폴더 이름", maxLength: 80 });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "폴더 이름이 올바르지 않습니다.");
    }
  }
  if ("parentId" in payload) {
    try {
      nextParentId = normalizeOptionalUuid(payload.parentId);
    } catch {
      return jsonError("상위 폴더가 올바르지 않습니다.");
    }
    if (nextParentId) {
      const [parent] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [nextParentId, context.user.id]
      );
      if (!parent) return jsonError("상위 폴더를 찾을 수 없습니다.", 404);
      const [cycle] = await query<RowDataPacket & { id: string }>(
        `WITH RECURSIVE descendants (id) AS (
          SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ?
          UNION ALL SELECT child.id FROM cloud_folders child JOIN descendants tree ON child.parent_id = tree.id
          WHERE child.owner_id = ? AND child.deleted_at IS NULL
        ) SELECT id FROM descendants WHERE id = ? LIMIT 1`,
        [id, context.user.id, context.user.id, nextParentId]
      );
      if (cycle) return jsonError("폴더를 자기 자신의 하위로 이동할 수 없습니다.");
    }
  }
  if (nextName === undefined && nextParentId === undefined && nextPinned === undefined && nextPinOrder === undefined) return jsonError("변경할 내용이 없습니다.");

  try {
    const [current] = await query<FolderRow>(
      `SELECT ${FOLDER_SELECT} FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, context.user.id]
    );
    if (!current) return jsonError("폴더를 찾을 수 없습니다.", 404);
    const destination = nextParentId === undefined ? current.parent_id : nextParentId;
    const name = nextName ?? current.name;
    if (destination !== current.parent_id || nextName !== undefined) {
      const [siblings, siblingFiles] = await Promise.all([
        query<RowDataPacket & { name: string }>(
          "SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND id <> ? AND deleted_at IS NULL",
          [context.user.id, destination, id]
        ),
        query<RowDataPacket & { name: string }>(
          "SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL",
          [context.user.id, destination]
        )
      ]);
      nextName = uniqueDisplayName(name, [...siblings, ...siblingFiles].map((row) => row.name), 80);
    }
    if (nextName !== undefined) { updates.push("name = ?"); values.push(nextName); }
    if (nextParentId !== undefined) { updates.push("parent_id = ?"); values.push(nextParentId); }
    if (nextPinned !== undefined) {
      updates.push("is_pinned = ?");
      values.push(nextPinned ? 1 : 0);
      if (nextPinned && nextPinOrder === undefined) {
        const [pinOrder] = await query<RowDataPacket & { next_order: number }>(
          "SELECT COALESCE(MAX(pin_order), 0) + 1 AS next_order FROM cloud_folders WHERE owner_id = ? AND is_pinned = 1 AND deleted_at IS NULL",
          [context.user.id]
        );
        nextPinOrder = pinOrder?.next_order ?? 1;
      }
      if (!nextPinned && nextPinOrder === undefined) nextPinOrder = 0;
    }
    if (nextPinOrder !== undefined) { updates.push("pin_order = ?"); values.push(nextPinOrder); }
    if (!updates.length) return NextResponse.json({ folder: current });
    values.push(id, context.user.id);
    const result = await execute(
      `UPDATE cloud_folders SET ${updates.join(", ")} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
      values
    );
    if (result.affectedRows === 0) {
      const [existing] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [id, context.user.id]
      );
      if (!existing) return jsonError("폴더를 찾을 수 없습니다.", 404);
    }
    const [folder] = await query<FolderRow>(
      `SELECT ${FOLDER_SELECT} FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
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
      "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
      [id, context.user.id]
    );
    if (!folder) {
      return jsonError("폴더를 찾을 수 없습니다.", 404);
    }

    await execute(
      `WITH RECURSIVE folder_tree (id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
        WHERE child.owner_id = ? AND child.deleted_at IS NULL
      )
      UPDATE cloud_files file_row JOIN folder_tree tree ON tree.id = file_row.folder_id
      SET file_row.deleted_at = CURRENT_TIMESTAMP(3)
      WHERE file_row.owner_id = ? AND file_row.deleted_at IS NULL`,
      [id, context.user.id, context.user.id, context.user.id]
    );
    await execute(
      `WITH RECURSIVE folder_tree (id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
        WHERE child.owner_id = ? AND child.deleted_at IS NULL
      )
      UPDATE cloud_folders folder_row JOIN folder_tree tree ON tree.id = folder_row.id
      SET folder_row.deleted_at = CURRENT_TIMESTAMP(3)
      WHERE folder_row.owner_id = ? AND folder_row.deleted_at IS NULL`,
      [id, context.user.id, context.user.id, context.user.id]
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "폴더를 삭제하지 못했습니다.", 500);
  }
}
