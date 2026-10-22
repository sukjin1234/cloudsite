import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/file-utils";

export const SESSION_COOKIE = "cloud_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const FILE_PREVIEW_TTL_SECONDS = 60 * 5;

export type AuthenticatedUser = {
  id: string;
  email: string;
};

type SessionPayload = AuthenticatedUser & {
  expiresAt: number;
};

type AuthenticatedContext = {
  user: AuthenticatedUser;
};

type AuthError = {
  errorResponse: NextResponse;
};

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET은 32자 이상이어야 합니다.");
  }
  return secret;
}

function sign(value: string) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

export function createSessionToken(user: AuthenticatedUser) {
  const payload: SessionPayload = {
    ...user,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function createFilePreviewToken(ownerId: string, fileId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + FILE_PREVIEW_TTL_SECONDS;
  const payload = `${ownerId}.${fileId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyFilePreviewToken(token: string) {
  const [ownerId, fileId, rawExpiresAt, signature, extra] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (
    extra ||
    !ownerId ||
    !fileId ||
    !rawExpiresAt ||
    !signature ||
    !isUuid(ownerId) ||
    !isUuid(fileId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  try {
    const payload = `${ownerId}.${fileId}.${expiresAt}`;
    const expected = Buffer.from(sign(payload), "base64url");
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return null;
    }
    return { fileId, ownerId };
  } catch {
    return null;
  }
}

function readSessionToken(token: string): AuthenticatedUser | null {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) {
    return null;
  }

  let expected: Buffer;
  let received: Buffer;
  try {
    expected = Buffer.from(sign(encodedPayload), "base64url");
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Partial<SessionPayload>;
    if (
      typeof payload.id !== "string" ||
      !isUuid(payload.id) ||
      typeof payload.email !== "string" ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { email: payload.email, id: payload.id };
  } catch {
    return null;
  }
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production"
  };
}

export function requireUser(request: Request): AuthenticatedContext | AuthError {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const entry = cookieHeader
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  const token = entry?.slice(SESSION_COOKIE.length + 1);
  const user = token ? readSessionToken(token) : null;

  if (!user) {
    return { errorResponse: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  }

  return { user };
}

export function isAuthError(
  value: AuthenticatedContext | AuthError
): value is AuthError {
  return "errorResponse" in value;
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
