import { createReadStream } from "node:fs";
import { link, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { TarArchive, ZipArchive } from "archiver";
import { path7za } from "7zip-bin";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { getStoredFilePath, getUploadRoot } from "@/lib/file-storage";
import { isUuid, validateDisplayName } from "@/lib/file-utils";

export const runtime = "nodejs";
type Entry = { type: "file" | "folder"; id: string };
type ZipFile = RowDataPacket & { id: string; name: string; archive_name: string };
type ZipFolder = RowDataPacket & { id: string; name: string; archive_name: string };
const run7za = promisify(execFile);

function encodeFilename(name: string) {
  return encodeURIComponent(name).replace(/[\'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function downloadResponse(filePath: string, fileName: string, format: string) {
  const bodyStream = createReadStream(filePath);
  const cleanup = () => { void rm(dirname(filePath), { recursive: true, force: true }); };
  bodyStream.once("close", cleanup);
  bodyStream.once("error", cleanup);
  const mime = format === "zip" ? "application/zip" : format === "tar" ? "application/x-tar" : "application/x-7z-compressed";
  return new Response(Readable.toWeb(bodyStream) as ReadableStream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(fileName)}`,
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function linkOrCopy(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  try { await link(source, target); }
  catch (error) {
    if (typeof error !== "object" || error === null || !["EXDEV", "EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    const { copyFile } = await import("node:fs/promises");
    await copyFile(source, target);
  }
}

export async function POST(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const payload = await request.json().catch(() => null);
  const items = payload?.items as unknown;
  const format = payload?.format === undefined ? "zip" : payload.format;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100 || items.some((item) => !item || !["file", "folder"].includes(item.type) || !isUuid(item.id))) {
    return jsonError("압축할 항목을 확인하세요.");
  }
  if (!["zip", "7z", "tar"].includes(format)) return jsonError("지원하지 않는 압축 형식입니다.");

  let workDirectory: string | null = null;
  try {
    const archive = format === "tar" ? new TarArchive() : new ZipArchive({ zlib: { level: 6 } });
    const files: Array<{ id: string; path: string }> = [];
    const directories: string[] = [];
    const rootNames: string[] = [];
    for (const item of items as Entry[]) {
      if (item.type === "file") {
        const [file] = await query<RowDataPacket & { id: string; name: string }>(
          "SELECT id, name FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
          [item.id, context.user.id]
        );
        if (!file) return jsonError("파일을 찾을 수 없습니다.", 404);
        files.push({ id: file.id, path: file.name });
        rootNames.push(file.name);
        continue;
      }

      const [root] = await query<RowDataPacket & { id: string; name: string }>(
        "SELECT id, name FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [item.id, context.user.id]
      );
      if (!root) return jsonError("폴더를 찾을 수 없습니다.", 404);
      const folderRows = await query<ZipFolder>(
        `WITH RECURSIVE folder_tree (id, archive_name) AS (
          SELECT id, name FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
          UNION ALL
          SELECT child.id, CONCAT(parent.archive_name, '/', child.name)
          FROM cloud_folders child JOIN folder_tree parent ON child.parent_id = parent.id
          WHERE child.owner_id = ? AND child.deleted_at IS NULL
        ) SELECT id, archive_name, SUBSTRING_INDEX(archive_name, '/', -1) AS name FROM folder_tree`,
        [root.id, context.user.id, context.user.id]
      );
      const fileRows = await query<ZipFile>(
        `WITH RECURSIVE folder_tree (id, archive_name) AS (
          SELECT id, name FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
          UNION ALL
          SELECT child.id, CONCAT(parent.archive_name, '/', child.name)
          FROM cloud_folders child JOIN folder_tree parent ON child.parent_id = parent.id
          WHERE child.owner_id = ? AND child.deleted_at IS NULL
        ) SELECT file_row.id, file_row.name, CONCAT(folder_tree.archive_name, '/', file_row.name) AS archive_name
          FROM cloud_files file_row JOIN folder_tree ON folder_tree.id = file_row.folder_id
          WHERE file_row.owner_id = ? AND file_row.deleted_at IS NULL`,
        [root.id, context.user.id, context.user.id, context.user.id]
      );
      directories.push(...folderRows.map((folder) => `${folder.archive_name}/`));
      files.push(...fileRows.map((file) => ({ id: file.id, path: file.archive_name })));
      rootNames.push(root.name);
    }

    const label = items.length === 1 && (items as Entry[])[0].type === "folder"
      ? rootNames[0]
      : "선택한 항목";
    const outputName = validateDisplayName(`${label}.${format}`, { maxLength: 180, label: "파일 이름" });

    if (format === "7z") {
      await mkdir(getUploadRoot(), { recursive: true });
      const base = await mkdtemp(join(getUploadRoot(), ".compress-"));
      workDirectory = base;
      const stageDirectory = join(base, "files");
      const outputPath = join(base, outputName);
      await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
      for (const folderPath of directories) await mkdir(join(stageDirectory, folderPath), { recursive: true });
      for (const file of files) await linkOrCopy(getStoredFilePath(context.user.id, file.id), join(stageDirectory, file.path));
      await run7za(path7za, ["a", "-t7z", outputPath, "."], { cwd: stageDirectory, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 300000 });
      await stat(outputPath);
      workDirectory = base;
      return downloadResponse(outputPath, outputName, format);
    }

    for (const folderPath of directories) archive.append("", { name: folderPath, type: "directory" });
    for (const file of files) {
      archive.append(createReadStream(getStoredFilePath(context.user.id, file.id)), { name: file.path });
    }
    archive.on("warning", (error) => { if (error.code !== "ENOENT") archive.destroy(error); });
    const body = Readable.toWeb(archive) as ReadableStream;
    void archive.finalize();
    return new Response(body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(outputName)}`,
        "Content-Type": format === "zip" ? "application/zip" : "application/x-tar",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    if (workDirectory) await rm(resolve(/*turbopackIgnore: true*/ workDirectory), { recursive: true, force: true }).catch(() => undefined);
    return jsonError(error instanceof Error ? error.message : "압축 파일을 만들지 못했습니다.", 500);
  }
}
