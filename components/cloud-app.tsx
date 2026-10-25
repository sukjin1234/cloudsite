"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import Image from "next/image";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Columns3,
  Download,
  File,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Grid2x2,
  Home,
  Images,
  Info,
  List,
  Loader2,
  LogOut,
  Ellipsis,
  RotateCcw,
  Pencil,
  RefreshCcw,
  Search,
  Share2,
  Star,
  Tag,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { formatFileSize, getPreviewKind } from "@/lib/file-utils";
import type { CloudFile, Folder as CloudFolder, PreviewKind } from "@/lib/types";
import { parseDocxPreview, type DocxPreview } from "@/lib/docx-preview";
import { parseXlsxPreview, type SpreadsheetPreview } from "@/lib/xlsx-preview";

type Breadcrumb = {
  id: string | null;
  name: string;
};

type PreviewState =
  | { status: "idle"; file: null }
  | { status: "loading"; file: CloudFile }
  | {
      status: "ready";
      document?: DocxPreview;
      file: CloudFile;
      kind: PreviewKind;
      spreadsheet?: SpreadsheetPreview;
      text?: string;
      url: string;
    }
  | { status: "error"; file: CloudFile | null; message: string };

type PreviewResponse = {
  kind: PreviewKind;
  url: string;
};

type CloudUser = {
  id: string;
  username: string;
};

type ViewMode = "icons" | "list" | "columns" | "gallery";
type SortKey = "name" | "modified" | "size";
type SidebarLocation = "drive" | "recents" | "trash" | "tag";
type RecentRow = {
  id: string;
  kind: "file" | "folder";
  parent_id: string | null;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  updated_at: string;
  tags: string[];
};
type StorageUsage = { usedBytes: number; quotaBytes: number };
type Favorite = { id: string; name: string };
type FolderListing = { files: CloudFile[]; folders: CloudFolder[] };
type GalleryItem = { file?: CloudFile; folder?: CloudFolder; id: string; kind: "file" | "folder"; name: string };

const ROOT_BREADCRUMB: Breadcrumb = {
  id: null,
  name: "내 드라이브"
};

const FILE_DRAG_DATA_TYPE = "application/x-personal-cloud-file-id";
const FOLDER_DRAG_DATA_TYPE = "application/x-personal-cloud-folder-id";
const PREVIEW_WIDTH_STORAGE_KEY = "personal-cloud-preview-width";
const DEFAULT_PREVIEW_WIDTH = 420;
const MIN_PREVIEW_WIDTH = 320;
const MAX_PREVIEW_WIDTH = 760;
const ROOT_DROP_TARGET_KEY = "root";
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

function clampPreviewWidth(value: number) {
  return Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, value));
}

function getDropTargetKey(folderId: string | null) {
  return folderId ?? ROOT_DROP_TARGET_KEY;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    rawError?: string;
    stage?: string;
  };

  if (!response.ok) {
    const suffix = payload.stage ? ` (${payload.stage})` : "";
    throw new Error(`${payload.error ?? "요청을 처리하지 못했습니다."}${suffix}`);
  }

  return payload;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function sortByName<T extends { name: string }>(items: T[]) {
  return [...items].sort((a, b) =>
    a.name.localeCompare(b.name, "ko-KR", {
      numeric: true,
      sensitivity: "base"
    })
  );
}

function upsertSortedById<T extends { id: string; name: string }>(items: T[], item: T) {
  const exists = items.some((current) => current.id === item.id);
  const next = exists
    ? items.map((current) => (current.id === item.id ? item : current))
    : [...items, item];

  return sortByName(next);
}

function FileKindIcon({ file }: { file: CloudFile }) {
  const kind = getPreviewKind(file.mime_type, file.name);

  if (kind === "image") {
    return <FileImage aria-hidden="true" />;
  }

  if (kind === "audio") {
    return <FileAudio aria-hidden="true" />;
  }

  if (kind === "video") {
    return <FileVideo aria-hidden="true" />;
  }

  if (kind === "spreadsheet") {
    return <FileSpreadsheet aria-hidden="true" />;
  }

  if (kind === "document" || kind === "text" || kind === "pdf" || kind === "office") {
    return <FileText aria-hidden="true" />;
  }

  return <File aria-hidden="true" />;
}

export function CloudApp() {
  const [session, setSession] = useState<CloudUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([ROOT_BREADCRUMB]);
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [columnListings, setColumnListings] = useState<FolderListing[]>([]);
  const [listingLoading, setListingLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    file: null,
    status: "idle"
  });
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState(DEFAULT_PREVIEW_WIDTH);
  const [resizingPreview, setResizingPreview] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("icons");
  const [activeLocation, setActiveLocation] = useState<SidebarLocation>("drive");
  const [activeTag, setActiveTag] = useState("blue");
  const [searchScope, setSearchScope] = useState<"current" | "all">("current");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [storageUsage, setStorageUsage] = useState<StorageUsage>({ usedBytes: 0, quotaBytes: 0 });
  const [thumbSize, setThumbSize] = useState(76);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDescending, setSortDescending] = useState(false);
  const [gridViewport, setGridViewport] = useState({ height: 600, scrollTop: 0, width: 900 });
  const [infoItem, setInfoItem] = useState<{ name: string; type: string; size?: number; updated_at: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: "file" | "folder"; id: string } | null>(null);
  const [clipboardItem, setClipboardItem] = useState<{ type: "file" | "folder"; id: string } | null>(null);
  const [shareTarget, setShareTarget] = useState<{ type: "file" | "folder"; id: string } | null>(null);
  const [sharePermission, setSharePermission] = useState<"read" | "edit">("read");
  const [sharePassword, setSharePassword] = useState("");
  const [shareExpires, setShareExpires] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const itemsViewportRef = useRef<HTMLDivElement | null>(null);
  const previewRequestRef = useRef(0);
  const previewResizeRef = useRef<{
    startWidth: number;
    startX: number;
  } | null>(null);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(PREVIEW_WIDTH_STORAGE_KEY);
    const parsedWidth = storedWidth ? Number(storedWidth) : Number.NaN;

    if (Number.isFinite(parsedWidth)) {
      setPreviewWidth(clampPreviewWidth(parsedWidth));
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(previewWidth));
  }, [previewWidth]);

  useEffect(() => {
    const element = itemsViewportRef.current;
    if (!element) return;
    const measure = () => setGridViewport({ height: element.clientHeight, scrollTop: element.scrollTop, width: element.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [session, viewMode]);

  useEffect(() => {
    if (itemsViewportRef.current) itemsViewportRef.current.scrollTop = 0;
    setGridViewport((previous) => ({ ...previous, scrollTop: 0 }));
  }, [activeLocation, currentFolderId, query, viewMode]);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("personal-cloud-favorites") ?? "[]");
      if (Array.isArray(saved)) setFavorites(saved.filter((item) => typeof item?.id === "string" && typeof item?.name === "string"));
    } catch {
      setFavorites([]);
    }
    setFavoritesReady(true);
  }, []);

  useEffect(() => {
    if (!favoritesReady) return;
    window.localStorage.setItem("personal-cloud-favorites", JSON.stringify(favorites));
  }, [favorites, favoritesReady]);

  useEffect(() => {
    const selectionStart = selectionBox;
    if (!selectionStart) return;
    function move(event: PointerEvent) {
      setSelectionBox((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null);
    }
    function finish(event: PointerEvent) {
      if (!selectionStart) return;
      const left = Math.min(selectionStart.startX, event.clientX);
      const right = Math.max(selectionStart.startX, event.clientX);
      const top = Math.min(selectionStart.startY, event.clientY);
      const bottom = Math.max(selectionStart.startY, event.clientY);
      if (right - left > 3 || bottom - top > 3) {
        const hits = Array.from(document.querySelectorAll<HTMLElement>("[data-item-key]"))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
          })
          .map((element) => element.dataset.itemKey)
          .filter((key): key is string => Boolean(key));
        setSelectedItems(hits);
      }
      setSelectionBox(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
  }, [selectionBox]);

  useEffect(() => {
    if (!resizingPreview) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const resizeState = previewResizeRef.current;
      if (!resizeState) {
        return;
      }

      const nextWidth = resizeState.startWidth + resizeState.startX - event.clientX;
      setPreviewWidth(clampPreviewWidth(nextWidth));
    }

    function handlePointerUp() {
      previewResizeRef.current = null;
      setResizingPreview(false);
    }

    document.body.classList.add("preview-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.classList.remove("preview-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizingPreview]);

  useEffect(() => {
    let mounted = true;

    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { user?: CloudUser } | null) => {
        if (mounted) {
          setSession(data?.user ?? null);
        }
      })
      .catch(() => {
        if (mounted) {
          setSession(null);
        }
      })
      .finally(() => {
        if (mounted) {
          setAuthLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (session) {
      return;
    }
    setBreadcrumbs([ROOT_BREADCRUMB]);
    setFolders([]);
    setFiles([]);
    setPreview({ file: null, status: "idle" });
  }, [session]);

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const response = await fetch(input, {
        ...init,
        credentials: "same-origin"
      });
      if (response.status === 401) {
        setSession(null);
      }
      return response;
    },
    []
  );

  const loadListing = useCallback(
    async (folderId: string | null) => {
      setListingLoading(true);
      setNotice(null);

      try {
        const params = new URLSearchParams();
        let endpoint = "/api/folders";
        if (query.trim()) {
          endpoint = "/api/search";
          params.set("q", query.trim());
          params.set("scope", searchScope);
          if (searchScope === "current" && folderId) params.set("parentId", folderId);
        } else if (activeLocation === "trash") {
          endpoint = "/api/trash";
        } else if (activeLocation === "recents") {
          endpoint = "/api/recents";
        } else if (activeLocation === "tag") {
          endpoint = "/api/tags";
          params.set("color", activeTag);
        } else if (folderId) {
          params.set("parentId", folderId);
        }

        const response = await authFetch(`${endpoint}?${params.toString()}`);
        const data = await parseApiResponse<Record<string, unknown>>(response);
        if (endpoint === "/api/recents") {
          const recentItems = (data.items ?? []) as RecentRow[];
          setFolders(recentItems.filter((item) => item.kind === "folder").map((item) => ({
            id: item.id, parent_id: item.parent_id, name: item.name,
            created_at: item.updated_at, updated_at: item.updated_at, tags: item.tags
          })));
          setFiles(recentItems.filter((item) => item.kind === "file").map((item) => ({
            id: item.id, folder_id: item.parent_id, name: item.name, mime_type: item.mime_type ?? "application/octet-stream",
            size_bytes: item.size_bytes, created_at: item.updated_at, updated_at: item.updated_at, tags: item.tags
          })));
        } else {
          setFolders((data.folders ?? []) as CloudFolder[]);
          setFiles((data.files ?? []) as CloudFile[]);
        }
        setSelectedItems([]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "목록을 불러오지 못했습니다.";
        setNotice(message);
      } finally {
        setListingLoading(false);
      }
    },
    [activeLocation, activeTag, authFetch, query, searchScope]
  );

  useEffect(() => {
    if (session) {
      void loadListing(currentFolderId);
    }
  }, [activeLocation, activeTag, currentFolderId, loadListing, query, searchScope, session]);

  useEffect(() => {
    if (!session || viewMode !== "columns" || activeLocation !== "drive" || query.trim()) {
      setColumnListings([]);
      return;
    }

    let cancelled = false;
    const parentIds: Array<string | null> = [null, ...breadcrumbs.slice(1).flatMap((crumb) => crumb.id ? [crumb.id] : [])];
    setColumnListings([]);
    void Promise.all(parentIds.map(async (parentId) => {
      const params = new URLSearchParams();
      if (parentId) params.set("parentId", parentId);
      const response = await authFetch(`/api/folders?${params.toString()}`);
      const data = await parseApiResponse<{ files?: CloudFile[]; folders?: CloudFolder[] }>(response);
      return { files: data.files ?? [], folders: data.folders ?? [] };
    })).then((listings) => {
      if (!cancelled) setColumnListings(listings);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : "단계별 보기를 불러오지 못했습니다.");
    });

    return () => {
      cancelled = true;
    };
  }, [activeLocation, authFetch, breadcrumbs, query, session, viewMode]);

  useEffect(() => {
    if (!session) return;
    void authFetch("/api/auth/me")
      .then((response) => response.json())
      .then((data: { storage?: StorageUsage }) => setStorageUsage(data.storage ?? { usedBytes: 0, quotaBytes: 0 }))
      .catch(() => setStorageUsage({ usedBytes: 0, quotaBytes: 0 }));
  }, [authFetch, files, session]);

  const filteredFolders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized ? folders.filter((folder) => folder.name.toLowerCase().includes(normalized)) : [...folders];
    return matches.sort((a, b) => {
      const comparison = sortKey === "modified" ? new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime() : a.name.localeCompare(b.name, "ko-KR", { numeric: true, sensitivity: "base" });
      return sortDescending ? -comparison : comparison;
    });
  }, [folders, query, sortDescending, sortKey]);

  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized ? files.filter((file) => file.name.toLowerCase().includes(normalized)) : [...files];
    return matches.sort((a, b) => {
      const comparison = sortKey === "modified" ? new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
        : sortKey === "size" ? a.size_bytes - b.size_bytes
        : a.name.localeCompare(b.name, "ko-KR", { numeric: true, sensitivity: "base" });
      return sortDescending ? -comparison : comparison;
    });
  }, [files, query, sortDescending, sortKey]);

  const galleryItems = useMemo<GalleryItem[]>(() => [
    ...filteredFolders.map((folder) => ({ folder, id: folder.id, kind: "folder" as const, name: folder.name })),
    ...filteredFiles.map((file) => ({ file, id: file.id, kind: "file" as const, name: file.name }))
  ], [filteredFiles, filteredFolders]);
  const columnData = viewMode === "columns" && activeLocation === "drive" && !query.trim()
    ? columnListings
    : [{ files: filteredFiles, folders: filteredFolders }];

  useEffect(() => {
    if (viewMode !== "gallery" || selectedItems.length > 0 || galleryItems.length === 0) return;
    const firstItem = galleryItems[0];
    const key = `${firstItem.kind}:${firstItem.id}`;
    setSelectedItems([key]);
    lastSelectedRef.current = key;
    if (firstItem.file) void selectFile(firstItem.file);
  }, [galleryItems, selectedItems.length, viewMode]);

  const totalVisibleItems = filteredFolders.length + filteredFiles.length;
  const virtualized = totalVisibleItems > 100;
  const cellWidth = viewMode === "list" ? gridViewport.width : viewMode === "columns" ? gridViewport.width / 2 : thumbSize + 48;
  const columnCount = viewMode === "list" ? 1 : Math.max(1, Math.floor(gridViewport.width / Math.max(180, cellWidth)));
  const rowHeight = viewMode === "list" ? 42 : viewMode === "columns" ? 74 : viewMode === "gallery" ? 190 : 140;
  const firstVisibleRow = virtualized ? Math.max(0, Math.floor(gridViewport.scrollTop / rowHeight) - 2) : 0;
  const lastVisibleRow = virtualized ? Math.ceil((gridViewport.scrollTop + gridViewport.height) / rowHeight) + 2 : Math.ceil(totalVisibleItems / columnCount);
  const visibleStart = firstVisibleRow * columnCount;
  const visibleEnd = Math.min(totalVisibleItems, lastVisibleRow * columnCount);
  const visibleFolderItems = filteredFolders.flatMap((folder, index) => index >= visibleStart && index < visibleEnd ? [{ folder, index }] : []);
  const visibleFileItems = filteredFiles.flatMap((file, index) => {
    const globalIndex = filteredFolders.length + index;
    return globalIndex >= visibleStart && globalIndex < visibleEnd ? [{ file, index: globalIndex }] : [];
  });

  function getVirtualStyle(index: number): CSSProperties | undefined {
    if (!virtualized) return undefined;
    if (viewMode === "list") return { height: rowHeight, left: 0, position: "absolute", right: 0, top: index * rowHeight };
    return {
      height: rowHeight,
      left: `${(index % columnCount) * (100 / columnCount)}%`,
      position: "absolute",
      top: Math.floor(index / columnCount) * rowHeight,
      width: `${100 / columnCount}%`
    };
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthSubmitting(true);
    setAuthMessage(null);

    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({ username, password }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const data = await parseApiResponse<{ user: CloudUser }>(response);
      setSession(data.user);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "로그인하지 못했습니다.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession(null);
    setBreadcrumbs([ROOT_BREADCRUMB]);
    setFolders([]);
    setFiles([]);
    setPreview({ file: null, status: "idle" });
  }

  function setLocation(location: SidebarLocation, tag?: string) {
    setSidebarOpen(false);
    setActiveLocation(location);
    if (tag) setActiveTag(tag);
    setQuery("");
    setSearchScope("current");
    setBreadcrumbs([ROOT_BREADCRUMB]);
    setPreview({ file: null, status: "idle" });
    setSelectedItems([]);
  }

  function selectItem(type: "file" | "folder", id: string, event: ReactMouseEvent) {
    const key = `${type}:${id}`;
    const allKeys = [
      ...filteredFolders.map((folder) => `folder:${folder.id}`),
      ...filteredFiles.map((file) => `file:${file.id}`)
    ];
    if (event.shiftKey && lastSelectedRef.current) {
      const start = allKeys.indexOf(lastSelectedRef.current);
      const end = allKeys.indexOf(key);
      if (start >= 0 && end >= 0) {
        setSelectedItems(allKeys.slice(Math.min(start, end), Math.max(start, end) + 1));
      }
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedItems((previous) => previous.includes(key)
        ? previous.filter((item) => item !== key)
        : [...previous, key]);
    } else {
      setSelectedItems([key]);
    }
    lastSelectedRef.current = key;
  }

  function selectColumnFolder(folder: CloudFolder, columnIndex: number) {
    setActiveLocation("drive");
    setPreview({ file: null, status: "idle" });
    setSelectedItems([`folder:${folder.id}`]);
    lastSelectedRef.current = `folder:${folder.id}`;
    setBreadcrumbs((previous) => [...previous.slice(0, columnIndex + 1), { id: folder.id, name: folder.name }]);
  }

  function selectColumnFile(file: CloudFile, columnIndex: number) {
    setActiveLocation("drive");
    setBreadcrumbs((previous) => previous.slice(0, columnIndex + 1));
    setSelectedItems([`file:${file.id}`]);
    lastSelectedRef.current = `file:${file.id}`;
    void selectFile(file);
  }

  async function navigateToFolder(folder: CloudFolder, forcePath = false) {
    setSidebarOpen(false);
    setPreview({ file: null, status: "idle" });
    setQuery("");
    if (!forcePath && activeLocation === "drive" && !query.trim() && folder.parent_id === currentFolderId) {
      setBreadcrumbs((previous) => [...previous, { id: folder.id, name: folder.name }]);
      return;
    }
    try {
      const response = await authFetch(`/api/folders/path?id=${folder.id}`);
      const data = await parseApiResponse<{ path: Array<{ id: string; name: string }> }>(response);
      setActiveLocation("drive");
      setBreadcrumbs([ROOT_BREADCRUMB, ...data.path.map((item) => ({ id: item.id, name: item.name }))]);
      setSelectedItems([]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "폴더를 열지 못했습니다.");
    }
  }

  async function runTrashAction(type: "file" | "folder", id: string, action: "restore" | "delete") {
    try {
      const response = await authFetch("/api/trash", {
        body: JSON.stringify({ action, id, type }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      await parseApiResponse<{ ok: boolean }>(response);
      await loadListing(currentFolderId);
      setNotice(action === "restore" ? "원래 위치로 복원했습니다." : "항목을 영구 삭제했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "휴지통 작업을 완료하지 못했습니다.");
    }
  }

  async function emptyTrash() {
    if (!window.confirm("휴지통의 항목을 모두 영구 삭제할까요?")) return;
    try {
      const response = await authFetch("/api/trash", { method: "DELETE" });
      await parseApiResponse<{ ok: boolean }>(response);
      await loadListing(currentFolderId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "휴지통을 비우지 못했습니다.");
    }
  }

  async function setTags(type: "file" | "folder", id: string, tags: string[]) {
    try {
      const response = await authFetch("/api/tags", {
        body: JSON.stringify({ id, tags, type }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH"
      });
      await parseApiResponse<{ ok: boolean }>(response);
      await loadListing(currentFolderId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "태그를 저장하지 못했습니다.");
    }
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) {
      return;
    }

    setBusyLabel("폴더 생성 중");
    setNotice(null);

    try {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");

      const response = await authFetch("/api/folders", {
        body: JSON.stringify({
          name,
          parentId: currentFolderId
        }),
        headers,
        method: "POST"
      });

      const data = await parseApiResponse<{ folder: CloudFolder }>(response);
      setNewFolderName("");
      setFolders((previous) => upsertSortedById(previous, data.folder));
    } catch (error) {
      const message = error instanceof Error ? error.message : "폴더를 만들지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function uploadFiles(
    fileList: FileList | null,
    targetFolderId: string | null = currentFolderId
  ) {
    if (!fileList?.length) {
      return;
    }

    if (!session) {
      setNotice("로그인이 필요합니다.");
      return;
    }

    const selected = Array.from(fileList);
    setBusyLabel(`${selected.length}개 파일 업로드 중`);
    setNotice(null);

    try {
      const uploadedFiles: CloudFile[] = [];

      for (const [index, file] of selected.entries()) {
        const resumeKey = `personal-cloud-upload:${targetFolderId ?? "root"}:${file.name}:${file.size}:${file.lastModified}`;
        let uploadId = window.localStorage.getItem(resumeKey);
        let offset = 0;
        if (uploadId) {
          const status = await authFetch(`/api/uploads/${uploadId}`);
          if (status.ok) {
            offset = (await status.json() as { offset: number }).offset;
          } else {
            uploadId = null;
            window.localStorage.removeItem(resumeKey);
          }
        }
        if (!uploadId) {
          const start = await authFetch("/api/uploads", {
            body: JSON.stringify({ folderId: targetFolderId, mimeType: file.type, name: file.name, sizeBytes: file.size }),
            headers: { "Content-Type": "application/json" },
            method: "POST"
          });
          const started = await parseApiResponse<{ uploadId: string; offset: number }>(start);
          uploadId = started.uploadId;
          offset = started.offset;
          window.localStorage.setItem(resumeKey, uploadId);
        }
        while (offset < file.size) {
          const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
          setBusyLabel(`${index + 1}/${selected.length} 업로드 중 · ${Math.floor((offset / Math.max(file.size, 1)) * 100)}%`);
          const chunkResponse = await authFetch(`/api/uploads/${uploadId}`, {
            body: file.slice(offset, end),
            headers: { "Upload-Offset": String(offset) },
            method: "PUT"
          });
          const chunk = await parseApiResponse<{ offset: number }>(chunkResponse);
          offset = chunk.offset;
        }
        setBusyLabel(`${index + 1}/${selected.length} 업로드 마무리 중`);
        const finish = await authFetch(`/api/uploads/${uploadId}`, { method: "POST" });
        const data = await parseApiResponse<{ file: CloudFile }>(finish);
        window.localStorage.removeItem(resumeKey);
        uploadedFiles.push(data.file);
      }

      if (targetFolderId === currentFolderId) {
        setFiles((previous) => sortByName([...previous, ...uploadedFiles]));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "업로드에 실패했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function selectFile(file: CloudFile) {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreview({ file, status: "loading" });

    try {
      const response = await authFetch(`/api/files/${file.id}/preview`);
      const data = await parseApiResponse<PreviewResponse>(response);
      let document: DocxPreview | undefined;
      let spreadsheet: SpreadsheetPreview | undefined;
      let text: string | undefined;

      if (data.kind === "text") {
        const textResponse = await authFetch(data.url);
        if (!textResponse.ok) {
          throw new Error("문서 내용을 불러오지 못했습니다.");
        }
        text = await textResponse.text();
      }

      if (data.kind === "document") {
        const documentResponse = await authFetch(data.url);
        if (!documentResponse.ok) {
          throw new Error("Word 내용을 불러오지 못했습니다.");
        }

        document = await parseDocxPreview(await documentResponse.arrayBuffer());
      }

      if (data.kind === "spreadsheet") {
        const spreadsheetResponse = await authFetch(data.url);
        if (!spreadsheetResponse.ok) {
          throw new Error("Excel 내용을 불러오지 못했습니다.");
        }

        spreadsheet = await parseXlsxPreview(await spreadsheetResponse.arrayBuffer());
      }

      if (previewRequestRef.current !== requestId) {
        return;
      }

      setPreview({
        document,
        file,
        kind: data.kind,
        spreadsheet,
        status: "ready",
        text,
        url: data.url
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "미리보기를 열지 못했습니다.";
      setPreview({ file, message, status: "error" });
    }
  }

  function downloadFile(file: CloudFile) {
    const anchor = document.createElement("a");
    anchor.href = `/api/files/${file.id}/download`;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function downloadZip(items: Array<{ type: "file" | "folder"; id: string }>) {
    setBusyLabel("압축 파일 준비 중");
    try {
      const response = await authFetch("/api/download-zip", {
        body: JSON.stringify({ items }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? "압축 파일을 만들지 못했습니다.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = items.length === 1 ? `${folders.find((folder) => folder.id === items[0].id)?.name ?? "선택한 항목"}.zip` : "선택한 항목.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "압축 파일을 만들지 못했습니다.");
    } finally {
      setBusyLabel(null);
    }
  }

  async function createShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shareTarget) return;
    try {
      const response = await authFetch("/api/shares", {
        body: JSON.stringify({
          expiresAt: shareExpires ? new Date(shareExpires).toISOString() : null,
          id: shareTarget.id,
          password: sharePassword,
          permission: sharePermission,
          type: shareTarget.type
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const data = await parseApiResponse<{ url: string }>(response);
      setShareUrl(data.url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "공유 링크를 만들지 못했습니다.");
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setNotice("공유 링크를 복사했습니다.");
  }

  function downloadSelected() {
    const entries = selectedItems.map((item) => {
      const [type, id] = item.split(":");
      return { id, type: type as "file" | "folder" };
    });
    if (entries.length === 1 && entries[0].type === "file") {
      const file = files.find((item) => item.id === entries[0].id);
      if (file) downloadFile(file);
      return;
    }
    void downloadZip(entries);
  }

  async function renameFolder(folder: CloudFolder) {
    const name = window.prompt("폴더 이름", folder.name)?.trim();
    if (!name || name === folder.name) {
      return;
    }

    setBusyLabel("폴더 이름 변경 중");

    try {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      const response = await authFetch(`/api/folders/${folder.id}`, {
        body: JSON.stringify({ name }),
        headers,
        method: "PATCH"
      });
      const data = await parseApiResponse<{ folder: CloudFolder }>(response);
      setFolders((previous) => upsertSortedById(previous, data.folder));
      setBreadcrumbs((previous) =>
        previous.map((crumb) =>
          crumb.id === folder.id ? { ...crumb, name: data.folder.name } : crumb
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "폴더 이름을 바꾸지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function deleteFolder(folder: CloudFolder) {
    if (!window.confirm(`'${folder.name}' 폴더를 삭제할까요? 빈 폴더만 삭제됩니다.`)) {
      return;
    }

    setBusyLabel("폴더 삭제 중");

    try {
      const response = await authFetch(`/api/folders/${folder.id}`, {
        method: "DELETE"
      });
      await parseApiResponse<{ ok: boolean }>(response);
      setFolders((previous) => previous.filter((current) => current.id !== folder.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "폴더를 삭제하지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function renameFile(file: CloudFile) {
    const name = window.prompt("파일 이름", file.name)?.trim();
    if (!name || name === file.name) {
      return;
    }

    setBusyLabel("파일 이름 변경 중");

    try {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      const response = await authFetch(`/api/files/${file.id}`, {
        body: JSON.stringify({ name }),
        headers,
        method: "PATCH"
      });
      const data = await parseApiResponse<{ file: CloudFile }>(response);
      setFiles((previous) => upsertSortedById(previous, data.file));
      if (preview.file?.id === file.id) {
        void selectFile(data.file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "파일 이름을 바꾸지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function deleteFile(file: CloudFile) {
    if (!window.confirm(`'${file.name}' 파일을 삭제할까요?`)) {
      return;
    }

    setBusyLabel("파일 삭제 중");

    try {
      const response = await authFetch(`/api/files/${file.id}`, {
        method: "DELETE"
      });
      await parseApiResponse<{ ok: boolean }>(response);
      if (preview.file?.id === file.id) {
        setPreview({ file: null, status: "idle" });
      }
      setFiles((previous) => previous.filter((current) => current.id !== file.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "파일을 삭제하지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function moveFileToFolder(fileId: string, targetFolderId: string | null) {
    const file = files.find((current) => current.id === fileId);
    if (!file || file.folder_id === targetFolderId) {
      return;
    }

    setBusyLabel("파일 이동 중");
    setNotice(null);

    try {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      const response = await authFetch(`/api/files/${fileId}`, {
        body: JSON.stringify({ folderId: targetFolderId }),
        headers,
        method: "PATCH"
      });
      const data = await parseApiResponse<{ file: CloudFile }>(response);

      setFiles((previous) =>
        data.file.folder_id === currentFolderId
          ? upsertSortedById(previous, data.file)
          : previous.filter((current) => current.id !== fileId)
      );

      if (preview.file?.id === fileId) {
        setPreview({ file: null, status: "idle" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "파일을 이동하지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function moveFolderToFolder(folderId: string, targetFolderId: string | null) {
    const folder = folders.find((current) => current.id === folderId);
    if (!folder || folder.parent_id === targetFolderId || folderId === targetFolderId) return;
    try {
      const response = await authFetch(`/api/folders/${folderId}`, {
        body: JSON.stringify({ parentId: targetFolderId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH"
      });
      const data = await parseApiResponse<{ folder: CloudFolder }>(response);
      setFolders((previous) => data.folder.parent_id === currentFolderId
        ? upsertSortedById(previous, data.folder)
        : previous.filter((current) => current.id !== folderId));
      setNotice("폴더를 이동했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "폴더를 이동하지 못했습니다.");
    }
  }

  function hasFolderDropData(event: DragEvent<HTMLElement>) {
    const types = Array.from(event.dataTransfer.types);
    return types.includes(FILE_DRAG_DATA_TYPE) || types.includes(FOLDER_DRAG_DATA_TYPE) || types.includes("Files");
  }

  function handleFolderDragStart(event: DragEvent<HTMLElement>, folder: CloudFolder) {
    event.dataTransfer.effectAllowed = "move";
    const draggedIds = selectedItems.includes(`folder:${folder.id}`)
      ? selectedItems.filter((item) => item.startsWith("folder:")).map((item) => item.slice(7))
      : [folder.id];
    event.dataTransfer.setData(FOLDER_DRAG_DATA_TYPE, JSON.stringify(draggedIds));
    setDraggedFileId(null);
  }

  function handleFileDragStart(event: DragEvent<HTMLElement>, file: CloudFile) {
    if (busyLabel) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    const draggedIds = selectedItems.includes(`file:${file.id}`)
      ? selectedItems.filter((item) => item.startsWith("file:")).map((item) => item.slice(5))
      : [file.id];
    event.dataTransfer.setData(FILE_DRAG_DATA_TYPE, JSON.stringify(draggedIds));
    event.dataTransfer.setData("text/plain", file.name);
    setDraggedFileId(file.id);
  }

  function handleFileDragEnd() {
    setDraggedFileId(null);
    setDropTargetKey(null);
  }

  function handleFolderDragOver(event: DragEvent<HTMLElement>, targetFolderId: string | null) {
    if (busyLabel || !hasFolderDropData(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types).includes("Files")
      ? "copy"
      : "move";
    setDropTargetKey(getDropTargetKey(targetFolderId));
  }

  function handleFolderDragLeave(event: DragEvent<HTMLElement>, targetFolderId: string | null) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    const targetKey = getDropTargetKey(targetFolderId);
    setDropTargetKey((current) => (current === targetKey ? null : current));
  }

  async function handleFolderDrop(event: DragEvent<HTMLElement>, targetFolderId: string | null) {
    if (busyLabel || !hasFolderDropData(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDropTargetKey(null);

    const appFileIds = event.dataTransfer.getData(FILE_DRAG_DATA_TYPE);
    if (appFileIds) {
      let ids: string[];
      try {
        const parsed = JSON.parse(appFileIds) as unknown;
        ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [appFileIds];
      } catch {
        ids = [appFileIds];
      }
      for (const id of ids) await moveFileToFolder(id, targetFolderId);
      return;
    }

    const appFolderIds = event.dataTransfer.getData(FOLDER_DRAG_DATA_TYPE);
    if (appFolderIds) {
      let ids: string[];
      try {
        const parsed = JSON.parse(appFolderIds) as unknown;
        ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [appFolderIds];
      } catch {
        ids = [appFolderIds];
      }
      for (const id of ids) await moveFolderToFolder(id, targetFolderId);
      return;
    }

    if (event.dataTransfer.files.length > 0) {
      await uploadFiles(event.dataTransfer.files, targetFolderId);
    }
  }

  function startPreviewResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    previewResizeRef.current = {
      startWidth: previewWidth,
      startX: event.clientX
    };
    setResizingPreview(true);
  }

  function openFolder(folder: CloudFolder) {
    void navigateToFolder(folder);
  }

  async function pasteClipboard() {
    if (!clipboardItem || clipboardItem.type !== "file") {
      setNotice("파일을 선택해 복사한 뒤 폴더 안에서 붙여넣으세요.");
      return;
    }
    const response = await authFetch(`/api/files/${clipboardItem.id}/copy`, {
      body: JSON.stringify({ folderId: currentFolderId }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
    try {
      const data = await parseApiResponse<{ file: CloudFile }>(response);
      setClipboardItem(null);
      setFiles((previous) => upsertSortedById(previous, data.file));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "붙여넣지 못했습니다.");
    }
  }

  function showInfo(type: "file" | "folder", id: string) {
    const file = type === "file" ? files.find((item) => item.id === id) : undefined;
    const folder = type === "folder" ? folders.find((item) => item.id === id) : undefined;
    if (file) setInfoItem({ name: file.name, type: file.mime_type || "파일", size: file.size_bytes, updated_at: file.updated_at });
    if (folder) setInfoItem({ name: folder.name, type: "폴더", updated_at: folder.updated_at });
  }

  useEffect(() => {
    function handleShortcuts(event: globalThis.KeyboardEvent) {
      if (!session) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      const itemFocused = target instanceof HTMLElement && Boolean(target.closest("[data-item-key]"));
      if (event.key === "Escape") {
        setContextMenu(null);
        setInfoItem(null);
        return;
      }
      if (typing || (itemFocused && ["Enter", " "].includes(event.key))) return;
      const modifier = event.ctrlKey || event.metaKey;
      const selected = selectedItems[0];
      const [type, id] = selected?.split(":") ?? [];
      if (modifier && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedItems([
          ...filteredFolders.map((folder) => `folder:${folder.id}`),
          ...filteredFiles.map((file) => `file:${file.id}`)
        ]);
      } else if (modifier && event.key.toLowerCase() === "o") {
        event.preventDefault();
        fileInputRef.current?.click();
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        folderInputRef.current?.focus();
      } else if (modifier && event.key.toLowerCase() === "i" && selected) {
        event.preventDefault();
        showInfo(type as "file" | "folder", id);
      } else if (modifier && event.key.toLowerCase() === "c" && selected) {
        event.preventDefault();
        setClipboardItem({ type: type as "file" | "folder", id });
      } else if (modifier && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selected) {
        event.preventDefault();
        for (const item of selectedItems) {
          const [itemType, itemId] = item.split(":");
          if (activeLocation === "trash") void runTrashAction(itemType as "file" | "folder", itemId, "delete");
          else if (itemType === "file") { const file = files.find((entry) => entry.id === itemId); if (file) void deleteFile(file); }
          else { const folder = folders.find((entry) => entry.id === itemId); if (folder) void deleteFolder(folder); }
        }
      } else if (event.key === "F2" && selected) {
        event.preventDefault();
        if (type === "file") void renameFile(files.find((file) => file.id === id)!);
        if (type === "folder") void renameFolder(folders.find((folder) => folder.id === id)!);
      } else if (event.key === " " && type === "file" && activeLocation !== "trash") {
        event.preventDefault();
        const file = files.find((item) => item.id === id);
        if (file) void selectFile(file);
      } else if (event.key === " " && type === "folder" && activeLocation !== "trash") {
        event.preventDefault();
        const folder = folders.find((item) => item.id === id);
        if (folder) void navigateToFolder(folder);
      } else if (event.key === "Enter" && type === "folder" && activeLocation !== "trash") {
        event.preventDefault();
        const folder = folders.find((item) => item.id === id);
        if (folder) void renameFolder(folder);
      } else if (event.key === "Enter" && type === "file" && activeLocation !== "trash") {
        event.preventDefault();
        const file = files.find((item) => item.id === id);
        if (file) void renameFile(file);
      }
    }
    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, [activeLocation, files, filteredFiles, filteredFolders, folders, selectedItems, session]);

  if (authLoading) {
    return (
      <main className="auth-page">
        <section className="auth-panel compact">
          <Loader2 aria-hidden="true" className="spin auth-logo" />
          <h1>내 클라우드</h1>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <Image
            alt=""
            aria-hidden="true"
            className="auth-brand-icon"
            height={52}
            src="/brand-icon.png"
            width={52}
          />
          <h1>내 클라우드</h1>
          <form onSubmit={handleAuthSubmit} className="auth-form">
            <label>
              아이디
              <input
                autoComplete="username"
                autoCapitalize="none"
                onChange={(event) => setUsername(event.target.value)}
                required
                spellCheck={false}
                type="text"
                value={username}
              />
            </label>
            <label>
              비밀번호
              <input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {authMessage ? <p className="auth-error">{authMessage}</p> : null}
            <button className="primary-button" disabled={authSubmitting} type="submit">
              {authSubmitting ? <Loader2 aria-hidden="true" className="spin" /> : null}
              로그인
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${resizingPreview ? "is-resizing-preview" : ""} ${viewMode === "gallery" ? "gallery-mode" : ""}`}
      style={{ "--preview-width": `${previewWidth}px` } as CSSProperties}
    >
      <input
        multiple
        onChange={(event: ChangeEvent<HTMLInputElement>) => void uploadFiles(event.target.files)}
        ref={fileInputRef}
        type="file"
        className="hidden-input"
      />

      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <button aria-label="사이드바 닫기" className="sidebar-dismiss" onClick={() => setSidebarOpen(false)} type="button"><X aria-hidden="true" /></button>
        <div className="brand-row">
          <div className="brand-icon">
            <Image
              alt=""
              aria-hidden="true"
              height={44}
              src="/brand-icon.png"
              width={44}
            />
          </div>
          <div>
            <strong>내 클라우드</strong>
          <span>{session.username}</span>
          </div>
        </div>

        <nav aria-label="Finder 위치" className="finder-sidebar-nav">
          <section className="sidebar-section">
            <h2>즐겨찾기</h2>
            <button className={activeLocation === "drive" && !currentFolderId ? "sidebar-link active" : "sidebar-link"} onClick={() => setLocation("drive")} type="button">
              <Home aria-hidden="true" /> 내 드라이브
            </button>
            {favorites.map((favorite) => (
              <button className="sidebar-link" key={favorite.id} onClick={() => void navigateToFolder({ ...favorite, parent_id: null, created_at: "", updated_at: "" }, true)} type="button">
                <Star aria-hidden="true" /> {favorite.name}
              </button>
            ))}
          </section>
          <section className="sidebar-section">
            <h2>위치</h2>
            <button className={activeLocation === "recents" ? "sidebar-link active" : "sidebar-link"} onClick={() => setLocation("recents")} type="button">
              <RefreshCcw aria-hidden="true" /> 최근 항목
            </button>
            <button className={activeLocation === "trash" ? "sidebar-link active" : "sidebar-link"} onClick={() => setLocation("trash")} type="button">
              <Trash2 aria-hidden="true" /> 휴지통
            </button>
          </section>
          <section className="sidebar-section tags-section">
            <h2>태그</h2>
            {[
              ["red", "빨강"], ["orange", "주황"], ["yellow", "노랑"],
              ["green", "초록"], ["blue", "파랑"], ["purple", "보라"], ["gray", "회색"]
            ].map(([color, label]) => (
              <button className={activeLocation === "tag" && activeTag === color ? "sidebar-link tag-link active" : "sidebar-link tag-link"} key={color} onClick={() => setLocation("tag", color)} type="button">
                <span className={`tag-dot tag-${color}`} /> {label}
              </button>
            ))}
          </section>
        </nav>

        <div className="sidebar-actions">
          <form className="folder-form" onSubmit={createFolder}>
            <label htmlFor="folder-name">새 폴더</label>
            <div className="inline-control">
              <input
                id="folder-name"
                maxLength={80}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder="폴더 이름"
                ref={folderInputRef}
                value={newFolderName}
              />
              <button aria-label="폴더 만들기" className="icon-button" disabled={Boolean(busyLabel)} title="폴더 만들기" type="submit">
                <FolderPlus aria-hidden="true" />
              </button>
            </div>
          </form>
          <button className="wide-button" disabled={Boolean(busyLabel)} onClick={() => fileInputRef.current?.click()} type="button">
            <Upload aria-hidden="true" /> 업로드
          </button>
        </div>

        <div className="storage-summary">
          <div><span>저장 공간</span><strong>{storageUsage.quotaBytes ? `${formatFileSize(storageUsage.usedBytes)} / ${formatFileSize(storageUsage.quotaBytes)}` : "-"}</strong></div>
          <div className="storage-meter"><span style={{ width: `${storageUsage.quotaBytes ? Math.min(100, (storageUsage.usedBytes / storageUsage.quotaBytes) * 100) : 0}%` }} /></div>
        </div>

        <button className="signout-button" onClick={() => void handleSignOut()} type="button">
          <LogOut aria-hidden="true" />
          로그아웃
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button aria-label="사이드바 열기" className="mobile-sidebar-toggle icon-button compact" onClick={() => setSidebarOpen(true)} type="button"><List aria-hidden="true" /></button>
          <div className="history-controls">
            <button aria-label="상위 폴더" className="icon-button compact" disabled={breadcrumbs.length <= 1 || activeLocation !== "drive"} onClick={() => { setBreadcrumbs((previous) => previous.slice(0, -1)); setSelectedItems([]); }} title="상위 폴더" type="button"><ArrowLeft aria-hidden="true" /></button>
            <button aria-label="즐겨찾기 추가" className={`icon-button compact ${currentFolderId && favorites.some((item) => item.id === currentFolderId) ? "is-favorite" : ""}`} disabled={!currentFolderId} onClick={() => {
              const current = breadcrumbs[breadcrumbs.length - 1];
              if (!current?.id) return;
              const currentId = current.id;
              setFavorites((previous) => previous.some((item) => item.id === currentId) ? previous.filter((item) => item.id !== currentId) : [...previous, { id: currentId, name: current.name }]);
            }} title="즐겨찾기 추가" type="button"><Star aria-hidden="true" /></button>
          </div>
          <nav aria-label="현재 경로" className="breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span className="breadcrumb-item" key={`${crumb.id ?? "root"}-${index}`}>
                {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
                <button
                  className={
                    dropTargetKey === getDropTargetKey(crumb.id) ? "drop-target" : undefined
                  }
                  onDragLeave={(event) => handleFolderDragLeave(event, crumb.id)}
                  onDragOver={(event) => handleFolderDragOver(event, crumb.id)}
                  onDrop={(event) => void handleFolderDrop(event, crumb.id)}
                  onClick={() => {
                    setPreview({ file: null, status: "idle" });
                    setActiveLocation("drive");
                    setBreadcrumbs((previous) => previous.slice(0, index + 1));
                  }}
                  type="button"
                >
                  {index === 0 ? <Home aria-hidden="true" /> : null}
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          <div className="toolbar">
            <div aria-label="보기 방식" className="view-switcher" role="group">
              <button aria-label="아이콘 보기" aria-pressed={viewMode === "icons"} className={viewMode === "icons" ? "selected" : ""} onClick={() => setViewMode("icons")} title="아이콘 보기" type="button"><Grid2x2 aria-hidden="true" /></button>
              <button aria-label="목록 보기" aria-pressed={viewMode === "list"} className={viewMode === "list" ? "selected" : ""} onClick={() => setViewMode("list")} title="목록 보기" type="button"><List aria-hidden="true" /></button>
              <button aria-label="단계별 보기" aria-pressed={viewMode === "columns"} className={viewMode === "columns" ? "selected" : ""} onClick={() => setViewMode("columns")} title="단계별 보기" type="button"><Columns3 aria-hidden="true" /></button>
              <button aria-label="갤러리 보기" aria-pressed={viewMode === "gallery"} className={viewMode === "gallery" ? "selected" : ""} onClick={() => setViewMode("gallery")} title="갤러리 보기" type="button"><Images aria-hidden="true" /></button>
            </div>
            {viewMode === "icons" ? <label className="thumb-size-control" title="아이콘 크기"><input aria-label="아이콘 크기" max="120" min="48" onChange={(event) => setThumbSize(Number(event.target.value))} type="range" value={thumbSize} /></label> : null}
            <select aria-label="정렬 기준" className="sort-control" onChange={(event) => setSortKey(event.target.value as SortKey)} value={sortKey}>
              <option value="name">이름순</option><option value="modified">수정일순</option><option value="size">크기순</option>
            </select>
            <label className="search-box">
              <Search aria-hidden="true" />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="검색"
                value={query}
              />
              <select aria-label="검색 범위" onChange={(event) => setSearchScope(event.target.value as "current" | "all")} value={searchScope}>
                <option value="current">현재 폴더</option>
                <option value="all">전체</option>
              </select>
            </label>
            <button
              aria-label="새로고침"
              className="icon-button"
              disabled={listingLoading}
              onClick={() => void loadListing(currentFolderId)}
              title="새로고침"
              type="button"
            >
              <RefreshCcw aria-hidden="true" className={listingLoading ? "spin" : undefined} />
            </button>
            <button
              aria-label="파일 업로드"
              className="icon-button accent"
              disabled={Boolean(busyLabel)}
              onClick={() => fileInputRef.current?.click()}
              title="파일 업로드"
              type="button"
            >
              <Upload aria-hidden="true" />
            </button>
            {selectedItems.length ? <button aria-label="선택한 항목 다운로드" className="icon-button compact" onClick={downloadSelected} title="다운로드 또는 압축" type="button"><Download aria-hidden="true" /></button> : null}
            {selectedItems.length === 1 && activeLocation !== "trash" ? <button aria-label="공유" className="icon-button compact" onClick={() => { const [type, id] = selectedItems[0].split(":"); setShareTarget({ type: type as "file" | "folder", id }); setShareUrl(""); }} title="공유" type="button"><Share2 aria-hidden="true" /></button> : null}
            {activeLocation === "trash" ? <button className="text-button compact-text" onClick={() => void emptyTrash()} type="button">휴지통 비우기</button> : null}
          </div>
        </header>

        {notice || busyLabel ? (
          <div className={notice ? "notice error" : "notice"}>
            {busyLabel ? (
              <>
                <Loader2 aria-hidden="true" className="spin" />
                {busyLabel}
              </>
            ) : (
              notice
            )}
          </div>
        ) : null}

        <section className="browser-surface">
          <div className="surface-heading">
            <div>
              <h1>{activeLocation === "trash" ? "휴지통" : activeLocation === "recents" ? "최근 항목" : activeLocation === "tag" ? `${activeTag} 태그` : breadcrumbs[breadcrumbs.length - 1]?.name}</h1>
              <span>
                {selectedItems.length ? `${selectedItems.length}개 선택됨 · ` : ""}{filteredFolders.length + filteredFiles.length}개 항목
              </span>
            </div>
            {activeLocation !== "trash" ? <button aria-label="정보 가져오기" className="icon-button compact" onClick={() => {
              const selected = selectedItems[0];
              if (!selected) return;
              const [type, id] = selected.split(":");
              const folder = type === "folder" ? folders.find((item) => item.id === id) : null;
              const file = type === "file" ? files.find((item) => item.id === id) : null;
              if (folder) setInfoItem({ name: folder.name, type: "폴더", updated_at: folder.updated_at });
              if (file) setInfoItem({ name: file.name, type: file.mime_type, size: file.size_bytes, updated_at: file.updated_at });
            }} title="정보 가져오기" type="button"><Info aria-hidden="true" /></button> : null}
          </div>

          {listingLoading ? (
            <div className="loading-state">
              <Loader2 aria-hidden="true" className="spin" />
            </div>
          ) : filteredFolders.length === 0 && filteredFiles.length === 0 ? (
            <div className="empty-state">비어 있음</div>
          ) : viewMode === "gallery" ? (
            <GalleryBrowser
              items={galleryItems}
              onFileClick={(file) => { setSelectedItems([`file:${file.id}`]); lastSelectedRef.current = `file:${file.id}`; void selectFile(file); }}
              onFolderClick={(folder) => { setSelectedItems([`folder:${folder.id}`]); lastSelectedRef.current = `folder:${folder.id}`; setPreview({ file: null, status: "idle" }); }}
              preview={preview}
              selectedItems={selectedItems}
            />
          ) : (
            <>
            {viewMode === "list" ? <div className="list-column-head"><button onClick={() => { setSortKey("name"); setSortDescending((value) => sortKey === "name" ? !value : false); }} type="button">이름</button><button onClick={() => { setSortKey("modified"); setSortDescending((value) => sortKey === "modified" ? !value : true); }} type="button">수정일</button><button onClick={() => { setSortKey("size"); setSortDescending((value) => sortKey === "size" ? !value : false); }} type="button">크기</button><span>종류</span></div> : null}
            {viewMode === "columns" ? (
              <ColumnBrowser
                breadcrumbs={breadcrumbs}
                columns={columnData}
                loading={activeLocation === "drive" && !query.trim() && columnListings.length === 0}
                onFileClick={selectColumnFile}
                onFolderClick={selectColumnFolder}
                previewFileId={preview.file?.id ?? null}
              />
            ) : (
            <div
              className={`items-grid items-${viewMode} ${virtualized ? "is-virtualized" : ""}`}
              onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSelectionBox({ startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY });
              }}
              onScroll={(event) => setGridViewport({ height: event.currentTarget.clientHeight, scrollTop: event.currentTarget.scrollTop, width: event.currentTarget.clientWidth })}
              ref={itemsViewportRef}
              style={{ "--tile-size": `${thumbSize}px`, "--virtual-columns": columnCount, height: virtualized ? `${Math.ceil(totalVisibleItems / columnCount) * rowHeight}px` : undefined } as CSSProperties}
            >
              {selectionBox ? <div aria-hidden="true" className="selection-rectangle" style={{ left: Math.min(selectionBox.startX, selectionBox.x), top: Math.min(selectionBox.startY, selectionBox.y), width: Math.abs(selectionBox.x - selectionBox.startX), height: Math.abs(selectionBox.y - selectionBox.startY) }} /> : null}
              {visibleFolderItems.map(({ folder, index }) => (
                <article
                  aria-selected={selectedItems.includes(`folder:${folder.id}`)}
                  data-item-key={`folder:${folder.id}`}
                  style={getVirtualStyle(index)}
                  className={`item-tile folder-tile ${
                    dropTargetKey === getDropTargetKey(folder.id) ? "drop-target" : ""
                  } ${selectedItems.includes(`folder:${folder.id}`) ? "is-selected" : ""}`}
                  key={folder.id}
                  draggable={!busyLabel && activeLocation !== "trash"}
                  onDragStart={(event) => handleFolderDragStart(event, folder)}
                  onDragEnd={handleFileDragEnd}
                  onDragLeave={(event) => handleFolderDragLeave(event, folder.id)}
                  onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                  onDrop={(event) => void handleFolderDrop(event, folder.id)}
                  onClick={(event) => selectItem("folder", folder.id, event)}
                    onDoubleClick={() => activeLocation !== "trash" && openFolder(folder)}
                  onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, type: "folder", id: folder.id }); }}
                >
                  <button
                    className="tile-main"
                    onClick={(event) => { event.stopPropagation(); selectItem("folder", folder.id, event); }}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void renameFolder(folder); } else if (event.key === " ") { event.preventDefault(); if (activeLocation !== "trash") openFolder(folder); } }}
                    type="button"
                  >
                    <span className="tile-icon folder-icon">
                      <Folder aria-hidden="true" />
                    </span>
                    <span className="tile-copy">
                      <strong onDoubleClick={(event) => { event.stopPropagation(); if (activeLocation !== "trash") void renameFolder(folder); }} title={folder.name}>{folder.name}</strong>
                      <span>{viewMode === "list" ? formatDate(folder.updated_at) : formatDate(folder.updated_at)}</span>
                    </span>
                  </button>
                  <div className="tile-actions">
                    {activeLocation === "trash" ? <>
                      <button aria-label="폴더 복원" className="mini-icon-button" onClick={() => void runTrashAction("folder", folder.id, "restore")} title="복원" type="button"><RotateCcw aria-hidden="true" /></button>
                      <button aria-label="폴더 영구 삭제" className="mini-icon-button danger" onClick={() => void runTrashAction("folder", folder.id, "delete")} title="영구 삭제" type="button"><Trash2 aria-hidden="true" /></button>
                    </> : <>
                      <button aria-label="폴더 이름 변경" className="mini-icon-button" onClick={() => void renameFolder(folder)} title="이름 변경" type="button"><Pencil aria-hidden="true" /></button>
                      <button aria-label="폴더를 휴지통으로 이동" className="mini-icon-button danger" onClick={() => void deleteFolder(folder)} title="휴지통으로 이동" type="button"><Trash2 aria-hidden="true" /></button>
                    </>}
                  </div>
                  {viewMode === "list" ? <><span className="list-date">{formatDate(folder.updated_at)}</span><span className="list-size">-</span><span className="list-kind">폴더</span></> : null}
                </article>
              ))}

              {visibleFileItems.map(({ file, index }) => (
                <article
                  aria-selected={selectedItems.includes(`file:${file.id}`)}
                  data-item-key={`file:${file.id}`}
                  style={getVirtualStyle(index)}
                  className={`item-tile file-tile ${
                    preview.file?.id === file.id ? "selected" : ""
                  } ${draggedFileId === file.id ? "dragging" : ""} ${selectedItems.includes(`file:${file.id}`) ? "is-selected" : ""}`}
                  draggable={!busyLabel}
                  key={file.id}
                  onDragEnd={handleFileDragEnd}
                  onDragStart={(event) => handleFileDragStart(event, file)}
                  onClick={(event) => selectItem("file", file.id, event)}
                  onDoubleClick={() => activeLocation !== "trash" && void selectFile(file)}
                  onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, type: "file", id: file.id }); }}
                >
                  <button
                    className="tile-main"
                    onClick={(event) => { event.stopPropagation(); selectItem("file", file.id, event); if (activeLocation !== "trash") void selectFile(file); }}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (activeLocation !== "trash") void renameFile(file); } else if (event.key === " ") { event.preventDefault(); if (activeLocation !== "trash") void selectFile(file); } }}
                    type="button"
                  >
                    <span className="tile-icon file-icon">
                      {viewMode !== "list" && getPreviewKind(file.mime_type, file.name) === "image"
                        ? <img alt="" className="tile-thumbnail" loading="lazy" src={`/api/files/${file.id}/content`} />
                        : <FileKindIcon file={file} />}
                    </span>
                    <span className="tile-copy">
                      <strong onDoubleClick={(event) => { event.stopPropagation(); if (activeLocation !== "trash") void renameFile(file); }} title={file.name}>{file.name}</strong>
                      <span>
                        {formatFileSize(file.size_bytes)} · {formatDate(file.updated_at)}
                      </span>
                    </span>
                  </button>
                  <div className="tile-actions">
                    {activeLocation === "trash" ? <>
                      <button aria-label="파일 복원" className="mini-icon-button" onClick={() => void runTrashAction("file", file.id, "restore")} title="복원" type="button"><RotateCcw aria-hidden="true" /></button>
                      <button aria-label="파일 영구 삭제" className="mini-icon-button danger" onClick={() => void runTrashAction("file", file.id, "delete")} title="영구 삭제" type="button"><Trash2 aria-hidden="true" /></button>
                    </> : <>
                      <button aria-label="다운로드" className="mini-icon-button" onClick={() => void downloadFile(file)} title="다운로드" type="button"><Download aria-hidden="true" /></button>
                      <button aria-label="파일 이름 변경" className="mini-icon-button" onClick={() => void renameFile(file)} title="이름 변경" type="button"><Pencil aria-hidden="true" /></button>
                      <button aria-label="파일을 휴지통으로 이동" className="mini-icon-button danger" onClick={() => void deleteFile(file)} title="휴지통으로 이동" type="button"><Trash2 aria-hidden="true" /></button>
                    </>}
                  </div>
                  {viewMode === "list" ? <><span className="list-date">{formatDate(file.updated_at)}</span><span className="list-size">{formatFileSize(file.size_bytes)}</span><span className="list-kind">{file.mime_type || "파일"}</span></> : null}
                </article>
              ))}
            </div>
            )}
            </>
          )}
          <footer aria-label="경로 및 항목 정보" className="path-status-bar">
            <nav aria-label="경로 막대" className="path-bar">
              {breadcrumbs.map((crumb, index) => <span key={`${crumb.id ?? "root"}-${index}`}>
                {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
                <button onClick={() => { setActiveLocation("drive"); setBreadcrumbs((previous) => previous.slice(0, index + 1)); }} type="button">{crumb.name}</button>
              </span>)}
            </nav>
            <span>{filteredFolders.length + filteredFiles.length}개 항목 · {storageUsage.quotaBytes ? `사용 가능 ${formatFileSize(Math.max(0, storageUsage.quotaBytes - storageUsage.usedBytes))}` : ""}</span>
          </footer>
        </section>
      </section>

      {contextMenu ? <div
        className="finder-context-menu"
        role="menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
      >
        {contextMenu.type === "folder" ? <button role="menuitem" onClick={() => { const folder = folders.find((item) => item.id === contextMenu.id); if (folder) openFolder(folder); setContextMenu(null); }} type="button">열기</button> : null}
        {contextMenu.type === "file" ? <button role="menuitem" onClick={() => { const file = files.find((item) => item.id === contextMenu.id); if (file) void selectFile(file); setContextMenu(null); }} type="button">훑어보기</button> : null}
        {contextMenu.type === "file" ? <button role="menuitem" onClick={() => { const file = files.find((item) => item.id === contextMenu.id); if (file) void downloadFile(file); setContextMenu(null); }} type="button">다운로드</button> : null}
        {contextMenu.type === "folder" && activeLocation !== "trash" ? <button role="menuitem" onClick={() => { void downloadZip([{ type: "folder", id: contextMenu.id }]); setContextMenu(null); }} type="button">폴더 압축 다운로드</button> : null}
        {activeLocation !== "trash" ? <>
          <button role="menuitem" onClick={() => { setClipboardItem({ type: contextMenu.type, id: contextMenu.id }); setContextMenu(null); }} type="button">복사</button>
          {clipboardItem ? <button role="menuitem" onClick={() => { void pasteClipboard(); setContextMenu(null); }} type="button">붙여넣기</button> : null}
          <button role="menuitem" onClick={() => { setContextMenu(null); if (contextMenu.type === "file") { const file = files.find((item) => item.id === contextMenu.id); if (file) void renameFile(file); } else { const folder = folders.find((item) => item.id === contextMenu.id); if (folder) void renameFolder(folder); } }} type="button">이름 변경</button>
          <div aria-label="태그 지정" className="context-tags" role="group">{["red", "orange", "yellow", "green", "blue", "purple", "gray"].map((color) => <button aria-label={`${color} 태그`} className={`tag-dot tag-${color}`} key={color} onClick={() => { const item = contextMenu.type === "file" ? files.find((entry) => entry.id === contextMenu.id) : folders.find((entry) => entry.id === contextMenu.id); const tags = item?.tags ?? []; void setTags(contextMenu.type, contextMenu.id, tags.includes(color) ? tags.filter((tag) => tag !== color) : [...tags, color]); setContextMenu(null); }} type="button" />)}</div>
          <button role="menuitem" onClick={() => { setShareTarget({ type: contextMenu.type, id: contextMenu.id }); setShareUrl(""); setSharePassword(""); setShareExpires(""); setSharePermission("read"); setContextMenu(null); }} type="button">공유…</button>
          <button className="menu-danger" role="menuitem" onClick={() => { if (contextMenu.type === "file") { const file = files.find((item) => item.id === contextMenu.id); if (file) void deleteFile(file); } else { const folder = folders.find((item) => item.id === contextMenu.id); if (folder) void deleteFolder(folder); } setContextMenu(null); }} type="button">휴지통으로 이동</button>
        </> : <>
          <button role="menuitem" onClick={() => { void runTrashAction(contextMenu.type, contextMenu.id, "restore"); setContextMenu(null); }} type="button">복원</button>
          <button className="menu-danger" role="menuitem" onClick={() => { void runTrashAction(contextMenu.type, contextMenu.id, "delete"); setContextMenu(null); }} type="button">영구 삭제</button>
        </>}
        <button className="menu-separator" role="menuitem" onClick={() => { showInfo(contextMenu.type, contextMenu.id); setContextMenu(null); }} type="button">정보 가져오기</button>
      </div> : null}

      {infoItem ? <div className="modal-backdrop" onClick={() => setInfoItem(null)}>
        <section aria-labelledby="info-title" aria-modal="true" className="info-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
          <header><h2 id="info-title">정보</h2><button aria-label="닫기" className="mini-icon-button" onClick={() => setInfoItem(null)} type="button"><X aria-hidden="true" /></button></header>
          <dl><dt>이름</dt><dd>{infoItem.name}</dd><dt>종류</dt><dd>{infoItem.type}</dd>{infoItem.size !== undefined ? <><dt>크기</dt><dd>{formatFileSize(infoItem.size)}</dd></> : null}<dt>수정일</dt><dd>{formatDate(infoItem.updated_at)}</dd><dt>위치</dt><dd>{breadcrumbs.map((crumb) => crumb.name).join(" / ")}</dd></dl>
        </section>
      </div> : null}

      {shareTarget ? <div className="modal-backdrop" onClick={() => setShareTarget(null)}>
        <form aria-labelledby="share-title" aria-modal="true" className="info-dialog share-dialog" onClick={(event) => event.stopPropagation()} onSubmit={createShare} role="dialog">
          <header><h2 id="share-title">공유</h2><button aria-label="닫기" className="mini-icon-button" onClick={() => setShareTarget(null)} type="button"><X aria-hidden="true" /></button></header>
          {shareUrl ? <>
            <p className="share-success">공유 링크가 준비되었습니다.</p>
            <input aria-label="공유 링크" readOnly value={shareUrl} />
            <div className="share-actions"><button className="primary-button" onClick={() => void copyShareUrl()} type="button">링크 복사</button><button className="text-button" onClick={() => setShareTarget(null)} type="button">완료</button></div>
          </> : <>
            <label>권한<select onChange={(event) => setSharePermission(event.target.value as "read" | "edit")} value={sharePermission}><option value="read">읽기 전용</option><option value="edit">편집</option></select></label>
            <label>비밀번호 (선택)<input autoComplete="new-password" maxLength={128} onChange={(event) => setSharePassword(event.target.value)} type="password" value={sharePassword} /></label>
            <label>만료일 (선택)<input onChange={(event) => setShareExpires(event.target.value)} type="datetime-local" value={shareExpires} /></label>
            <button className="primary-button" type="submit">링크 생성</button>
          </>}
        </form>
      </div> : null}

      <PreviewPanel
        onDownload={(file) => void downloadFile(file)}
        onResizePointerDown={startPreviewResize}
        preview={preview}
      />
    </main>
  );
}

function PreviewPanel({
  onDownload,
  onResizePointerDown,
  preview
}: {
  onDownload: (file: CloudFile) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  preview: PreviewState;
}) {
  const file = preview.file;

  return (
    <aside className="preview-panel">
      <button
        aria-label="미리보기 너비 조절"
        className="preview-resizer"
        onPointerDown={onResizePointerDown}
        title="미리보기 너비 조절"
        type="button"
      />
      <div className="preview-header">
        <div>
          <span>미리보기</span>
          <h2 title={file?.name}>{file?.name ?? "선택된 파일 없음"}</h2>
        </div>
        {file ? (
          <button
            aria-label="다운로드"
            className="icon-button"
            onClick={() => onDownload(file)}
            title="다운로드"
            type="button"
          >
            <Download aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="preview-body">{renderPreview(preview)}</div>
    </aside>
  );
}

function ColumnBrowser({
  breadcrumbs,
  columns,
  loading,
  onFileClick,
  onFolderClick,
  previewFileId
}: {
  breadcrumbs: Breadcrumb[];
  columns: FolderListing[];
  loading: boolean;
  onFileClick: (file: CloudFile, columnIndex: number) => void;
  onFolderClick: (folder: CloudFolder, columnIndex: number) => void;
  previewFileId: string | null;
}) {
  if (loading) {
    return <div className="column-view-loading"><Loader2 aria-hidden="true" className="spin" /> 불러오는 중…</div>;
  }

  return (
    <div aria-label="단계별 보기" className="column-view">
      {columns.map((listing, index) => (
        <ColumnPane
          key={`${breadcrumbs[index]?.id ?? "root"}-${index}`}
          listing={listing}
          onFileClick={onFileClick}
          onFolderClick={onFolderClick}
          parentName={breadcrumbs[index]?.name ?? "내 드라이브"}
          previewFileId={previewFileId}
          selectedFolderId={breadcrumbs[index + 1]?.id ?? null}
          columnIndex={index}
        />
      ))}
    </div>
  );
}

function ColumnPane({
  columnIndex,
  listing,
  onFileClick,
  onFolderClick,
  parentName,
  previewFileId,
  selectedFolderId
}: {
  columnIndex: number;
  listing: FolderListing;
  onFileClick: (file: CloudFile, columnIndex: number) => void;
  onFolderClick: (folder: CloudFolder, columnIndex: number) => void;
  parentName: string;
  previewFileId: string | null;
  selectedFolderId: string | null;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 480, scrollTop: 0 });
  const items: GalleryItem[] = [
    ...listing.folders.map((folder) => ({ folder, id: folder.id, kind: "folder" as const, name: folder.name })),
    ...listing.files.map((file) => ({ file, id: file.id, kind: "file" as const, name: file.name }))
  ];
  const rowHeight = 36;
  const virtualized = items.length > 100;
  const start = virtualized ? Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 3) : 0;
  const end = virtualized ? Math.min(items.length, Math.ceil((viewport.scrollTop + viewport.height) / rowHeight) + 3) : items.length;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport({ height: element.clientHeight, scrollTop: element.scrollTop });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [items.length]);

  function renderItem(item: GalleryItem, itemIndex: number) {
    const folder = item.folder;
    const file = item.file;
    const selected = folder ? selectedFolderId === folder.id : previewFileId === file?.id;
    return (
      <button
        aria-current={selected ? "true" : undefined}
        aria-label={`${folder ? "폴더" : "파일"} ${item.name}`}
        className={`column-item ${selected ? "is-selected" : ""}`}
        data-item-key={`${item.kind}:${item.id}`}
        key={`${item.kind}:${item.id}`}
        onClick={() => folder ? onFolderClick(folder, columnIndex) : file && onFileClick(file, columnIndex)}
        onDoubleClick={() => folder ? onFolderClick(folder, columnIndex) : file && onFileClick(file, columnIndex)}
        style={virtualized ? { height: rowHeight, left: 0, position: "absolute", right: 0, top: itemIndex * rowHeight } : undefined}
        title={item.name}
        type="button"
      >
        <span className="column-item-icon">{folder ? <Folder aria-hidden="true" /> : file ? <FileKindIcon file={file} /> : null}</span>
        <span>{item.name}</span>
        {folder ? <ChevronRight aria-hidden="true" className="column-item-chevron" /> : null}
      </button>
    );
  }

  return (
    <section aria-label={`${parentName} 항목`} className="column-pane">
      <h2>{parentName}</h2>
      <div
        className="column-list"
        onScroll={(event) => setViewport({ height: event.currentTarget.clientHeight, scrollTop: event.currentTarget.scrollTop })}
        ref={viewportRef}
      >
        {items.length === 0 ? <span className="column-empty">비어 있음</span> : virtualized ? (
          <div className="column-list-track" style={{ height: items.length * rowHeight }}>
            {items.slice(start, end).map((item, offset) => renderItem(item, start + offset))}
          </div>
        ) : items.map((item, index) => renderItem(item, index))}
      </div>
    </section>
  );
}

function GalleryBrowser({
  items,
  onFileClick,
  onFolderClick,
  preview,
  selectedItems
}: {
  items: GalleryItem[];
  onFileClick: (file: CloudFile) => void;
  onFolderClick: (folder: CloudFolder) => void;
  preview: PreviewState;
  selectedItems: string[];
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 900 });
  const itemWidth = 118;
  const start = Math.max(0, Math.floor(viewport.scrollLeft / itemWidth) - 2);
  const end = Math.min(items.length, Math.ceil((viewport.scrollLeft + viewport.width) / itemWidth) + 2);
  const selectedFolder = items.find((item) => item.folder && selectedItems.includes(`folder:${item.id}`))?.folder;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport({ scrollLeft: element.scrollLeft, width: element.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [items.length]);

  return (
    <section aria-label="갤러리 보기" className="gallery-view">
      <div className="gallery-stage">
        <div className="gallery-stage-heading">
          <strong>{selectedFolder?.name ?? preview.file?.name ?? "항목 선택"}</strong>
          {preview.file ? <span>{formatFileSize(preview.file.size_bytes)} · {formatDate(preview.file.updated_at)}</span> : null}
        </div>
        {selectedFolder ? <div className="gallery-folder-preview"><Folder aria-hidden="true" /><strong>{selectedFolder.name}</strong><span>폴더</span></div> : <div className="gallery-stage-content">{renderPreview(preview)}</div>}
      </div>
      <div
        aria-label="항목 미리보기 목록"
        className="gallery-strip-viewport"
        onScroll={(event) => setViewport({ scrollLeft: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth })}
        ref={viewportRef}
      >
        <div className="gallery-strip-track" style={{ width: items.length * itemWidth }}>
          {items.slice(start, end).map((item, offset) => {
            const index = start + offset;
            const selected = selectedItems.includes(`${item.kind}:${item.id}`) || preview.file?.id === item.file?.id;
            return (
              <button
                aria-label={`${item.kind === "folder" ? "폴더" : "파일"} ${item.name}`}
                aria-pressed={selected}
                className={`gallery-thumb ${selected ? "is-selected" : ""}`}
                key={`${item.kind}:${item.id}`}
                onClick={() => item.folder ? onFolderClick(item.folder) : item.file && onFileClick(item.file)}
                style={{ left: index * itemWidth, width: itemWidth - 10 }}
                title={item.name}
                type="button"
              >
                <span className="gallery-thumb-icon">
                  {item.file && getPreviewKind(item.file.mime_type, item.file.name) === "image"
                    ? <img alt="" loading="lazy" src={`/api/files/${item.file.id}/content`} />
                    : item.folder ? <Folder aria-hidden="true" /> : item.file ? <FileKindIcon file={item.file} /> : null}
                </span>
                <span>{item.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function renderPreview(preview: PreviewState) {
  if (preview.status === "idle") {
    return (
      <div className="preview-empty">
        <FileText aria-hidden="true" />
      </div>
    );
  }

  if (preview.status === "loading") {
    return (
      <div className="preview-empty">
        <Loader2 aria-hidden="true" className="spin" />
      </div>
    );
  }

  if (preview.status === "error") {
    return <div className="preview-message">{preview.message}</div>;
  }

  if (preview.kind === "image") {
    return <img alt="" className="preview-image" src={preview.url} />;
  }

  if (preview.kind === "pdf") {
    return <iframe className="preview-frame" src={preview.url} title={preview.file.name} />;
  }

  if (preview.kind === "text") {
    return <pre className="preview-text">{preview.text}</pre>;
  }

  if (preview.kind === "document") {
    return <DocxPreviewDocument document={preview.document} />;
  }

  if (preview.kind === "spreadsheet") {
    return <SpreadsheetPreviewTable spreadsheet={preview.spreadsheet} />;
  }

  if (preview.kind === "audio") {
    return <audio className="preview-media" controls src={preview.url} />;
  }

  if (preview.kind === "video") {
    return <video className="preview-media" controls src={preview.url} />;
  }

  if (preview.kind === "office") {
    const officeUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(
      preview.url
    )}`;
    return <iframe className="preview-frame" src={officeUrl} title={preview.file.name} />;
  }

  return <div className="preview-message">미리보기를 지원하지 않는 형식입니다.</div>;
}

function DocxPreviewDocument({
  document
}: {
  document?: DocxPreview;
}) {
  if (!document || document.blocks.length === 0) {
    return <div className="preview-message">표시할 Word 문서 내용이 없습니다.</div>;
  }

  return (
    <div className="preview-document">
      {document.truncated ? (
        <div className="document-meta">일부 내용만 표시됩니다.</div>
      ) : null}
      {document.blocks.map((block, index) => {
        if (block.type === "table") {
          const columnCount = Math.max(1, ...block.rows.map((row) => row.length));
          const columns = Array.from({ length: columnCount }, (_, columnIndex) => columnIndex);

          return (
            <table className="document-table" key={index}>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {columns.map((columnIndex) => (
                      <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }

        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

function SpreadsheetPreviewTable({
  spreadsheet
}: {
  spreadsheet?: SpreadsheetPreview;
}) {
  if (!spreadsheet || spreadsheet.rows.length === 0) {
    return <div className="preview-message">표시할 Excel 데이터가 없습니다.</div>;
  }

  const columnCount = Math.max(
    1,
    ...spreadsheet.rows.map((row) => row.length)
  );
  const columns = Array.from({ length: columnCount }, (_, index) => index);

  return (
    <div className="preview-spreadsheet">
      <div className="spreadsheet-meta">
        <strong>{spreadsheet.sheetName}</strong>
        {spreadsheet.truncated ? <span>일부 행과 열만 표시됩니다.</span> : null}
      </div>
      <table className="spreadsheet-table">
        <tbody>
          {spreadsheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((columnIndex) => (
                <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
