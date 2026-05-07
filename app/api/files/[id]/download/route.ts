import { isUuid } from "@/lib/file-utils";
import { isAuthError, jsonError, requireUser } from "@/lib/supabase/route";

const FILE_SELECT =
  "id,folder_id,name,mime_type,size_bytes,storage_bucket,storage_path,created_at,updated_at";

type Params = {
  params: {
    id: string;
  };
};

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
    .createSignedUrl(file.storage_path, 60, {
      download: file.name
    });

  if (signed.error || !signed.data?.signedUrl) {
    return jsonError(signed.error?.message ?? "Could not create download URL", 400);
  }

  return Response.json({
    expiresIn: 60,
    fileName: file.name,
    url: signed.data.signedUrl
  });
}
