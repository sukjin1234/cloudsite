import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { normalizeOptionalUuid, uniqueDisplayName, validateDisplayName } from "@/lib/file-utils";
import type { CloudFile, Folder } from "@/lib/types";

export const runtime = "nodejs";

type FolderRow = RowDataPacket & Folder;
type FileRow = RowDataPacket & CloudFile;

const FOLDER_SELECT = "id, parent_id, name, created_at, updated_at, is_pinned, pin_order";
const FILE_SELECT =
  "id, folder_id, name, mime_type, size_bytes, created_at, updated_at";

function isDuplicateEntry(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  let parentId: string | null;
  try {
    parentId = normalizeOptionalUuid(new URL(request.url).searchParams.get("parentId"));
  } catch {
    return jsonError("폴더 경로가 올바르지 않습니다.");
  }

  try {
    const [currentFolders, folders, files] = await Promise.all([
      parentId
        ? query<FolderRow>(
            `SELECT ${FOLDER_SELECT} FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
            [parentId, context.user.id]
          )
        : Promise.resolve([] as FolderRow[]),
      query<FolderRow>(
        "SELECT id, parent_id, name, created_at, updated_at, tags, is_pinned, pin_order FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL ORDER BY name",
        [context.user.id, parentId]
      ),
      query<FileRow>(
        `SELECT ${FILE_SELECT}, tags FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL ORDER BY name`,
        [context.user.id, parentId]
      )
    ]);

    if (parentId && !currentFolders[0]) {
      return jsonError("폴더를 찾을 수 없습니다.", 404);
    }
    return NextResponse.json({
      currentFolder: currentFolders[0] ?? null,
      files,
      folders
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "목록을 불러오지 못했습니다.", 500);
  }
}

export async function POST(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  const payload = await request.json().catch(() => null);
  let name: string;
  let parentId: string | null;
  try {
    name = validateDisplayName(payload?.name, { label: "폴더 이름", maxLength: 80 });
    parentId = normalizeOptionalUuid(payload?.parentId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "폴더 정보가 올바르지 않습니다.");
  }

  try {
    if (parentId) {
      const [parent] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [parentId, context.user.id]
      );
      if (!parent) {
        return jsonError("상위 폴더를 찾을 수 없습니다.", 404);
      }
    }

    const [siblings, siblingFiles] = await Promise.all([
      query<RowDataPacket & { name: string }>(
        "SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL",
        [context.user.id, parentId]
      ),
      query<RowDataPacket & { name: string }>(
        "SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL",
        [context.user.id, parentId]
      )
    ]);
    name = uniqueDisplayName(name, [...siblings, ...siblingFiles].map((row) => row.name), 80);
    const id = randomUUID();
    const isPinned = payload?.isPinned === true;
    const [pinCount] = isPinned
      ? await query<RowDataPacket & { next_order: number }>(
          "SELECT COALESCE(MAX(pin_order), 0) + 1 AS next_order FROM cloud_folders WHERE owner_id = ? AND is_pinned = 1 AND deleted_at IS NULL",
          [context.user.id]
        )
      : [null];
    await execute(
      "INSERT INTO cloud_folders (id, owner_id, parent_id, name, is_pinned, pin_order) VALUES (?, ?, ?, ?, ?, ?)",
      [id, context.user.id, parentId, name, isPinned ? 1 : 0, pinCount?.next_order ?? 0]
    );
    const [folder] = await query<FolderRow>(
      `SELECT ${FOLDER_SELECT} FROM cloud_folders WHERE id = ? AND owner_id = ? LIMIT 1`,
      [id, context.user.id]
    );
    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      return jsonError("같은 이름의 폴더가 이미 있습니다.", 409);
    }
    return jsonError(error instanceof Error ? error.message : "폴더를 만들지 못했습니다.", 500);
  }
}
