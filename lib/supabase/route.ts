import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export { CLOUD_BUCKET } from "@/lib/cloud-config";

type AuthenticatedContext = {
  supabase: SupabaseClient;
  token: string;
  user: {
    email?: string;
    id: string;
  };
};

type AuthError = {
  errorResponse: NextResponse;
};

function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase environment variables are missing");
  }

  return { anonKey, url };
}

export function jsonError(
  message: string,
  status = 400,
  details?: Record<string, unknown>
) {
  return NextResponse.json({ error: message, ...details }, { status });
}

export async function requireUser(
  request: Request
): Promise<AuthenticatedContext | AuthError> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];

  if (!token) {
    return { errorResponse: jsonError("Authentication is required", 401) };
  }

  let env: ReturnType<typeof getSupabaseEnv>;

  try {
    env = getSupabaseEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server configuration error";
    return { errorResponse: jsonError(message, 500) };
  }

  const supabase = createClient(env.url, env.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });

  const { data, error } = await supabase.auth.getClaims(token);

  if (error || !data?.claims?.sub) {
    return { errorResponse: jsonError("Invalid session", 401) };
  }

  const email =
    typeof data.claims.email === "string" ? data.claims.email : undefined;

  return {
    supabase,
    token,
    user: {
      email,
      id: data.claims.sub
    }
  };
}

export function isAuthError(
  value: AuthenticatedContext | AuthError
): value is AuthError {
  return "errorResponse" in value;
}
