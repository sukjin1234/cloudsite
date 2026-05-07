import { NextResponse } from "next/server";
import {
  isUuid,
  normalizeOptionalUuid,
  validateDisplayName
} from "@/lib/file-utils";
import { isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FOLDER_SELECT = "id,parent_id,name,created_at,updated_at";
const FILE_SELECT =
  "id,folder_id,name,mime_type,size_bytes,storage_bucket,storage_path,created_at,updated_at";

export async function GET(request: Request) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  const url = new URL(request.url);
  const rawParentId = url.searchParams.get("parentId");
  let parentId: string | null;

  try {
    parentId = normalizeOptionalUuid(rawParentId);
  } catch {
    return jsonError("Invalid parent folder", 400);
  }

  let currentFolder = null;

  if (parentId) {
    const { data, error } = await context.supabase
      .from("cloud_folders")
      .select(FOLDER_SELECT)
      .eq("id", parentId)
      .single();

    if (error || !data) {
      return jsonError("Folder not found", 404);
    }

    currentFolder = data;
  }

  const folderResult = parentId
    ? await context.supabase
        .from("cloud_folders")
        .select(FOLDER_SELECT)
        .eq("parent_id", parentId)
        .order("name", { ascending: true })
    : await context.supabase
        .from("cloud_folders")
        .select(FOLDER_SELECT)
        .is("parent_id", null)
        .order("name", { ascending: true });

  if (folderResult.error) {
    return jsonError(folderResult.error.message, 500);
  }

  const fileResult = parentId
    ? await context.supabase
        .from("cloud_files")
        .select(FILE_SELECT)
        .eq("folder_id", parentId)
        .order("name", { ascending: true })
    : await context.supabase
        .from("cloud_files")
        .select(FILE_SELECT)
        .is("folder_id", null)
        .order("name", { ascending: true });

  if (fileResult.error) {
    return jsonError(fileResult.error.message, 500);
  }

  return NextResponse.json({
    currentFolder,
    folders: folderResult.data ?? [],
    files: fileResult.data ?? []
  });
}

export async function POST(request: Request) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  const payload = await request.json().catch(() => null);
  let name: string;
  let parentId: string | null;

  try {
    name = validateDisplayName(payload?.name, {
      label: "Folder name",
      maxLength: 80
    });
    parentId = normalizeOptionalUuid(payload?.parentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid folder";
    return jsonError(message, 400);
  }

  if (payload?.parentId && parentId && !isUuid(parentId)) {
    return jsonError("Invalid parent folder", 400);
  }

  const { data, error } = await context.supabase
    .from("cloud_folders")
    .insert({
      name,
      parent_id: parentId
    })
    .select(FOLDER_SELECT)
    .single();

  if (error) {
    return jsonError(error.message, 400);
  }

  return NextResponse.json({ folder: data }, { status: 201 });
}
