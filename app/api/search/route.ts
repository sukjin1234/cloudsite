import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { normalizeOptionalUuid } from "@/lib/file-utils";
import type { CloudFile, Folder } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const params = new URL(request.url).searchParams;
  const search = (params.get("q") ?? "").trim().slice(0, 180);
  if (!search) return NextResponse.json({ files: [], folders: [] });
  let parentId: string | null = null;
  try {
    parentId = params.get("scope") === "current" ? normalizeOptionalUuid(params.get("parentId")) : null;
  } catch {
    return jsonError("검색 위치가 올바르지 않습니다.");
  }
  const pattern = `%${search}%`;
  try {
    const recursiveScope = params.get("scope") === "current";
    const scopeCte = recursiveScope
      ? `WITH RECURSIVE folder_tree (id) AS (
          SELECT id FROM cloud_folders WHERE ${parentId ? "id = ?" : "parent_id IS NULL"} AND owner_id = ? AND deleted_at IS NULL
          UNION ALL
          SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
          WHERE child.owner_id = ? AND child.deleted_at IS NULL
        )`
      : "";
    const scopeSql = recursiveScope
      ? "AND (parent_id <=> ? OR parent_id IN (SELECT id FROM folder_tree))"
      : "";
    const fileScopeSql = recursiveScope
      ? "AND (folder_id <=> ? OR folder_id IN (SELECT id FROM folder_tree))"
      : "";
    const scopeValues = recursiveScope
      ? [...(parentId ? [parentId] : []), context.user.id, context.user.id]
      : [];
    const [folders, files] = await Promise.all([
      query<RowDataPacket & Folder>(
        `${scopeCte} SELECT id, parent_id, name, created_at, updated_at, tags, is_pinned, pin_order FROM cloud_folders
         WHERE owner_id = ? AND deleted_at IS NULL AND name LIKE ? ${scopeSql}
         ORDER BY name LIMIT 1000`,
        [...scopeValues, context.user.id, pattern, ...(recursiveScope ? [parentId] : [])]
      ),
      query<RowDataPacket & CloudFile>(
        `${scopeCte} SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at, tags FROM cloud_files
         WHERE owner_id = ? AND deleted_at IS NULL AND name LIKE ? ${fileScopeSql}
         ORDER BY name LIMIT 1000`,
        [...scopeValues, context.user.id, pattern, ...(recursiveScope ? [parentId] : [])]
      )
    ]);
    return NextResponse.json({ files, folders });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "검색하지 못했습니다.", 500);
  }
}
