export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
};

export type CloudFile = {
  id: string;
  folder_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_bucket: string;
  storage_path: string;
  created_at: string;
  updated_at: string;
};

export type PreviewKind =
  | "image"
  | "pdf"
  | "text"
  | "office"
  | "audio"
  | "video"
  | "unsupported";

export type FolderListing = {
  currentFolder: Folder | null;
  folders: Folder[];
  files: CloudFile[];
};
