import { NextResponse } from "next/server";
import { isUuid, validateDisplayName } from "@/lib/file-utils";
import { isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FOLDER_SELECT = "id,parent_id,name,created_at,updated_at";

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
    return jsonError("Invalid folder id", 400);
  }

  const payload = await request.json().catch(() => null);
  let name: string;

  try {
    name = validateDisplayName(payload?.name, {
      label: "Folder name",
      maxLength: 80
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid folder";
    return jsonError(message, 400);
  }

  const { data, error } = await context.supabase
    .from("cloud_folders")
    .update({ name })
    .eq("id", params.id)
    .select(FOLDER_SELECT)
    .single();

  if (error || !data) {
    return jsonError(error?.message ?? "Folder not found", error ? 400 : 404);
  }

  return NextResponse.json({ folder: data });
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  if (!isUuid(params.id)) {
    return jsonError("Invalid folder id", 400);
  }

  const childFolders = await context.supabase
    .from("cloud_folders")
    .select("id", { count: "exact", head: true })
    .eq("parent_id", params.id);

  if (childFolders.error) {
    return jsonError(childFolders.error.message, 500);
  }

  const childFiles = await context.supabase
    .from("cloud_files")
    .select("id", { count: "exact", head: true })
    .eq("folder_id", params.id);

  if (childFiles.error) {
    return jsonError(childFiles.error.message, 500);
  }

  if ((childFolders.count ?? 0) > 0 || (childFiles.count ?? 0) > 0) {
    return jsonError("Only empty folders can be deleted", 409);
  }

  const { error } = await context.supabase
    .from("cloud_folders")
    .delete()
    .eq("id", params.id);

  if (error) {
    return jsonError(error.message, 400);
  }

  return NextResponse.json({ ok: true });
}
