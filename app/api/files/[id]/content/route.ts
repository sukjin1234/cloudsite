import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import {
  isAuthError,
  jsonError,
  requireUser,
  verifyFilePreviewToken
} from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { isUuid } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

type FileRow = RowDataPacket & CloudFile;
type Params = { params: Promise<{ id: string }> };
const FILE_SELECT =
  "id, folder_id, name, mime_type, size_bytes, created_at, updated_at";
const EDIT_LIMIT = 20 * 1024 * 1024;

function encodeFilename(name: string) {
  return encodeURIComponent(name).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  if (!isUuid(id)) return jsonError("파일 ID가 올바르지 않습니다.");

  try {
    const [file] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, context.user.id]
    );
    if (!file || !file.name.toLocaleLowerCase("en-US").endsWith(".txt")) {
      return jsonError("편집할 수 있는 텍스트 파일이 아닙니다.", 404);
    }
    if (Number(file.size_bytes) >= EDIT_LIMIT) return jsonError("20 MB 이상 파일은 편집할 수 없습니다.", 413);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength >= EDIT_LIMIT) return jsonError("저장 가능한 파일 크기는 20 MB 미만입니다.", 413);
    const content = Buffer.from(await request.text(), "utf8");
    if (content.byteLength >= EDIT_LIMIT) return jsonError("저장 가능한 파일 크기는 20 MB 미만입니다.", 413);

    const [usage] = await query<RowDataPacket & { used_bytes: number; quota_bytes: number }>(
      "SELECT COALESCE(SUM(f.size_bytes), 0) AS used_bytes, u.storage_quota_bytes AS quota_bytes FROM cloud_users u LEFT JOIN cloud_files f ON f.owner_id = u.id WHERE u.id = ? GROUP BY u.id",
      [context.user.id]
    );
    if (usage && Number(usage.used_bytes) - Number(file.size_bytes) + content.byteLength > Number(usage.quota_bytes)) {
      return jsonError("저장 공간이 부족합니다.", 413);
    }

    const path = getStoredFilePath(context.user.id, file.id);
    const tempPath = path + ".edit-" + randomUUID();
    const backupPath = path + ".backup-" + randomUUID();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, content);
    let originalMoved = false;
    try {
      await rename(path, backupPath);
      originalMoved = true;
      await rename(tempPath, path);
      const updated = await execute(
        "UPDATE cloud_files SET size_bytes = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
        [content.byteLength, id, context.user.id]
      );
      if (!updated.affectedRows) throw new Error("파일이 이동되어 저장하지 못했습니다.");
      await unlink(backupPath).catch(() => undefined);
    } catch (error) {
      if (originalMoved) {
        await unlink(path).catch(() => undefined);
        await rename(backupPath, path).catch(() => undefined);
      }
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }

    const [updatedFile] = await query<FileRow>(
      `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? LIMIT 1`,
      [id, context.user.id]
    );
    return NextResponse.json({ file: updatedFile });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "파일을 저장하지 못했습니다.", 500);
  }
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
