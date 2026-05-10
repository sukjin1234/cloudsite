import { NextResponse } from "next/server";
import {
  isUuid,
  normalizeOptionalUuid,
  validateDisplayName
} from "@/lib/file-utils";
import { isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FILE_SELECT =
  "id,folder_id,name,mime_type,size_bytes,storage_bucket,storage_path,created_at,updated_at";

type Params = {
  params: {
    id: string;
  };
};

export async function PATCH(request: Request, { params }: Params) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  if (!isUuid(params.id)) {
    return jsonError("Invalid file id", 400);
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError("Invalid file", 400);
  }

  const updates: {
    folder_id?: string | null;
    name?: string;
  } = {};

  if ("name" in payload) {
    try {
      updates.name = validateDisplayName(payload.name, {
        label: "File name",
        maxLength: 180
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid file";
      return jsonError(message, 400);
    }
  }

  if ("folderId" in payload) {
    try {
      updates.folder_id = normalizeOptionalUuid(payload.folderId);
    } catch {
      return jsonError("Invalid folder", 400);
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonError("No file changes provided", 400);
  }

  const { data, error } = await context.supabase
    .from("cloud_files")
    .update(updates)
    .eq("id", params.id)
    .select(FILE_SELECT)
    .single();

  if (error || !data) {
    return jsonError(error?.message ?? "File not found", error ? 400 : 404);
  }

  return NextResponse.json({ file: data });
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  if (!isUuid(params.id)) {
    return jsonError("Invalid file id", 400);
  }

  const { data: file, error: readError } = await context.supabase
    .from("cloud_files")
    .select(FILE_SELECT)
    .eq("id", params.id)
    .single();

  if (readError || !file) {
    return jsonError(readError?.message ?? "File not found", readError ? 400 : 404);
  }

  const removeResult = await context.supabase.storage
    .from(file.storage_bucket)
    .remove([file.storage_path]);

  if (removeResult.error) {
    return jsonError(removeResult.error.message, 400);
  }

  const { error: deleteError } = await context.supabase
    .from("cloud_files")
    .delete()
    .eq("id", params.id);

  if (deleteError) {
    return jsonError(deleteError.message, 400);
  }

  return NextResponse.json({ ok: true });
}
