import { isUuid } from "@/lib/file-utils";
import { isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FILE_SELECT =
  "id,folder_id,name,mime_type,size_bytes,storage_bucket,storage_path,created_at,updated_at";

type Params = {
  params: {
    id: string;
  };
};

const DOWNLOAD_URL_TTL_SECONDS = 60;

function encodeRFC5987Value(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getAsciiFilenameFallback(fileName: string) {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;\r\n]/g, "_")
    .trim();

  return fallback || "download";
}

function getContentDisposition(fileName: string) {
  const fallback = getAsciiFilenameFallback(fileName);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987Value(fileName)}`;
}

export async function GET(request: Request, { params }: Params) {
  const context = await requireUser(request);
  if (isAuthError(context)) {
    return context.errorResponse;
  }

  if (!isUuid(params.id)) {
    return jsonError("Invalid file id", 400);
  }

  const { data: file, error } = await context.supabase
    .from("cloud_files")
    .select(FILE_SELECT)
    .eq("id", params.id)
    .single();

  if (error || !file) {
    return jsonError(error?.message ?? "File not found", error ? 400 : 404);
  }

  const signed = await context.supabase.storage
    .from(file.storage_bucket)
    .createSignedUrl(file.storage_path, DOWNLOAD_URL_TTL_SECONDS);

  if (signed.error || !signed.data?.signedUrl) {
    return jsonError(signed.error?.message ?? "Could not create download URL", 400);
  }

  const storageResponse = await fetch(signed.data.signedUrl);

  if (!storageResponse.ok || !storageResponse.body) {
    return jsonError("Could not fetch file from storage", storageResponse.status || 400);
  }

  const headers = new Headers();
  const contentLength = storageResponse.headers.get("Content-Length");

  headers.set(
    "Content-Type",
    file.mime_type || storageResponse.headers.get("Content-Type") || "application/octet-stream"
  );
  headers.set("Content-Disposition", getContentDisposition(file.name));
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  headers.set("X-Content-Type-Options", "nosniff");

  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(storageResponse.body, { headers });
}
