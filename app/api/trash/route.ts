import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import type { ExecuteValues, RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query, withTransaction } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { isUuid, uniqueDisplayName } from "@/lib/file-utils";

export const runtime = "nodejs";

type TrashedFile = RowDataPacket & {
  id: string; folder_id: string | null; name: string; mime_type: string;
  size_bytes: number; created_at: string; updated_at: string; deleted_at: string; tags: string[];
  original_path?: string;
};
type TrashedFolder = RowDataPacket & {
  id: string; parent_id: string | null; name: string;
  created_at: string; updated_at: string; deleted_at: string; tags: string[];
  original_path?: string;
};
type FolderDepth = RowDataPacket & { id: string; depth: number };

async function collectFolderTree(ownerId: string, roots: string[]) {
  if (!roots.length) return [] as FolderDepth[];
  return query<FolderDepth>(
    `WITH RECURSIVE folder_tree (id, depth) AS (
      SELECT id, 0 FROM cloud_folders WHERE owner_id = ? AND id IN (${roots.map(() => "?").join(",")})
      UNION ALL
      SELECT child.id, tree.depth + 1 FROM cloud_folders child
      JOIN folder_tree tree ON child.parent_id = tree.id WHERE child.owner_id = ?
    ) SELECT id, depth FROM folder_tree ORDER BY depth DESC`,
    [ownerId, ...roots, ownerId]
  );
}

async function permanentlyDelete(ownerId: string, files: TrashedFile[], folderRoots: string[]) {
  const folders = await collectFolderTree(ownerId, folderRoots);
  for (const file of files) {
    await unlink(getStoredFilePath(ownerId, file.id)).catch((error) => {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
  await withTransaction(async (connection) => {
    if (files.length) {
      await connection.execute(
        `DELETE FROM cloud_files WHERE owner_id = ? AND id IN (${files.map(() => "?").join(",")})`,
        [ownerId, ...files.map((file) => file.id)] as ExecuteValues[]
      );
    }
    for (const folder of folders) {
      await connection.execute("DELETE FROM cloud_folders WHERE id = ? AND owner_id = ?", [folder.id, ownerId]);
    }
  });
}

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  try {
    const [files, folders] = await Promise.all([
      query<TrashedFile>(
        `WITH RECURSIVE folder_paths (id, parent_id, path_text) AS (
          SELECT id, parent_id, CAST(CONCAT('내 클라우드 > ', name) AS CHAR(4000))
          FROM cloud_folders WHERE owner_id = ? AND parent_id IS NULL
          UNION ALL
          SELECT child.id, child.parent_id, CONCAT(parent_path.path_text, ' > ', child.name)
          FROM cloud_folders child JOIN folder_paths parent_path ON child.parent_id = parent_path.id
          WHERE child.owner_id = ?
        )
        SELECT file_row.id, file_row.folder_id, file_row.name, file_row.mime_type, file_row.size_bytes,
          file_row.created_at, file_row.updated_at, file_row.deleted_at, file_row.tags,
          COALESCE(parent_path.path_text, '내 클라우드') AS original_path
        FROM cloud_files file_row LEFT JOIN cloud_folders parent ON parent.id = file_row.folder_id
        LEFT JOIN folder_paths parent_path ON parent_path.id = file_row.folder_id
        WHERE file_row.owner_id = ? AND file_row.deleted_at IS NOT NULL
          AND (file_row.folder_id IS NULL OR parent.deleted_at IS NULL)
        ORDER BY file_row.deleted_at DESC`,
        [context.user.id, context.user.id, context.user.id]
      ),
      query<TrashedFolder>(
        `WITH RECURSIVE folder_paths (id, parent_id, path_text) AS (
          SELECT id, parent_id, CAST(CONCAT('내 클라우드 > ', name) AS CHAR(4000))
          FROM cloud_folders WHERE owner_id = ? AND parent_id IS NULL
          UNION ALL
          SELECT child.id, child.parent_id, CONCAT(parent_path.path_text, ' > ', child.name)
          FROM cloud_folders child JOIN folder_paths parent_path ON child.parent_id = parent_path.id
          WHERE child.owner_id = ?
        )
        SELECT folder.id, folder.parent_id, folder.name, folder.created_at, folder.updated_at,
          folder.deleted_at, folder.tags, COALESCE(parent_path.path_text, '내 클라우드') AS original_path
        FROM cloud_folders folder LEFT JOIN cloud_folders parent ON parent.id = folder.parent_id
        LEFT JOIN folder_paths parent_path ON parent_path.id = folder.parent_id
        WHERE folder.owner_id = ? AND folder.deleted_at IS NOT NULL
          AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)
        ORDER BY folder.deleted_at DESC`,
        [context.user.id, context.user.id, context.user.id]
      )
    ]);
    return NextResponse.json({ files, folders });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "휴지통을 불러오지 못했습니다.", 500);
  }
}

export async function POST(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const payload = await request.json().catch(() => null);
  const action = payload?.action;
  const type = payload?.type;
  const id = payload?.id;
  if (!( ["restore", "delete"] as unknown[]).includes(action) || !( ["file", "folder"] as unknown[]).includes(type) || typeof id !== "string" || !isUuid(id)) {
    return jsonError("휴지통 작업 정보가 올바르지 않습니다.");
  }

  try {
    if (type === "file") {
      const [file] = await query<TrashedFile>(
        "SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at, deleted_at, tags FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL LIMIT 1",
        [id, context.user.id]
      );
      if (!file) return jsonError("항목을 찾을 수 없습니다.", 404);
      if (action === "delete") {
        await permanentlyDelete(context.user.id, [file], []);
      } else {
        let folderId = file.folder_id;
        if (folderId) {
          const [parent] = await query<RowDataPacket & { id: string }>(
            "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
            [folderId, context.user.id]
          );
          if (!parent) folderId = null;
        }
        const [siblings, siblingFolders] = await Promise.all([
          query<RowDataPacket & { name: string }>("SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL", [context.user.id, folderId]),
          query<RowDataPacket & { name: string }>("SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND deleted_at IS NULL", [context.user.id, folderId])
        ]);
        const name = uniqueDisplayName(file.name, [...siblings, ...siblingFolders].map((row) => row.name), 180);
      await execute(
          "UPDATE cloud_files SET folder_id = ?, name = ?, deleted_at = NULL WHERE id = ? AND owner_id = ?",
          [folderId, name, id, context.user.id]
        );
      }
    } else {
      const [folder] = await query<TrashedFolder>(
        "SELECT id, parent_id, name, created_at, updated_at, deleted_at, tags FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL LIMIT 1",
        [id, context.user.id]
      );
      if (!folder) return jsonError("항목을 찾을 수 없습니다.", 404);
      if (action === "delete") {
        const files = await query<TrashedFile>(
            `WITH RECURSIVE folder_tree (id) AS (
              SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ?
              UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
              WHERE child.owner_id = ?
            ) SELECT file_row.id, file_row.folder_id, file_row.name, file_row.mime_type, file_row.size_bytes,
              file_row.created_at, file_row.updated_at, file_row.deleted_at, file_row.tags
              FROM cloud_files file_row JOIN folder_tree tree ON tree.id = file_row.folder_id
              WHERE file_row.owner_id = ?`,
            [id, context.user.id, context.user.id, context.user.id]
          );
        await permanentlyDelete(context.user.id, files, [id]);
      } else {
        let parentId = folder.parent_id;
        if (parentId) {
          const [parent] = await query<RowDataPacket & { id: string }>(
            "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
            [parentId, context.user.id]
          );
          if (!parent) parentId = null;
        }
        const [siblings, siblingFiles] = await Promise.all([
          query<RowDataPacket & { name: string }>("SELECT name FROM cloud_folders WHERE owner_id = ? AND parent_id <=> ? AND id <> ? AND deleted_at IS NULL", [context.user.id, parentId, id]),
          query<RowDataPacket & { name: string }>("SELECT name FROM cloud_files WHERE owner_id = ? AND folder_id <=> ? AND deleted_at IS NULL", [context.user.id, parentId])
        ]);
        const name = uniqueDisplayName(folder.name, [...siblings, ...siblingFiles].map((row) => row.name), 80);
        await execute(
          "UPDATE cloud_folders SET parent_id = ?, name = ?, deleted_at = NULL WHERE id = ? AND owner_id = ?",
          [parentId, name, id, context.user.id]
        );
        await execute(
          `WITH RECURSIVE folder_tree (id) AS (
            SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ?
            UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
            WHERE child.owner_id = ? AND child.deleted_at IS NOT NULL
          ) UPDATE cloud_folders folder_row JOIN folder_tree tree ON tree.id = folder_row.id
            SET folder_row.deleted_at = NULL WHERE folder_row.owner_id = ?`,
          [id, context.user.id, context.user.id, context.user.id]
        );
        await execute(
          `WITH RECURSIVE folder_tree (id) AS (
            SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ?
            UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
            WHERE child.owner_id = ?
          ) UPDATE cloud_files file_row JOIN folder_tree tree ON tree.id = file_row.folder_id
            SET file_row.deleted_at = NULL WHERE file_row.owner_id = ? AND file_row.deleted_at IS NOT NULL`,
          [id, context.user.id, context.user.id, context.user.id]
        );
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "휴지통 작업을 완료하지 못했습니다.", 500);
  }
}

export async function DELETE(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  try {
    const [files, roots] = await Promise.all([
      query<TrashedFile>(
        "SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at, deleted_at, tags FROM cloud_files WHERE owner_id = ? AND deleted_at IS NOT NULL",
        [context.user.id]
      ),
      query<RowDataPacket & { id: string }>(
        `SELECT folder.id FROM cloud_folders folder LEFT JOIN cloud_folders parent ON parent.id = folder.parent_id
         WHERE folder.owner_id = ? AND folder.deleted_at IS NOT NULL
           AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)`,
        [context.user.id]
      )
    ]);
    await permanentlyDelete(context.user.id, files, roots.map((folder) => folder.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "휴지통을 비우지 못했습니다.", 500);
  }
}
