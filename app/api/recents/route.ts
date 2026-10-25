import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";

export const runtime = "nodejs";

type RecentItem = RowDataPacket & {
  id: string;
  kind: "file" | "folder";
  parent_id: string | null;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  updated_at: string;
  tags: string[];
};

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  try {
    const items = await query<RecentItem>(
      `SELECT id, kind, parent_id, name, mime_type, size_bytes, updated_at, tags FROM (
        SELECT id, 'folder' AS kind, parent_id, name, NULL AS mime_type, 0 AS size_bytes, updated_at, tags
          FROM cloud_folders WHERE owner_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT id, 'file' AS kind, folder_id AS parent_id, name, mime_type, size_bytes, updated_at, tags
          FROM cloud_files WHERE owner_id = ? AND deleted_at IS NULL
      ) recent_items ORDER BY updated_at DESC LIMIT 200`,
      [context.user.id, context.user.id]
    );
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "최근 항목을 불러오지 못했습니다.", 500);
  }
}
