export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  tags?: string[];
  deleted_at?: string | null;
  is_pinned?: boolean;
  pin_order?: number;
};

export type CloudFile = {
  id: string;
  folder_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  tags?: string[];
  deleted_at?: string | null;
};

export type PreviewKind =
  | "archive"
  | "document"
  | "image"
  | "pdf"
  | "spreadsheet"
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
