import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import type { Folder } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  try {
    const [folders, files] = await Promise.all([
      query<RowDataPacket & Folder>(
        "SELECT id, parent_id, name, created_at, updated_at, tags, is_pinned, pin_order FROM cloud_folders WHERE owner_id = ? AND parent_id IS NULL AND is_pinned = 1 AND deleted_at IS NULL ORDER BY pin_order, created_at",
        [context.user.id]
      ),
      query<RowDataPacket & { id: string; folder_id: null; name: string; mime_type: string; size_bytes: number; created_at: string; updated_at: string }>(
        "SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at FROM cloud_files WHERE owner_id = ? AND folder_id IS NULL AND deleted_at IS NULL ORDER BY created_at",
        [context.user.id]
      )
    ]);
    return NextResponse.json({ files, folders });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "고정 폴더를 불러오지 못했습니다.", 500);
  }
}
