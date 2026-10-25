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
    ? { user: { id: previewAccess.ownerId, username: "" } }
    : requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  if (!isUuid(id)) {
    return jsonError("파일 ID가 올바르지 않습니다.");
  }

  try {
    const [file] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? AND (deleted_at IS NULL OR ? = 1) LIMIT 1`,
      [id, context.user.id, previewAccess ? 1 : 0]
    );
    if (!file) {
      return jsonError("파일을 찾을 수 없습니다.", 404);
    }
    const filePath = getStoredFilePath(context.user.id, file.id);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) {
      return jsonError("저장된 파일을 찾을 수 없습니다.", 404);
    }

    const rangeHeader = request.headers.get("range");
    let start = 0;
    let end = details.size - 1;
    let status = 200;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2]) || details.size === 0) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${details.size}`, "Accept-Ranges": "bytes" } });
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, details.size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), details.size - 1) : details.size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= details.size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${details.size}`, "Accept-Ranges": "bytes" } });
      }
      status = 206;
    }
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeFilename(file.name)}`,
      "Content-Length": String(end - start + 1),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": file.mime_type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${details.size}`);
    const body = Readable.toWeb(createReadStream(filePath, status === 206 ? { start, end } : undefined)) as ReadableStream;
    return new Response(body, { headers, status });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일을 불러오지 못했습니다.", 500);
  }
}
