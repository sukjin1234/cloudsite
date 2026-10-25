import { copyFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { getStoredFilePath, getUploadRoot } from "@/lib/file-storage";
import { isUuid, normalizeOptionalUuid, uniqueDisplayName } from "@/lib/file-utils";
import type { CloudFile, Folder } from "@/lib/types";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
type TreeFolder = RowDataPacket & Folder & { depth: number };
type TreeFile = RowDataPacket & CloudFile;

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  if (!isUuid(id)) return jsonError("폴더 ID가 올바르지 않습니다.");

  const payload = await request.json().catch(() => null);
  let destinationId: string | null;
  try { destinationId = normalizeOptionalUuid(payload?.folderId); }
  catch { return jsonError("대상 폴더가 올바르지 않습니다."); }

  const copiedFolderIds: string[] = [];
  const copiedFileIds: string[] = [];
  const copiedPaths: string[] = [];
  try {
    const [source] = await query<RowDataPacket & { id: string }>(
      "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
      [id, context.user.id]
    );
    if (!source) return jsonError("폴더를 찾을 수 없습니다.", 404);
    if (destinationId) {
      const [destination] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [destinationId, context.user.id]
      );
      if (!destination) return jsonError("대상 폴더를 찾을 수 없습니다.", 404);
    }

    const folders = await query<TreeFolder>(
      `WITH RECURSIVE folder_tree (id, parent_id, name, tags, depth) AS (
        SELECT id, parent_id, name, tags, 0 FROM cloud_folders
        WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, child.tags, parent.depth + 1
        FROM cloud_folders child JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.owner_id = ? AND child.deleted_at IS NULL
      ) SELECT id, parent_id, name, tags, depth FROM folder_tree ORDER BY depth, name`,
      [id, context.user.id, context.user.id]
    );
    const files = await query<TreeFile>(
      `WITH RECURSIVE folder_tree (id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT child.id FROM cloud_folders child JOIN folder_tree parent ON child.parent_id = parent.id
        WHERE child.owner_id = ? AND child.deleted_at IS NULL
      ) SELECT file_row.id, file_row.folder_id, file_row.name, file_row.mime_type, file_row.size_bytes, file_row.tags
        FROM cloud_files file_row JOIN folder_tree tree ON tree.id = file_row.folder_id
        WHERE file_row.owner_id = ? AND file_row.deleted_at IS NULL ORDER BY file_row.name`,
      [id, context.user.id, context.user.id, context.user.id]
    );
    if (!folders.length) return jsonError("폴더를 찾을 수 없습니다.", 404);
    const incomingBytes = files.reduce((sum, file) => sum + Number(file.size_bytes), 0);
    const [usage] = await query<RowDataPacket & { used_bytes: number; quota_bytes: number }>(
      "SELECT COALESCE(SUM(f.size_bytes), 0) AS used_bytes, u.storage_quota_bytes AS quota_bytes FROM cloud_users u LEFT JOIN cloud_files f ON f.owner_id = u.id WHERE u.id = ? GROUP BY u.id",
      [context.user.id]
    );
    if (usage && Number(usage.used_bytes) + incomingBytes > Number(usage.quota_bytes)) return jsonError("저장 공간이 부족합니다.", 413);

    const folderMap = new Map<string, string>();
    const namesByParent = new Map<string, string[]>();
    for (const folder of folders) {
      const parentId = folder.id === id ? destinationId : folderMap.get(folder.parent_id ?? "") ?? null;
      const parentKey = parentId ?? "root";
      let existingNames = namesByParent.get(parentKey);
      if (!existingNames) {
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
        existingNames = [...siblings, ...siblingFiles].map((row) => row.name);
        namesByParent.set(parentKey, existingNames);
      }
      const name = uniqueDisplayName(folder.name, existingNames, 80);
      existingNames.push(name);
      const copyId = randomUUID();
      folderMap.set(folder.id, copyId);
      await execute(
        "INSERT INTO cloud_folders (id, owner_id, parent_id, name, tags, is_pinned, pin_order) VALUES (?, ?, ?, ?, ?, 0, 0)",
        [copyId, context.user.id, parentId, name, typeof folder.tags === "string" ? folder.tags : JSON.stringify(folder.tags ?? [])]
      );
      copiedFolderIds.push(copyId);
    }

    await mkdir(join(getUploadRoot(), context.user.id), { recursive: true });
    const fileNamesByParent = new Map<string, string[]>();
    for (const file of files) {
      const parentId = file.folder_id ? folderMap.get(file.folder_id) : destinationId;
      if (!parentId) throw new Error("폴더 경로를 복사하지 못했습니다.");
      let existingNames = fileNamesByParent.get(parentId);
      if (!existingNames) {
        const [siblings, siblingFolders] = await Promise.all([
          query<RowDataPacket & { name: string }>(
            "SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL",
            [context.user.id, parentId]
          ),
          query<RowDataPacket & { name: string }>(
            "SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL",
            [context.user.id, parentId]
          )
        ]);
        existingNames = [...siblings, ...siblingFolders].map((row) => row.name);
        fileNamesByParent.set(parentId, existingNames);
      }
      const name = uniqueDisplayName(file.name, existingNames, 180);
      existingNames.push(name);
      const copyId = randomUUID();
      const path = getStoredFilePath(context.user.id, copyId);
      await copyFile(getStoredFilePath(context.user.id, file.id), path);
      copiedPaths.push(path);
      await execute(
        "INSERT INTO cloud_files (id, owner_id, folder_id, name, mime_type, size_bytes, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [copyId, context.user.id, parentId, name, file.mime_type, file.size_bytes, typeof file.tags === "string" ? file.tags : JSON.stringify(file.tags ?? [])]
      );
      copiedFileIds.push(copyId);
    }

    return NextResponse.json({ ok: true, folderId: folderMap.get(id) }, { status: 201 });
  } catch (error) {
    if (copiedFileIds.length) await execute("DELETE FROM cloud_files WHERE owner_id = ? AND id IN (" + copiedFileIds.map(() => "?").join(",") + ")", [context.user.id, ...copiedFileIds]).catch(() => undefined);
    for (const folderId of [...copiedFolderIds].reverse()) {
      await execute("DELETE FROM cloud_folders WHERE id = ? AND owner_id = ?", [folderId, context.user.id]).catch(() => undefined);
    }
    await Promise.all(copiedPaths.map((path) => unlink(path).catch(() => undefined)));
    return jsonError(error instanceof Error ? error.message : "폴더를 복사하지 못했습니다.", 500);
  }
}
