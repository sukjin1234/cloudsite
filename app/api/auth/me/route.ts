import { NextResponse } from "next/server";
import { isAuthError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }
  return NextResponse.json({ user: context.user });
}
