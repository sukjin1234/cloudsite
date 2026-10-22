import { NextResponse } from "next/server";
import { createSessionToken, getSessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import type { RowDataPacket } from "mysql2/promise";

export const runtime = "nodejs";

type UserRow = RowDataPacket & {
  email: string;
  id: string;
  password_hash: string;
};

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = typeof payload?.password === "string" ? payload.password : "";

  if (!email || !password || password.length > 128) {
    return NextResponse.json({ error: "이메일과 비밀번호를 입력하세요." }, { status: 400 });
  }

  try {
    const [user] = await query<UserRow>(
      "SELECT id, email, password_hash FROM cloud_users WHERE email = ? LIMIT 1",
      [email]
    );
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return NextResponse.json({ error: "이메일 또는 비밀번호를 확인하세요." }, { status: 401 });
    }

    const sessionUser = { email: user.email, id: user.id };
    const response = NextResponse.json({ user: sessionUser });
    response.cookies.set(
      SESSION_COOKIE,
      createSessionToken(sessionUser),
      getSessionCookieOptions()
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "로그인하지 못했습니다." },
      { status: 500 }
    );
  }
}
