import { NextResponse } from "next/server";
import { createSessionToken, getSessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import type { RowDataPacket } from "mysql2/promise";

export const runtime = "nodejs";

type UserRow = RowDataPacket & {
  id: string;
  password_hash: string;
  username: string;
};

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const username = typeof payload?.username === "string" ? payload.username.trim() : "";
  const password = typeof payload?.password === "string" ? payload.password : "";

  if (!username || username.length > 320 || !password || password.length > 128) {
    return NextResponse.json({ error: "아이디와 비밀번호를 입력하세요." }, { status: 400 });
  }

  try {
    const [user] = await query<UserRow>(
      "SELECT id, username, password_hash FROM cloud_users WHERE username = ? LIMIT 1",
      [username]
    );
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return NextResponse.json({ error: "아이디 또는 비밀번호를 확인하세요." }, { status: 401 });
    }

    const sessionUser = { id: user.id, username: user.username };
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
