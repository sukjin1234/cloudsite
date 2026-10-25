import { NextResponse } from "next/server";
import { isAuthError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
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
  return NextResponse.json({
    storage: { quotaBytes: Number(usage?.quota_bytes ?? 0), usedBytes: Number(usage?.used_bytes ?? 0) },
    user: context.user
  });
}
