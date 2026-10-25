import { join } from "node:path";
import { getUploadRoot } from "@/lib/file-storage";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

export type UploadSession = {
  id: string;
  ownerId: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export function getUploadSessionPaths(ownerId: string, id: string) {
  const directory = join(getUploadRoot(), ".tmp", ownerId);
  return { directory, metadata: join(directory, `${id}.json`), part: join(directory, `${id}.part`) };
}
