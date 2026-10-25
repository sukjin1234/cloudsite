import { NextResponse } from "next/server";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { isUuid } from "@/lib/file-utils";
import type { CloudFile, Folder } from "@/lib/types";

export const runtime = "nodejs";
const COLORS = new Set(["red", "orange", "yellow", "green", "blue", "purple", "gray"]);

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const color = new URL(request.url).searchParams.get("color") ?? "";
  if (!COLORS.has(color)) return jsonError("태그 색상이 올바르지 않습니다.");
  try {
    const [folders, files] = await Promise.all([
      query<Folder & import("mysql2/promise").RowDataPacket>(
        "SELECT id, parent_id, name, created_at, updated_at, tags FROM cloud_folders WHERE owner_id = ? AND deleted_at IS NULL AND JSON_CONTAINS(tags, JSON_QUOTE(?)) ORDER BY name",
        [context.user.id, color]
      ),
      query<CloudFile & import("mysql2/promise").RowDataPacket>(
        "SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at, tags FROM cloud_files WHERE owner_id = ? AND deleted_at IS NULL AND JSON_CONTAINS(tags, JSON_QUOTE(?)) ORDER BY name",
        [context.user.id, color]
      )
    ]);
    return NextResponse.json({ files, folders });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "태그 항목을 불러오지 못했습니다.", 500);
  }
}

export async function PATCH(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const payload = await request.json().catch(() => null);
  const { id, type, tags } = payload ?? {};
  if (!isUuid(id) || !["file", "folder"].includes(type) || !Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !COLORS.has(tag))) {
    return jsonError("태그 정보가 올바르지 않습니다.");
  }
  const table = type === "file" ? "cloud_files" : "cloud_folders";
  try {
    const result = await execute(
      `UPDATE ${table} SET tags = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
      [JSON.stringify([...new Set(tags)]), id, context.user.id]
    );
    if (!result.affectedRows) return jsonError("항목을 찾을 수 없습니다.", 404);
    return NextResponse.json({ ok: true, tags: [...new Set(tags)] });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "태그를 저장하지 못했습니다.", 500);
  }
}
