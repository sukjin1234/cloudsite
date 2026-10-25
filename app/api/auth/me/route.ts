import { NextResponse } from "next/server";
import { statfs } from "node:fs/promises";
import { isAuthError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { getUploadRoot } from "@/lib/file-storage";
import type { RowDataPacket } from "mysql2/promise";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  const [usage] = await query<RowDataPacket & { used_bytes: number; quota_bytes: number }>(
    "SELECT COALESCE(SUM(f.size_bytes), 0) AS used_bytes, u.storage_quota_bytes AS quota_bytes FROM cloud_users u LEFT JOIN cloud_files f ON f.owner_id = u.id WHERE u.id = ? GROUP BY u.id",
    [context.user.id]
  );
  const usedBytes = Number(usage?.used_bytes ?? 0);
  let quotaBytes = Number(usage?.quota_bytes ?? 0);
  try {
    const filesystem = await statfs(getUploadRoot());
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (Number.isFinite(availableBytes)) {
      quotaBytes = Math.min(quotaBytes, usedBytes + Math.max(0, availableBytes));
    }
  } catch {
    // Fall back to the account quota when filesystem details are unavailable.
  }
  return NextResponse.json({
    storage: { quotaBytes, usedBytes },
    user: context.user
  });
}
