import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isUuid,
  normalizeOptionalUuid,
  sanitizeStorageKeyName,
  sanitizeStorageName,
  validateDisplayName
} from "@/lib/file-utils";
import { CLOUD_BUCKET, isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FILE_SELECT =
  "id,folder_id,name,mime_type,size_bytes,storage_bucket,storage_path,created_at,updated_at";

type UploadContext = {
  supabase: SupabaseClient;
  user: {
    id: string;
  };
};

type FileRecordInput = {
  fileId: string;
  folderId: string | null;
  mimeType: string;
  name: string;
  sizeBytes: number;
  storageBucket: string;
  storagePath: string;
};

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

function normalizeMimeType(value: unknown) {
  if (typeof value !== "string") {
    return "application/octet-stream";
  }

  const mimeType = value.trim().slice(0, 255);
  return mimeType || "application/octet-stream";
}

function normalizeSizeBytes(value: unknown) {
  const size = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid file size");
  }

  return size;
}

function validateStorageBucket(value: unknown) {
  if (value !== undefined && value !== CLOUD_BUCKET) {
    throw new Error("Invalid storage bucket");
  }

  return CLOUD_BUCKET;
}

function validateUploadedStoragePath(value: unknown, userId: string, fileId: string) {
  if (typeof value !== "string") {
    throw new Error("Storage path is required");
  }

  const storagePath = value.trim();
  const expectedPrefix = `${userId}/${fileId}/`;

  if (
    !storagePath.startsWith(expectedPrefix) ||
    storagePath.length <= expectedPrefix.length ||
    /[\0\\]/.test(storagePath)
  ) {
    throw new Error("Invalid storage path");
  }

  return storagePath;
}

async function insertFileRecord(
  supabase: SupabaseClient,
  record: FileRecordInput
) {
  return supabase
    .from("cloud_files")
    .insert({
      folder_id: record.folderId,
      id: record.fileId,
      mime_type: record.mimeType,
      name: record.name,
      size_bytes: record.sizeBytes,
      storage_bucket: record.storageBucket,
      storage_path: record.storagePath
    })
    .select(FILE_SELECT)
    .single();
}

async function saveDirectUploadMetadata(request: Request, context: UploadContext) {
  const payload = await request.json().catch(() => null);
  let folderId: string | null;
  let fileId: string;
  let name: string;
  let sizeBytes: number;
  let storageBucket: string;
  let storagePath: string;

  try {
    folderId = normalizeOptionalUuid(payload?.folderId);
    fileId = typeof payload?.id === "string" && isUuid(payload.id) ? payload.id : "";
    if (!fileId) {
      throw new Error("Invalid file id");
    }

    name = validateDisplayName(payload?.name, {
      label: "File name",
      maxLength: 180
    });
    sizeBytes = normalizeSizeBytes(payload?.sizeBytes);
    storageBucket = validateStorageBucket(payload?.storageBucket);
    storagePath = validateUploadedStoragePath(
      payload?.storagePath,
      context.user.id,
      fileId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid file";
    return jsonError(message, 400);
  }

  const { data, error } = await insertFileRecord(context.supabase, {
    fileId,
    folderId,
    mimeType: normalizeMimeType(payload?.mimeType),
    name,
    sizeBytes,
    storageBucket,
    storagePath
  });

  if (error) {
    return jsonError(friendlyDatabaseError(error.message), 400, {
      rawError: error.message,
      stage: "database_insert"
    });
  }

  return NextResponse.json({ file: data }, { status: 201 });
}

export async function POST(request: Request) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  const requestContentType = request.headers.get("content-type") ?? "";
  if (requestContentType.toLowerCase().includes("application/json")) {
    return saveDirectUploadMetadata(request, context);
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

  const { data, error } = await insertFileRecord(context.supabase, {
    fileId,
    folderId,
    mimeType: contentType,
    name: fileName,
    sizeBytes: fileValue.size,
    storageBucket: CLOUD_BUCKET,
    storagePath
  });

  if (error) {
    await context.supabase.storage.from(CLOUD_BUCKET).remove([storagePath]);
    return jsonError(friendlyDatabaseError(error.message), 400, {
      rawError: error.message,
      stage: "database_insert"
    });
  }

  return NextResponse.json({ file: data }, { status: 201 });
}
