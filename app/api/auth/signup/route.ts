import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createSessionToken, getSessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";
import { execute } from "@/lib/db";
import { hashPassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = typeof payload?.password === "string" ? payload.password : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return NextResponse.json({ error: "올바른 이메일 주소를 입력하세요." }, { status: 400 });
  }
  if (password.length < 6 || password.length > 128) {
    return NextResponse.json({ error: "비밀번호는 6자 이상 128자 이하로 입력하세요." }, { status: 400 });
  }

  const user = { email, id: randomUUID() };
  try {
    const passwordHash = await hashPassword(password);
    await execute(
      "INSERT INTO cloud_users (id, email, password_hash) VALUES (?, ?, ?)",
      [user.id, user.email, passwordHash]
    );
    const response = NextResponse.json({ user }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, createSessionToken(user), getSessionCookieOptions());
    return response;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      return NextResponse.json({ error: "이미 가입된 이메일 주소입니다." }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "계정을 만들지 못했습니다." },
      { status: 500 }
    );
  }
}
