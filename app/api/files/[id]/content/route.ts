import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { RowDataPacket } from "mysql2/promise";
import {
  isAuthError,
  jsonError,
  requireUser,
  verifyFilePreviewToken
} from "@/lib/auth";
import { query } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { isUuid } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

type FileRow = RowDataPacket & CloudFile;
type Params = { params: Promise<{ id: string }> };
const FILE_SELECT =
  "id, folder_id, name, mime_type, size_bytes, created_at, updated_at";

function encodeFilename(name: string) {
  return encodeURIComponent(name).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");
  const previewAccess = token ? verifyFilePreviewToken(token) : null;
  if (previewAccess && previewAccess.fileId !== id) {
    return jsonError("파일을 찾을 수 없습니다.", 404);
  }
  const context = previewAccess
    ? { user: { id: previewAccess.ownerId, email: "" } }
    : requireUser(request);
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
    const filePath = getStoredFilePath(context.user.id, file.id);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) {
      return jsonError("저장된 파일을 찾을 수 없습니다.", 404);
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeFilename(file.name)}`,
      "Content-Length": String(details.size),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": file.mime_type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(body, { headers });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일을 불러오지 못했습니다.", 500);
  }
}
