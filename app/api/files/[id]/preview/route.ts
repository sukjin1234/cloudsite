import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import {
  createFilePreviewToken,
  isAuthError,
  jsonError,
  requireUser
} from "@/lib/auth";
import { query } from "@/lib/db";
import { getPreviewKind, isUuid } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

type FileRow = RowDataPacket & CloudFile;
type Params = { params: Promise<{ id: string }> };
const FILE_SELECT =
  "id, folder_id, name, mime_type, size_bytes, created_at, updated_at";

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  if (!isUuid(id)) {
    return jsonError("파일 ID가 올바르지 않습니다.");
  }

  try {
    const [file] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? LIMIT 1`,
      [id, context.user.id]
    );
    if (!file) {
      return jsonError("파일을 찾을 수 없습니다.", 404);
    }
    const kind = getPreviewKind(file.mime_type, file.name);
    const contentUrl = `/api/files/${file.id}/content`;
    const url =
      kind === "office"
        ? new URL(
            `${contentUrl}?token=${createFilePreviewToken(context.user.id, file.id)}`,
            request.url
          ).toString()
        : contentUrl;
    return NextResponse.json({
      file,
      kind,
      url
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "미리보기를 열지 못했습니다.", 500);
  }
}
