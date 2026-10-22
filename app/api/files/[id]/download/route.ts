import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { isUuid } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

type FileRow = RowDataPacket & CloudFile;
type Params = { params: Promise<{ id: string }> };
const FILE_SELECT = "id, name, mime_type";

function encodeFilename(name: string) {
  return encodeURIComponent(name).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

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
    const filePath = getStoredFilePath(context.user.id, file.id);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) {
      return jsonError("저장된 파일을 찾을 수 없습니다.", 404);
    }

    const fallbackName = file.name
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;\r\n]/g, "_");
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${fallbackName || "download"}"; filename*=UTF-8''${encodeFilename(file.name)}`,
      "Content-Length": String(details.size),
      "Content-Type": file.mime_type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(body, { headers });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "다운로드를 시작하지 못했습니다.", 500);
  }
}
