import { NextResponse } from "next/server";
import { getSessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    ...getSessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0
  });
  return response;
}
