import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { RowDataPacket } from "mysql2/promise";
import { jsonError } from "@/lib/auth";
import { query } from "@/lib/db";
import { getStoredFilePath } from "@/lib/file-storage";
import { verifyPassword } from "@/lib/password";

export const runtime = "nodejs";
type Params = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: Params) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,48}$/.test(token)) return jsonError("공유 링크를 찾을 수 없습니다.", 404);
  try {
    const [share] = await query<RowDataPacket & { owner_id: string; file_id: string | null; password_hash: string | null; expires_at: string | null }>(
      "SELECT owner_id, file_id, password_hash, expires_at FROM cloud_shares WHERE token = ? LIMIT 1", [token]
    );
    if (!share || !share.file_id || (share.expires_at && new Date(share.expires_at).getTime() <= Date.now())) return jsonError("공유 파일을 찾을 수 없습니다.", 404);
    if (share.password_hash && !(await verifyPassword(request.headers.get("x-share-password") ?? "", share.password_hash))) return jsonError("공유 비밀번호를 확인하세요.", 401);
    const [file] = await query<RowDataPacket & { id: string; name: string; mime_type: string }>(
      "SELECT id, name, mime_type FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL", [share.file_id, share.owner_id]
    );
    if (!file) return jsonError("공유 파일을 찾을 수 없습니다.", 404);
    const filePath = getStoredFilePath(share.owner_id, file.id);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) return jsonError("저장된 파일을 찾을 수 없습니다.", 404);
    const safeFallback = file.name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_").replace(/["\\;\r\n]/g, "_");
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safeFallback || "download"}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Content-Length": String(details.size),
        "Content-Type": file.mime_type || "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "공유 파일을 다운로드하지 못했습니다.", 500);
  }
}
