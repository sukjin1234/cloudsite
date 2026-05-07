import { NextResponse } from "next/server";
import {
  normalizeOptionalUuid,
  sanitizeStorageKeyName,
  sanitizeStorageName
} from "@/lib/file-utils";
import { CLOUD_BUCKET, isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FILE_SELECT =
  "id,folder_id,name,mime_type,size_bytes,storage_bucket,storage_path,created_at,updated_at";

function friendlyUploadError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("bucket not found") || normalized.includes("not found")) {
    return "Supabase Storage bucket 'cloud-files'가 없습니다. supabase/schema.sql을 실행하거나 Storage에서 bucket을 생성하세요.";
  }

  if (normalized.includes("row-level security") || normalized.includes("violates policy")) {
    return "Supabase Storage RLS 정책이 업로드를 막고 있습니다. supabase/schema.sql의 storage.objects policy를 다시 실행하세요.";
  }

  if (normalized.includes("payload too large") || normalized.includes("too large")) {
    return "파일이 업로드 제한보다 큽니다. Supabase bucket file_size_limit 또는 배포 환경의 요청 크기 제한을 확인하세요.";
  }

  return message;
}

function friendlyDatabaseError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("cloud_files") && normalized.includes("does not exist")) {
    return "DB 테이블 'cloud_files'가 없습니다. supabase/schema.sql을 Supabase SQL Editor에서 실행하세요.";
  }

  if (normalized.includes("duplicate key")) {
    return "같은 폴더에 같은 이름의 파일이 이미 있습니다. 파일 이름을 바꾸거나 기존 파일을 삭제하세요.";
  }

  if (normalized.includes("row-level security") || normalized.includes("violates policy")) {
    return "DB RLS 정책이 파일 메타데이터 저장을 막고 있습니다. supabase/schema.sql의 cloud_files policy를 다시 실행하세요.";
  }

  return message;
}

export async function POST(request: Request) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  const formData = await request.formData().catch(() => null);
  const fileValue = formData?.get("file");
  const rawFolderId = formData?.get("folderId");

  if (!(fileValue instanceof File)) {
    return jsonError("File is required", 400);
  }

  let folderId: string | null;

  try {
    folderId = normalizeOptionalUuid(rawFolderId);
  } catch {
    return jsonError("Invalid folder", 400);
  }

  const fileName = sanitizeStorageName(fileValue.name);
  const fileId = crypto.randomUUID();
  const storageKeyName = sanitizeStorageKeyName(fileValue.name, fileId);
  const storagePath = `${context.user.id}/${fileId}/${storageKeyName}`;
  const contentType = fileValue.type || "application/octet-stream";

  const uploadResult = await context.supabase.storage
    .from(CLOUD_BUCKET)
    .upload(storagePath, fileValue, {
      contentType,
      upsert: false
    });

  if (uploadResult.error) {
    return jsonError(friendlyUploadError(uploadResult.error.message), 400, {
      rawError: uploadResult.error.message,
      stage: "storage_upload"
    });
  }

  const { data, error } = await context.supabase
    .from("cloud_files")
    .insert({
      folder_id: folderId,
      id: fileId,
      mime_type: contentType,
      name: fileName,
      size_bytes: fileValue.size,
      storage_bucket: CLOUD_BUCKET,
      storage_path: storagePath
    })
    .select(FILE_SELECT)
    .single();

  if (error) {
    await context.supabase.storage.from(CLOUD_BUCKET).remove([storagePath]);
    return jsonError(friendlyDatabaseError(error.message), 400, {
      rawError: error.message,
      stage: "database_insert"
    });
  }

  return NextResponse.json({ file: data }, { status: 201 });
}
