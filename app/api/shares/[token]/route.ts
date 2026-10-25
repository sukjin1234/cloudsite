import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { jsonError } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { isUuid, uniqueDisplayName, validateDisplayName } from "@/lib/file-utils";

export const runtime = "nodejs";
type Params = { params: Promise<{ token: string }> };
type ShareRow = RowDataPacket & {
  owner_id: string; file_id: string | null; folder_id: string | null; permission: "read" | "edit";
  password_hash: string | null; expires_at: string | null;
};

async function getShare(token: string, password: string) {
  const [share] = await query<ShareRow>(
    "SELECT owner_id, file_id, folder_id, permission, password_hash, expires_at FROM cloud_shares WHERE token = ? LIMIT 1",
    [token]
  );
  if (!share || (share.expires_at && new Date(share.expires_at).getTime() <= Date.now())) return null;
  if (share.password_hash && !(await verifyPassword(password, share.password_hash))) return "password" as const;
  return share;
}

async function assertSharedNode(share: ShareRow, type: "file" | "folder", id: string) {
  if (share.file_id) return type === "file" && share.file_id === id;
  const sql = type === "folder"
    ? `WITH RECURSIVE folder_tree (id) AS (
      SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
      UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
      WHERE child.owner_id = ? AND child.deleted_at IS NULL
    ) SELECT id FROM folder_tree WHERE id = ? LIMIT 1`
    : `WITH RECURSIVE folder_tree (id) AS (
      SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
      UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
      WHERE child.owner_id = ? AND child.deleted_at IS NULL
    ) SELECT file_row.id FROM cloud_files file_row JOIN folder_tree ON folder_tree.id = file_row.folder_id
      WHERE file_row.id = ? AND file_row.owner_id = ? AND file_row.deleted_at IS NULL LIMIT 1`;
  const values = type === "folder"
    ? [share.folder_id, share.owner_id, share.owner_id, id]
    : [share.folder_id, share.owner_id, share.owner_id, id, share.owner_id];
  const [node] = await query<RowDataPacket & { id: string }>(sql, values);
  return Boolean(node);
}

export async function GET(request: Request, { params }: Params) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,48}$/.test(token)) return jsonError("공유 링크를 찾을 수 없습니다.", 404);
  try {
    const share = await getShare(token, request.headers.get("x-share-password") ?? "");
    if (!share) return jsonError("공유 링크가 만료되었거나 삭제되었습니다.", 404);
    if (share === "password") return jsonError("공유 비밀번호를 입력하세요.", 401);
    if (share.file_id) {
      const [file] = await query<RowDataPacket>(
        "SELECT id, name, mime_type, size_bytes, updated_at FROM cloud_files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1",
        [share.file_id, share.owner_id]
      );
      if (!file) return jsonError("공유 항목을 찾을 수 없습니다.", 404);
      return NextResponse.json({ file, permission: share.permission, type: "file" });
    }

    const parentId = new URL(request.url).searchParams.get("parentId") ?? share.folder_id;
    if (!parentId) return jsonError("공유 폴더를 찾을 수 없습니다.", 404);
    const [allowed] = await query<RowDataPacket & { id: string }>(
      `WITH RECURSIVE folder_tree (id) AS (
        SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
        UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
        WHERE child.owner_id = ? AND child.deleted_at IS NULL
      ) SELECT id FROM folder_tree WHERE id = ? LIMIT 1`,
      [share.folder_id, share.owner_id, share.owner_id, parentId]
    );
    if (!allowed) return jsonError("공유 폴더 안의 항목만 열 수 있습니다.", 403);
    const [folder, folders, files] = await Promise.all([
      query<RowDataPacket>("SELECT id, parent_id, name FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1", [parentId, share.owner_id]),
      query<RowDataPacket>("SELECT id, parent_id, name FROM cloud_folders WHERE owner_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY name", [share.owner_id, parentId]),
      query<RowDataPacket>("SELECT id, folder_id, name, mime_type, size_bytes, updated_at FROM cloud_files WHERE owner_id = ? AND folder_id = ? AND deleted_at IS NULL ORDER BY name", [share.owner_id, parentId])
    ]);
    return NextResponse.json({ files, folder: folder[0] ?? null, folders, permission: share.permission, rootId: share.folder_id, type: "folder" });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "공유 항목을 불러오지 못했습니다.", 500);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const { token } = await params;
  const share = await getShare(token, request.headers.get("x-share-password") ?? "");
  if (!share || share === "password") return jsonError("공유 링크를 확인하세요.", share === "password" ? 401 : 404);
  if (share.permission !== "edit") return jsonError("이 공유 링크는 읽기 전용입니다.", 403);
  const payload = await request.json().catch(() => null);
  const { id, type } = payload ?? {};
  if (!isUuid(id) || !["file", "folder"].includes(type)) return jsonError("항목 정보가 올바르지 않습니다.");
  let name: string;
  try { name = validateDisplayName(payload?.name, { label: "이름", maxLength: type === "folder" ? 80 : 180 }); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "이름이 올바르지 않습니다."); }
  try {
    if (!(await assertSharedNode(share, type, id))) return jsonError("공유 범위를 벗어난 항목입니다.", 403);
    const table = type === "file" ? "cloud_files" : "cloud_folders";
    const parentColumn = type === "file" ? "folder_id" : "parent_id";
    const [node] = await query<RowDataPacket & { id: string; name: string; parent_id: string | null }>(
      `SELECT id, name, ${parentColumn} AS parent_id FROM ${table} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
      [id, share.owner_id]
    );
    if (!node) return jsonError("항목을 찾을 수 없습니다.", 404);
    const siblings = await query<RowDataPacket & { name: string }>(
      `SELECT name FROM ${table} WHERE owner_id = ? AND ${parentColumn} <=> ? AND id <> ? AND deleted_at IS NULL`,
      [share.owner_id, node.parent_id, id]
    );
    const uniqueName = uniqueDisplayName(name, siblings.map((row) => row.name), type === "folder" ? 80 : 180);
    await execute(`UPDATE ${table} SET name = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`, [uniqueName, id, share.owner_id]);
    return NextResponse.json({ ok: true, name: uniqueName });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "이름을 바꾸지 못했습니다.", 500);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { token } = await params;
  const share = await getShare(token, request.headers.get("x-share-password") ?? "");
  if (!share || share === "password") return jsonError("공유 링크를 확인하세요.", share === "password" ? 401 : 404);
  if (share.permission !== "edit") return jsonError("이 공유 링크는 읽기 전용입니다.", 403);
  const payload = await request.json().catch(() => null);
  const { id, type } = payload ?? {};
  if (!isUuid(id) || !["file", "folder"].includes(type)) return jsonError("항목 정보가 올바르지 않습니다.");
  try {
    if (!(await assertSharedNode(share, type, id))) return jsonError("공유 범위를 벗어난 항목입니다.", 403);
    if (type === "file") {
      await execute("UPDATE cloud_files SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND owner_id = ? AND deleted_at IS NULL", [id, share.owner_id]);
    } else {
      await execute(
        `WITH RECURSIVE folder_tree (id) AS (
          SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
          UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
          WHERE child.owner_id = ? AND child.deleted_at IS NULL
        ) UPDATE cloud_files file_row JOIN folder_tree tree ON tree.id = file_row.folder_id
          SET file_row.deleted_at = CURRENT_TIMESTAMP(3) WHERE file_row.owner_id = ? AND file_row.deleted_at IS NULL`,
        [id, share.owner_id, share.owner_id, share.owner_id]
      );
      await execute(
        `WITH RECURSIVE folder_tree (id) AS (
          SELECT id FROM cloud_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
          UNION ALL SELECT child.id FROM cloud_folders child JOIN folder_tree tree ON child.parent_id = tree.id
          WHERE child.owner_id = ? AND child.deleted_at IS NULL
        ) UPDATE cloud_folders folder_row JOIN folder_tree tree ON tree.id = folder_row.id
          SET folder_row.deleted_at = CURRENT_TIMESTAMP(3) WHERE folder_row.owner_id = ? AND folder_row.deleted_at IS NULL`,
        [id, share.owner_id, share.owner_id, share.owner_id]
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "항목을 휴지통으로 옮기지 못했습니다.", 500);
  }
}
