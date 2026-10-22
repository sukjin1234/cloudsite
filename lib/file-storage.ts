import { join, resolve } from "node:path";
import { isUuid } from "@/lib/file-utils";

export function getUploadRoot() {
  return resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || join(process.cwd(), "uploads"));
}

export function getStoredFilePath(ownerId: string, fileId: string) {
  if (!isUuid(ownerId) || !isUuid(fileId)) {
    throw new Error("Invalid file path");
  }
  return join(/*turbopackIgnore: true*/ getUploadRoot(), ownerId, fileId);
}
