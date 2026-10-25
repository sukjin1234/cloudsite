import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/file-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!isUuid(id)) return jsonError("폴더 ID가 올바르지 않습니다.");
  try {
    const path = await query<RowDataPacket & { id: string; parent_id: string | null; name: string; depth: number }>(
      `WITH RECURSIVE parents (id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT folder.id, folder.parent_id, folder.name, parents.depth + 1
        FROM cloud_folders folder JOIN parents ON parents.parent_id = folder.id
        WHERE folder.owner_id = ? AND folder.deleted_at IS NULL
      ) SELECT id, parent_id, name, depth FROM parents ORDER BY depth DESC`,
      [id, context.user.id, context.user.id]
    );
    if (!path.length) return jsonError("폴더를 찾을 수 없습니다.", 404);
    return NextResponse.json({ path });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "폴더 경로를 불러오지 못했습니다.", 500);
  }
}
