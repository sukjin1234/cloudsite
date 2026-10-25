import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { isAuthError, jsonError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { isUuid } from "@/lib/file-utils";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) return context.errorResponse;
  const payload = await request.json().catch(() => null);
  const { id, type } = payload ?? {};
  const permission = payload?.permission === "edit" ? "edit" : payload?.permission === "read" ? "read" : null;
  if (!isUuid(id) || !["file", "folder"].includes(type) || !permission) return jsonError("공유 정보가 올바르지 않습니다.");
  const expiresAt = typeof payload?.expiresAt === "string" && payload.expiresAt
    ? new Date(payload.expiresAt)
    : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) return jsonError("만료 시간은 현재 이후여야 합니다.");
  const password = typeof payload?.password === "string" ? payload.password : "";
  if (password.length > 128) return jsonError("공유 비밀번호는 128자 이하여야 합니다.");
  try {
    const table = type === "file" ? "cloud_files" : "cloud_folders";
    const [node] = await query<RowDataPacket & { id: string }>(
      `SELECT id FROM ${table} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, context.user.id]
    );
    if (!node) return jsonError("항목을 찾을 수 없습니다.", 404);
    const token = randomBytes(24).toString("base64url");
    const passwordHash = password ? await hashPassword(password) : null;
    const shareId = randomUUID();
    await execute(
      "INSERT INTO cloud_shares (id, owner_id, file_id, folder_id, token, permission, password_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [shareId, context.user.id, type === "file" ? id : null, type === "folder" ? id : null, token, permission, passwordHash, expiresAt]
    );
    return NextResponse.json({ url: new URL(`/share/${token}`, request.url).toString() }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "공유 링크를 만들지 못했습니다.", 500);
  }
}
