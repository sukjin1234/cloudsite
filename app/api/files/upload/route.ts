import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { getStoredFilePath, getUploadRoot } from "@/lib/file-storage";
import { normalizeOptionalUuid, sanitizeStorageName } from "@/lib/file-utils";
import type { CloudFile } from "@/lib/types";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;
const FILE_SELECT =
  "id, folder_id, name, mime_type, size_bytes, created_at, updated_at";
type FileRow = RowDataPacket & CloudFile;

function isDuplicateEntry(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

export async function POST(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data") || !request.body) {
    return jsonError("업로드할 파일이 없습니다.");
  }

  const temporaryPath = join(getUploadRoot(), ".tmp", `${randomUUID()}.upload`);
  let fileSeen = false;
  let uploadError: Error | null = null;
  let fileName = "";
  let mimeType = "application/octet-stream";
  let sizeBytes = 0;
  let rawFolderId = "";
  const fileTasks: Promise<void>[] = [];

  try {
    await mkdir(join(getUploadRoot(), ".tmp"), { recursive: true });
    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: { fieldSize: 80, fields: 1, fileSize: MAX_FILE_SIZE_BYTES, files: 1 }
    });
    parser.on("field", (name, value) => {
      if (name === "folderId") {
        rawFolderId = value;
      } else {
        uploadError = new Error("업로드 정보가 올바르지 않습니다.");
      }
    });
    parser.on("fieldsLimit", () => {
      uploadError = new Error("업로드 정보가 너무 많습니다.");
    });
    parser.on("filesLimit", () => {
      uploadError = new Error("한 번에 하나의 파일만 업로드할 수 있습니다.");
    });
    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "file" || fileSeen) {
        uploadError = new Error("업로드할 파일이 올바르지 않습니다.");
        stream.resume();
        return;
      }
      fileSeen = true;
      fileName = sanitizeStorageName(info.filename ?? "upload");
      mimeType = info.mimeType
        .slice(0, 255)
        .replace(/[\u0000-\u001f\u007f]/g, "") || "application/octet-stream";
      stream.on("data", (chunk: Buffer) => {
        sizeBytes += chunk.length;
      });
      stream.on("limit", () => {
        uploadError = new Error("파일은 500MB 이하로 업로드할 수 있습니다.");
      });
      fileTasks.push(
        pipeline(stream, createWriteStream(temporaryPath, { flags: "wx" })).catch((error) => {
          uploadError = error instanceof Error ? error : new Error("파일 저장에 실패했습니다.");
        })
      );
    });

    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream),
      parser
    );
    await Promise.all(fileTasks);
    if (uploadError) {
      throw uploadError;
    }
    if (!fileSeen) {
      throw new Error("업로드할 파일이 없습니다.");
    }

    const folderId = normalizeOptionalUuid(rawFolderId);
    if (folderId) {
      const [folder] = await query<RowDataPacket & { id: string }>(
        "SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? LIMIT 1",
        [folderId, context.user.id]
      );
      if (!folder) {
        await unlink(temporaryPath).catch(() => undefined);
        return jsonError("폴더를 찾을 수 없습니다.", 404);
      }
    }

    const id = randomUUID();
    const finalPath = getStoredFilePath(context.user.id, id);
    await mkdir(join(getUploadRoot(), context.user.id), { recursive: true });
    await rename(temporaryPath, finalPath);
    let recordSaved = false;
    try {
      await execute(
        "INSERT INTO cloud_files (id, owner_id, folder_id, name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)",
        [id, context.user.id, folderId, fileName, mimeType, sizeBytes]
      );
      recordSaved = true;
      const [file] = await query<FileRow>(
        `SELECT ${FILE_SELECT} FROM cloud_files WHERE id = ? AND owner_id = ? LIMIT 1`,
        [id, context.user.id]
      );
      if (!file) {
        throw new Error("업로드한 파일 정보를 찾을 수 없습니다.");
      }
      return NextResponse.json({ file }, { status: 201 });
    } catch (error) {
      if (recordSaved) {
        try {
          await execute("DELETE FROM cloud_files WHERE id = ? AND owner_id = ?", [
            id,
            context.user.id
          ]);
        } catch {
          return jsonError("파일 저장 상태를 확인하지 못했습니다.", 500);
        }
      }
      await unlink(finalPath).catch(() => undefined);
      if (isDuplicateEntry(error)) {
        return jsonError("같은 폴더에 같은 이름의 파일이 이미 있습니다.", 409);
      }
      return jsonError(error instanceof Error ? error.message : "파일 정보를 저장하지 못했습니다.", 500);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const message = error instanceof Error ? error.message : "파일 업로드에 실패했습니다.";
    const status = message.includes("500MB") ? 413 : 400;
    return jsonError(message, status);
  }
}
