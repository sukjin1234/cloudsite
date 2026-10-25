"use client";

import { type ChangeEvent, type DragEvent, type FormEvent, type PointerEvent, type InputHTMLAttributes, type CSSProperties, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Archive, Check, ChevronDown, ChevronRight, Clipboard, Copy, File, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, FolderPlus, Grid2X2, HardDrive, LoaderCircle, List, LogOut, Menu, Moon, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Scissors, Sun, Trash2, Upload, X } from "lucide-react";
import hljs from "highlight.js/lib/common";
import { formatFileSize, getPreviewKind } from "@/lib/file-utils";
import type { ArchiveEntry } from "@/lib/archive-utils";
import { parseXlsxPreview, type SpreadsheetPreview } from "@/lib/xlsx-preview";
import type { CloudFile, Folder as CloudFolder, PreviewKind } from "@/lib/types";
import "./windows-explorer.css";

type User = { id: string; username: string };
type Crumb = { id: string | null; name: string };
type ExplorerFile = CloudFile & { deleted_at?: string | null; original_path?: string; trash_root_id?: string; trash_root_type?: "file" | "folder" };
type ExplorerFolder = CloudFolder & { deleted_at?: string | null; original_path?: string; trash_root_id?: string; trash_root_type?: "file" | "folder" };
type Listing = { files: ExplorerFile[]; folders: ExplorerFolder[] };
type NodeRef = { id: string; type: "file" | "folder"; trashRootId?: string; trashRootType?: "file" | "folder" };
type Preview =
  | { status: "idle" }
  | { status: "loading"; file: CloudFile }
  | { status: "error"; file: CloudFile; message: string }
  | { status: "blocked"; file: CloudFile; kind: PreviewKind }
  | { status: "ready"; docxBuffer?: ArrayBuffer; file: CloudFile; kind: PreviewKind; spreadsheet?: SpreadsheetPreview; text?: string; url: string };
type SortBy = "name" | "modified" | "type" | "size";
type ClipboardState = { action: "copy" | "cut"; items: NodeRef[] } | null;
type StorageUsage = { usedBytes: number; quotaBytes: number };
type ArchiveView = { file: ExplorerFile; path: string; entries: ArchiveEntry[] };
type UploadProgress = { current: number; total: number; fileName: string; percent: number };
type MoveCollision = { source: NodeRef; sourceName: string; target: NodeRef; targetName: string };

const HOME: Crumb = { id: null, name: "내 클라우드" };
const TRASH: Crumb = { id: "__trash__", name: "휴지통" };
const FILE_DRAG = "application/x-cloud-file-ids";
const FOLDER_DRAG = "application/x-cloud-folder-ids";
const CHUNK_SIZE = 8 * 1024 * 1024;
const PREVIEW_LIMIT = 20 * 1024 * 1024;

async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { ...init, credentials: "same-origin" });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (response.status === 401) window.dispatchEvent(new Event("cloud-session-expired"));
  if (!response.ok) throw new Error(data.error ?? "요청을 처리하지 못했습니다.");
  return data;
}

function keyOf(item: NodeRef) { return item.type + ":" + item.id; }
function fileType(file: CloudFile) {
  const extension = file.name.split(".").pop()?.toLocaleUpperCase("ko-KR");
  return extension && extension !== file.name.toLocaleUpperCase("ko-KR") ? extension + " 파일" : "파일";
}
function dateLabel(value: string) {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  const hour = date.getHours();
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + (hour >= 12 ? "오후" : "오전") + " " + (hour % 12 || 12) + ":" + pad(date.getMinutes());
}
function ExplorerFolderIcon({ className = "" }: { className?: string }) {
  return <svg aria-hidden="true" className={"win-folder-icon " + className} viewBox="0 0 48 40">
    <path d="M3 8.2A4.2 4.2 0 0 1 7.2 4h11.1l4.1 4.2h18.4A4.2 4.2 0 0 1 45 12.4v20.4a4.2 4.2 0 0 1-4.2 4.2H7.2A4.2 4.2 0 0 1 3 32.8V8.2Z" fill="#E9A827" />
    <path d="M4 13.2A4.2 4.2 0 0 1 8.2 9h31.6a4.2 4.2 0 0 1 4.1 5.1l-3.8 18.4a4.2 4.2 0 0 1-4.1 3.3H8.3a4.2 4.2 0 0 1-4.2-4.2V13.2Z" fill="#FFD66B" />
    <path d="M5.5 13.4h36.8" stroke="#FFF0B3" strokeLinecap="round" strokeWidth="1.4" />
  </svg>;
}
function TrashIcon({ filled }: { filled: boolean }) {
  if (!filled) return <Trash2 aria-hidden="true" />;
  return <svg aria-hidden="true" className="win-trash-filled-icon" viewBox="0 0 24 24">
    <path d="M8 5V3.8A1.8 1.8 0 0 1 9.8 2h4.4A1.8 1.8 0 0 1 16 3.8V5h4v2H4V5h4Zm-2 4h12l-.9 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 9Z" fill="currentColor" />
    <path d="M10 11v8M14 11v8" stroke="var(--win-bg)" strokeLinecap="round" strokeWidth="1.5" />
  </svg>;
}
function FileKindIcon({ file }: { file: CloudFile }) {
  const kind = getPreviewKind(file.mime_type, file.name);
  const Icon = kind === "archive" ? Archive : kind === "image" ? FileImage : kind === "audio" ? FileAudio : kind === "video" ? FileVideo : kind === "spreadsheet" ? FileSpreadsheet : ["document", "text", "pdf", "office"].includes(kind) ? FileText : File;
  return <Icon aria-hidden="true" />;
}

export function WindowsExplorer() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([HOME]);
  const [history, setHistory] = useState<Array<Crumb[]>>([[HOME]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [listing, setListing] = useState<Listing>({ files: [], folders: [] });
  const [pinned, setPinned] = useState<CloudFolder[]>([]);
  const [sidebarFiles, setSidebarFiles] = useState<CloudFile[]>([]);
  const [trashHasItems, setTrashHasItems] = useState(false);
  const [storage, setStorage] = useState<StorageUsage>({ usedBytes: 0, quotaBytes: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [descending, setDescending] = useState(false);
  const [view, setView] = useState<"details" | "icons">("details");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [compressMenu, setCompressMenu] = useState(false);
  const [crumbMenu, setCrumbMenu] = useState<number | null>(null);
  const [crumbChildren, setCrumbChildren] = useState<CloudFolder[]>([]);
  const [addressEditing, setAddressEditing] = useState(false);
  const [addressValue, setAddressValue] = useState("");
  const [isTrash, setIsTrash] = useState(false);
  const [trashCrumbs, setTrashCrumbs] = useState<Crumb[]>([TRASH]);
  const [archiveView, setArchiveView] = useState<ArchiveView | null>(null);
  const [archiveSelected, setArchiveSelected] = useState<ArchiveEntry | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [editName, setEditName] = useState<{ key: string; value: string } | null>(null);
  const [newFolderDraft, setNewFolderDraft] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item?: NodeRef; pinned?: CloudFolder } | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [folderChildCount, setFolderChildCount] = useState<number | null>(null);
  const [columnWidth, setColumnWidth] = useState({ modified: 180, type: 130, size: 100 });
  const [previewWidth, setPreviewWidth] = useState(320);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [draggingItems, setDraggingItems] = useState<NodeRef[]>([]);
  const [movePrompt, setMovePrompt] = useState<{ items: NodeRef[]; targetId: string | null; collisions: MoveCollision[] } | null>(null);
  const [itemsViewport, setItemsViewport] = useState({ height: 600, scrollTop: 0, width: 900 });
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const itemsViewportRef = useRef<HTMLDivElement>(null);
  const previewRequest = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const previewWorker = useRef<Worker | null>(null);
  const uploadProgressTimer = useRef<number | null>(null);
  const previewDragY = useRef<number | null>(null);
  const creatingFolder = useRef(false);
  const resizeState = useRef<{ target: "modified" | "type" | "size" | "preview"; x: number; width: number } | null>(null);
  const current = isTrash ? trashCrumbs[trashCrumbs.length - 1] ?? TRASH : crumbs[crumbs.length - 1] ?? HOME;

  const loadListing = useCallback(async (folderId: string | null, search = "") => {
    setNotice("");
    if (!isTrash && folderId === null) {
      setListing({ files: [], folders: [] });
      setSelected([]);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (isTrash) {
        if (folderId && folderId !== TRASH.id) params.set("folderId", folderId);
        const trashed = await api<{ files: ExplorerFile[]; folders: ExplorerFolder[] }>("/api/trash" + (params.size ? "?" + params : ""));
        setListing({ files: trashed.files, folders: trashed.folders });
        if (!folderId || folderId === TRASH.id) setTrashHasItems(trashed.files.length + trashed.folders.length > 0);
      } else if (search.trim()) {
        params.set("q", search.trim()); params.set("scope", "current");
        if (folderId) params.set("parentId", folderId);
        setListing(await api<Listing>("/api/search?" + params));
      } else {
        if (folderId) params.set("parentId", folderId);
        setListing(await api<Listing>("/api/folders?" + params));
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "목록을 불러오지 못했습니다."); }
    setSelected([]);
  }, [isTrash]);
  const loadPinned = useCallback(async () => {
    try {
      const result = await api<{ files?: CloudFile[]; folders: CloudFolder[] }>("/api/folders/pinned");
      setPinned(result.folders); setSidebarFiles(result.files ?? []);
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "고정 폴더를 불러오지 못했습니다."); }
  }, []);
  const loadTrashStatus = useCallback(async () => {
    try {
      const trashed = await api<{ files: ExplorerFile[]; folders: ExplorerFolder[] }>("/api/trash");
      setTrashHasItems(trashed.files.length + trashed.folders.length > 0);
    } catch { /* Keep the last known trash state if its count is unavailable. */ }
  }, []);
  const loadStorage = useCallback(async () => {
    try { setStorage((await api<{ storage: StorageUsage }>("/api/auth/me")).storage); }
    catch { /* Storage summary is optional if the usage endpoint is unavailable. */ }
  }, []);

  useEffect(() => {
    let mounted = true;
    fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : null)
      .then((data: { user?: User } | null) => { if (mounted) setUser(data?.user ?? null); })
      .catch(() => { if (mounted) setUser(null); }).finally(() => { if (mounted) setAuthLoading(false); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    const element = itemsViewportRef.current;
    if (!element) return;
    const measure = () => setItemsViewport({ height: element.clientHeight, scrollTop: element.scrollTop, width: element.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [user, view]);
  useEffect(() => {
    const start = selectionBox;
    if (!start) return;
    const move = (event: globalThis.PointerEvent) => setSelectionBox((box) => box ? { ...box, x: event.clientX, y: event.clientY } : null);
    const finish = (event: globalThis.PointerEvent) => {
      const left = Math.min(start.startX, event.clientX); const right = Math.max(start.startX, event.clientX);
      const top = Math.min(start.startY, event.clientY); const bottom = Math.max(start.startY, event.clientY);
      const hits = Array.from(document.querySelectorAll<HTMLElement>("[data-item-key]"))
        .filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top; })
        .map((element) => element.dataset.itemKey).filter((key): key is string => Boolean(key));
      if (right - left > 3 || bottom - top > 3) setSelected(hits);
      setSelectionBox(null);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); };
  }, [selectionBox]);
  useEffect(() => {
    const expire = () => setUser(null);
    window.addEventListener("cloud-session-expired", expire);
    return () => window.removeEventListener("cloud-session-expired", expire);
  }, []);
  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => void loadListing(current.id, query), query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [current.id, loadListing, query, user]);
  useEffect(() => { if (user) void loadPinned(); }, [loadPinned, user]);
  useEffect(() => { if (user) void loadStorage(); }, [loadStorage, user]);
  useEffect(() => { if (user) void loadTrashStatus(); }, [loadTrashStatus, user]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!authMessage) return;
    const timer = window.setTimeout(() => setAuthMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [authMessage]);
  useEffect(() => {
    try {
      const width = Number(localStorage.getItem("windows-cloud-preview-width"));
      if (Number.isFinite(width) && width >= 280 && width <= 600) setPreviewWidth(width);
      if (localStorage.getItem("windows-cloud-theme") === "light") setTheme("light");
    } catch { /* Private browsing may disable storage. */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("windows-cloud-theme", theme); } catch { /* Private browsing may disable storage. */ } }, [theme]);
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const resize = resizeState.current;
      if (!resize) return;
      const delta = resize.x - event.clientX;
      if (resize.target === "preview") {
        const width = Math.max(280, Math.min(600, resize.width + delta));
        setPreviewWidth(width); localStorage.setItem("windows-cloud-preview-width", String(width));
      } else {
        const min = resize.target === "modified" ? 125 : 80;
        setColumnWidth((old) => ({ ...old, [resize.target]: Math.max(min, Math.min(360, resize.width + delta)) }));
      }
    };
    const up = () => { resizeState.current = null; document.body.classList.remove("win-is-resizing"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.classList.remove("win-is-resizing"); };
  }, []);

  const visibleFolders = useMemo(() => [...listing.folders].sort((a, b) => {
    if (isTrash) return new Date(b.deleted_at ?? b.updated_at).getTime() - new Date(a.deleted_at ?? a.updated_at).getTime();
    const value = sortBy === "modified" ? new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime() : a.name.localeCompare(b.name, "ko-KR", { numeric: true, sensitivity: "base" });
    return descending ? -value : value;
  }), [descending, isTrash, listing.folders, sortBy]);
  const visibleFiles = useMemo(() => [...listing.files].sort((a, b) => {
    if (isTrash) return new Date(b.deleted_at ?? b.updated_at).getTime() - new Date(a.deleted_at ?? a.updated_at).getTime();
    const value = sortBy === "modified" ? new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
      : sortBy === "size" ? Number(a.size_bytes) - Number(b.size_bytes)
      : sortBy === "type" ? fileType(a).localeCompare(fileType(b), "ko-KR")
      : a.name.localeCompare(b.name, "ko-KR", { numeric: true, sensitivity: "base" });
    return descending ? -value : value;
  }), [descending, isTrash, listing.files, sortBy]);
  const totalItems = visibleFolders.length + visibleFiles.length;
  const virtualized = totalItems > 1000 && !newFolderDraft;
  const virtualColumns = view === "details" ? 1 : Math.max(1, Math.floor(itemsViewport.width / 150));
  const virtualRowHeight = view === "details" ? 34 : 130;
  const visibleStart = virtualized ? Math.max(0, Math.floor(itemsViewport.scrollTop / virtualRowHeight) * virtualColumns - virtualColumns * 2) : 0;
  const visibleEnd = virtualized ? Math.min(totalItems, Math.ceil((itemsViewport.scrollTop + itemsViewport.height) / virtualRowHeight) * virtualColumns + virtualColumns * 2) : totalItems;
  const renderFolders = visibleFolders.slice(visibleStart, Math.min(visibleEnd, visibleFolders.length));
  const firstFileIndex = Math.max(0, visibleStart - visibleFolders.length);
  const lastFileIndex = Math.max(0, visibleEnd - visibleFolders.length);
  const renderFiles = visibleFiles.slice(firstFileIndex, lastFileIndex);
  const virtualStyle = (index: number): CSSProperties | undefined => virtualized ? {
    height: virtualRowHeight,
    left: view === "icons" ? ((index % virtualColumns) * (100 / virtualColumns)) + "%" : 0,
    position: "absolute",
    right: view === "details" ? 0 : undefined,
    top: view === "icons" ? Math.floor(index / virtualColumns) * virtualRowHeight : index * virtualRowHeight,
    width: view === "icons" ? (100 / virtualColumns) + "%" : undefined
  } : undefined;
  const selectedRefs = selected.map((key) => {
    const [type, id] = key.split(":");
    const itemType = type as NodeRef["type"];
    const entry = isTrash ? itemType === "file" ? listing.files.find((file) => file.id === id) : listing.folders.find((folder) => folder.id === id) : undefined;
    return { id, type: itemType, trashRootId: entry?.trash_root_id, trashRootType: entry?.trash_root_type };
  });
  const selectedBytes = selectedRefs.reduce((sum, item) => sum + Number(listing.files.find((file) => file.id === item.id)?.size_bytes ?? sidebarFiles.find((file) => file.id === item.id)?.size_bytes ?? 0), 0);
  const selectedFile = selected.length === 1 && selected[0].startsWith("file:") ? listing.files.find((file) => "file:" + file.id === selected[0]) ?? sidebarFiles.find((file) => "file:" + file.id === selected[0]) ?? null : null;
  const selectedFolder = selected.length === 1 && selected[0].startsWith("folder:") ? listing.folders.find((folder) => "folder:" + folder.id === selected[0]) ?? null : null;
  const selectedSingle = selectedRefs.length === 1 ? selectedRefs[0] : null;

  useEffect(() => {
    if (!selectedFolder) { setFolderChildCount(null); return; }
    let live = true;
    const params = new URLSearchParams(isTrash ? { folderId: selectedFolder.id } : { parentId: selectedFolder.id });
    void api<Listing>((isTrash ? "/api/trash?" : "/api/folders?") + params).then((result) => { if (live) setFolderChildCount(result.folders.length + result.files.length); })
      .catch(() => { if (live) setFolderChildCount(null); });
    return () => { live = false; };
  }, [isTrash, selectedFolder]);
  useEffect(() => {
    if (selectedFile) void loadPreview(selectedFile);
    else { cancelPreview(); setPreview({ status: "idle" }); }
    return () => cancelPreview();
    // Preview follows the single selected file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.id]);

  function cancelPreview() {
    previewAbort.current?.abort();
    previewAbort.current = null;
    previewRequest.current += 1;
  }

  async function loadPreview(file: CloudFile) {
    previewAbort.current?.abort();
    previewAbort.current = null;
    const requestId = ++previewRequest.current;
    const kind = getPreviewKind(file.mime_type, file.name);
    if (kind === "archive") { setPreview({ status: "idle" }); return; }
    if (Number(file.size_bytes) >= PREVIEW_LIMIT) { setPreview({ file, kind, status: "blocked" }); return; }
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreview({ file, status: "loading" });
    try {
      const result = await api<{ kind: PreviewKind; url: string }>("/api/files/" + file.id + "/preview", { signal: controller.signal });
      if (requestId !== previewRequest.current) return;
      if (result.kind === "unsupported" || result.kind === "office") {
        setPreview({ file, message: "이 파일 형식은 미리 볼 수 없습니다.", status: "error" }); setNotice("이 파일 형식은 미리 볼 수 없습니다."); return;
      }
      let text: string | undefined; let docxBuffer: ArrayBuffer | undefined; let spreadsheet: SpreadsheetPreview | undefined;
      if (result.kind === "text" || result.kind === "document" || result.kind === "spreadsheet") {
        const content = await fetch(result.url, { credentials: "same-origin", signal: controller.signal });
        if (!content.ok) throw new Error("파일 내용을 불러오지 못했습니다.");
        if (result.kind === "text") text = await content.text();
        if (result.kind === "document") docxBuffer = await content.arrayBuffer();
        if (result.kind === "spreadsheet") {
          const buffer = await content.arrayBuffer();
          spreadsheet = await parseXlsxPreview(buffer);
        }
      }
      if (requestId === previewRequest.current) setPreview({ docxBuffer, file, kind: result.kind, spreadsheet, status: "ready", text, url: result.url });
    } catch (error) {
      if (!controller.signal.aborted && requestId === previewRequest.current) {
        const message = error instanceof Error ? error.message : "미리보기를 열지 못했습니다.";
        setPreview({ file, message, status: "error" }); setNotice(message);
      }
    }
  }

  async function loadArchive(file: ExplorerFile, path = "") {
    cancelPreview();
    const controller = new AbortController();
    previewAbort.current = controller;
    const requestId = previewRequest.current;
    setBusy("압축 파일을 여는 중"); setNotice("");
    try {
      const params = new URLSearchParams(); if (path) params.set("path", path);
      const result = await api<{ entries: ArchiveEntry[]; file: ExplorerFile; path: string }>("/api/files/" + file.id + "/archive" + (params.size ? "?" + params : ""), { signal: controller.signal });
      if (controller.signal.aborted || requestId !== previewRequest.current) return;
      setArchiveView({ file: result.file, path: result.path, entries: result.entries });
      setArchiveSelected(null); setSelected([]); setPreview({ status: "idle" });
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "압축 파일을 열지 못했습니다."); }
    finally { if (requestId === previewRequest.current) setBusy(""); }
  }

  async function loadArchivePreview(entry: ArchiveEntry) {
    if (!archiveView || entry.type !== "file") return;
    previewAbort.current?.abort();
    const requestId = ++previewRequest.current;
    const file: CloudFile = { ...archiveView.file, name: entry.name, mime_type: "application/octet-stream", size_bytes: entry.size };
    const kind = getPreviewKind(file.mime_type, file.name);
    if (entry.size >= PREVIEW_LIMIT) { setPreview({ file, kind, status: "blocked" }); return; }
    if (kind === "unsupported" || kind === "office" || kind === "archive") {
      setPreview({ file, message: "이 파일 형식은 미리 볼 수 없습니다.", status: "error" }); setNotice("이 파일 형식은 미리 볼 수 없습니다."); return;
    }
    const controller = new AbortController();
    previewAbort.current = controller;
    const params = new URLSearchParams({ path: entry.path });
    const url = "/api/files/" + archiveView.file.id + "/archive/content?" + params;
    setPreview({ file, status: "loading" });
    try {
      const content = await fetch(url, { credentials: "same-origin", signal: controller.signal });
      if (!content.ok) throw new Error((await content.json().catch(() => ({})) as { error?: string }).error ?? "압축 파일 내용을 불러오지 못했습니다.");
      let text: string | undefined; let docxBuffer: ArrayBuffer | undefined; let spreadsheet: SpreadsheetPreview | undefined;
      if (kind === "text") text = await content.text();
      if (kind === "document") docxBuffer = await content.arrayBuffer();
      if (kind === "spreadsheet") spreadsheet = await parseXlsxPreview(await content.arrayBuffer());
      if (requestId === previewRequest.current) setPreview({ docxBuffer, file, kind, spreadsheet, status: "ready", text, url });
    } catch (error) { if (!controller.signal.aborted && requestId === previewRequest.current) {
      const message = error instanceof Error ? error.message : "압축 파일 내용을 미리 볼 수 없습니다.";
      setPreview({ file, message, status: "error" }); setNotice(message);
    } }
  }

  function openArchiveEntry(entry: ArchiveEntry) {
    if (!archiveView) return;
    if (entry.type === "folder") void loadArchive(archiveView.file, entry.path);
    else { setArchiveSelected(entry); void loadArchivePreview(entry); }
  }

  async function refresh() { await Promise.all([loadListing(current.id, query), loadPinned(), loadStorage(), loadTrashStatus()]); }
  function pushPath(path: Crumb[]) {
    setIsTrash(false); setArchiveView(null); setArchiveSelected(null); setCrumbs(path); setSelected([]); setQuery("");
    setHistory((old) => [...old.slice(0, historyIndex + 1), path]); setHistoryIndex((old) => old + 1);
  }
  async function navigate(folder: CloudFolder) {
    try {
      const result = await api<{ path: Array<{ id: string; name: string }> }>("/api/folders/path?id=" + folder.id);
      pushPath([HOME, ...result.path.map((crumb) => ({ id: crumb.id, name: crumb.name }))]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "폴더를 열지 못했습니다."); }
  }
  function navigateTrashFolder(folder: ExplorerFolder) {
    setArchiveView(null); setArchiveSelected(null); setTrashCrumbs((path) => [...path, { id: folder.id, name: folder.name }]);
    setSelected([]); setQuery(""); setPreview({ status: "idle" }); setSidebarOpen(false);
  }
  function goBack() {
    if (archiveView) {
      const parent = archiveView.path.split("/").filter(Boolean).slice(0, -1).join("/");
      if (archiveView.path) void loadArchive(archiveView.file, parent);
      else { cancelPreview(); setArchiveView(null); setArchiveSelected(null); setPreview({ status: "idle" }); }
      return;
    }
    if (isTrash) {
      if (trashCrumbs.length > 1) setTrashCrumbs((path) => path.slice(0, -1));
      else setIsTrash(false);
      setSelected([]); setQuery(""); setPreview({ status: "idle" }); return;
    }
    if (crumbs.length <= 1) return;
    const parentPath = crumbs.slice(0, -1);
    setCrumbs(parentPath); setSelected([]); setQuery("");
    const next = history.slice(0, historyIndex + 1);
    const currentPathKey = crumbs.map((crumb) => crumb.id ?? "root").join("/");
    if (next.at(-1)?.map((crumb) => crumb.id ?? "root").join("/") === currentPathKey) next.pop();
    next.push(parentPath, crumbs); setHistory(next); setHistoryIndex(next.length - 2);
  }
  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1; setHistoryIndex(index); setCrumbs(history[index]); setSelected([]); setQuery("");
  }
  function goUp() { goBack(); }
  function chooseCrumb(index: number) {
    if (isTrash) {
      setTrashCrumbs((path) => path.slice(0, index + 1)); setSelected([]); setPreview({ status: "idle" }); setQuery(""); setArchiveView(null); setArchiveSelected(null); return;
    }
    setArchiveView(null); setArchiveSelected(null); setCrumbMenu(null); setSelected([]); setPreview({ status: "idle" }); setQuery("");
    setCrumbs(index === 0 ? [HOME] : crumbs.slice(0, index + 1));
  }
  function chooseAddressCrumb(index: number) {
    if (!archiveView) { chooseCrumb(index); return; }
    const baseCrumbs = isTrash ? trashCrumbs : crumbs;
    if (index < baseCrumbs.length) { chooseCrumb(index); return; }
    const depth = index - baseCrumbs.length;
    const path = archiveView.path.split("/").filter(Boolean).slice(0, depth).join("/");
    void loadArchive(archiveView.file, path);
  }
  function showTrash() {
    setIsTrash(true); setTrashCrumbs([TRASH]); setArchiveView(null); setArchiveSelected(null); setSelected([]); setQuery(""); setAddressEditing(false); setCrumbMenu(null); setContextMenu(null); setNewFolderDraft(false); setEditName(null);
  }
  async function showChildFolders(index: number) {
    const params = new URLSearchParams();
    if (crumbs[index]?.id) params.set("parentId", crumbs[index].id!);
    try {
      const result = await api<Listing>("/api/folders?" + params);
      setCrumbChildren(result.folders); setCrumbMenu((old) => old === index ? null : index);
    } catch (error) { setNotice(error instanceof Error ? error.message : "하위 폴더를 불러오지 못했습니다."); }
  }
  async function commitAddress() {
    const rawAddress = addressValue.trim();
    const names = rawAddress.split(/[>/\\]+/).map((part) => part.trim()).filter((name) => name && name !== "Root" && name !== "내 클라우드");
    if (names[0]?.toLocaleLowerCase() === "휴지통") {
      try {
        const path: Crumb[] = [TRASH];
        let folderId: string | null = null;
        for (const name of names.slice(1)) {
          const params = new URLSearchParams(); if (folderId) params.set("folderId", folderId);
          const children = await api<Listing>("/api/trash" + (params.size ? "?" + params : ""));
          const folder = children.folders.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
          if (!folder) throw new Error("경로를 찾을 수 없습니다.");
          path.push({ id: folder.id, name: folder.name }); folderId = folder.id;
        }
        setIsTrash(true); setTrashCrumbs(path); setArchiveView(null); setArchiveSelected(null); setSelected([]); setQuery(""); setAddressEditing(false); return;
      } catch { setAddressEditing(false); setNotice("'" + rawAddress + "'을(를) 찾을 수 없습니다."); return; }
    }
    let parentId: string | null = null; const path: Crumb[] = [HOME];
    try {
      for (const name of names) {
        const params = new URLSearchParams(); if (parentId) params.set("parentId", parentId);
        const children = await api<Listing>("/api/folders?" + params);
        const folder = children.folders.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
        if (!folder) throw new Error("“" + name + "” 폴더를 찾을 수 없습니다.");
        path.push({ id: folder.id, name: folder.name }); parentId = folder.id;
      }
      setAddressEditing(false); pushPath(path);
    } catch {
      setAddressEditing(false);
      setNotice("'" + rawAddress + "'을(를) 찾을 수 없습니다.");
    }
  }
  function changeSelection(type: NodeRef["type"], id: string, event: MouseEvent) {
    const key = type + ":" + id;
    const all = [...visibleFolders.map((folder) => "folder:" + folder.id), ...visibleFiles.map((file) => "file:" + file.id)];
    if (event.shiftKey && selected.length) {
      const a = all.indexOf(selected[selected.length - 1]); const b = all.indexOf(key);
      if (a >= 0 && b >= 0) setSelected(all.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (event.ctrlKey || event.metaKey) setSelected((old) => old.includes(key) ? old.filter((entry) => entry !== key) : [...old, key]);
    else setSelected([key]);
  }
  function openNode(item: NodeRef) {
    if (isTrash) {
      if (item.type === "folder") {
        const folder = listing.folders.find((entry) => entry.id === item.id);
        if (folder) navigateTrashFolder(folder);
      } else {
        const file = listing.files.find((entry) => entry.id === item.id);
        if (file && getPreviewKind(file.mime_type, file.name) === "archive") void loadArchive(file);
        else if (file) void loadPreview(file);
      }
      return;
    }
    if (item.type === "folder") {
      const folder = listing.folders.find((entry) => entry.id === item.id) ?? pinned.find((entry) => entry.id === item.id);
      if (folder) void navigate(folder);
    } else {
      const file = listing.files.find((entry) => entry.id === item.id) ?? sidebarFiles.find((entry) => entry.id === item.id);
      if (file && getPreviewKind(file.mime_type, file.name) === "archive") void loadArchive(file);
      else window.open("/api/files/" + item.id + "/content", "_blank", "noopener,noreferrer");
    }
  }
  function createFolder() {
    if (isTrash) return;
    setNewMenu(false); setNewFolderDraft(true); setSelected(["new-folder"]); creatingFolder.current = false;
    setEditName({ key: "new-folder", value: "새 폴더" });
    window.setTimeout(() => { const input = document.querySelector<HTMLInputElement>("[data-new-folder-input]"); input?.focus(); input?.select(); }, 0);
  }
  async function saveNewFolder(name: string) {
    if (isTrash) { setNewFolderDraft(false); setEditName(null); return; }
    if (creatingFolder.current) return;
    const clean = name.trim();
    if (!clean) { setNewFolderDraft(false); setEditName(null); return; }
    creatingFolder.current = true; setBusy("폴더 만드는 중");
    try {
      const result = await api<{ folder: CloudFolder }>("/api/folders", {
        body: JSON.stringify({ isPinned: true, name: clean, parentId: current.id }),
        headers: { "Content-Type": "application/json" }, method: "POST"
      });
      setNewFolderDraft(false); setEditName(null); setSelected(["folder:" + result.folder.id]);
      await Promise.all([loadListing(current.id, query), loadPinned(), loadStorage()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "폴더를 만들지 못했습니다.");
      setNewFolderDraft(false); setEditName(null);
    } finally { creatingFolder.current = false; setBusy(""); }
  }
  async function commitRename(item: NodeRef, name: string) {
    setEditName(null); if (!name.trim()) return;
    try {
      await api("/api/" + (item.type === "folder" ? "folders" : "files") + "/" + item.id, {
        body: JSON.stringify({ name: name.trim() }), headers: { "Content-Type": "application/json" }, method: "PATCH"
      });
      if (selectedFile?.id === item.id) setPreview({ status: "idle" });
      await Promise.all([loadListing(current.id, query), loadPinned(), loadStorage()]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "이름을 바꾸지 못했습니다."); }
  }
  async function renamePinned(folder: CloudFolder) {
    const name = window.prompt("폴더 이름", folder.name)?.trim();
    if (name && name !== folder.name) await commitRename({ id: folder.id, type: "folder" }, name);
  }
  async function togglePin(folder: CloudFolder, isPinned: boolean) {
    try {
      await api("/api/folders/" + folder.id, { body: JSON.stringify({ isPinned }), headers: { "Content-Type": "application/json" }, method: "PATCH" });
      await loadPinned(); setContextMenu(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : "고정 상태를 바꾸지 못했습니다."); }
  }
  async function deleteItems(items: NodeRef[]) {
    if (isTrash) return;
    if (!items.length || !window.confirm(items.length + "개 항목을 휴지통으로 이동할까요?")) return;
    setBusy("삭제하는 중");
    try {
      for (const item of items) await api("/api/" + (item.type === "folder" ? "folders" : "files") + "/" + item.id, { method: "DELETE" });
      setSelected([]); setPreview({ status: "idle" });
      await Promise.all([loadListing(current.id, query), loadPinned(), loadStorage(), loadTrashStatus()]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "삭제하지 못했습니다."); }
    finally { setBusy(""); }
  }
  async function restoreItems(items: NodeRef[]) {
    if (!items.length) return;
    setBusy("복원하는 중"); setNotice("");
    try {
      const roots = trashRootItems(items);
      for (const item of roots) await api("/api/trash", {
        body: JSON.stringify({ action: "restore", id: item.id, type: item.type }),
        headers: { "Content-Type": "application/json" }, method: "POST"
      });
      setSelected([]); setPreview({ status: "idle" });
      if (isTrash) setTrashCrumbs([TRASH]);
      await Promise.all([loadListing(isTrash ? TRASH.id : current.id, ""), loadPinned(), loadStorage(), loadTrashStatus()]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "항목을 복원하지 못했습니다."); }
    finally { setBusy(""); }
  }
  async function permanentlyDeleteItems(items: NodeRef[]) {
    if (!items.length || !window.confirm(items.length + "개 항목을 영구 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    setBusy("영구 삭제하는 중"); setNotice("");
    try {
      for (const item of trashRootItems(items)) await api("/api/trash", {
        body: JSON.stringify({ action: "delete", id: item.id, type: item.type }),
        headers: { "Content-Type": "application/json" }, method: "POST"
      });
      setSelected([]); setPreview({ status: "idle" });
      if (isTrash) setTrashCrumbs([TRASH]);
      await Promise.all([loadListing(isTrash ? TRASH.id : null, ""), loadPinned(), loadStorage(), loadTrashStatus()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "영구 삭제하지 못했습니다.");
      if (isTrash) setTrashCrumbs([TRASH]);
      await Promise.all([loadListing(isTrash ? TRASH.id : null, ""), loadStorage(), loadTrashStatus()]);
    } finally { setBusy(""); }
  }
  async function emptyTrash() {
    if (!window.confirm("휴지통의 모든 항목을 영구 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    setBusy("휴지통 비우는 중"); setNotice("");
    try {
      await api("/api/trash", { method: "DELETE" });
      setSelected([]); setPreview({ status: "idle" });
      setTrashCrumbs([TRASH]);
      await Promise.all([loadListing(TRASH.id, ""), loadPinned(), loadStorage(), loadTrashStatus()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "휴지통을 비우지 못했습니다.");
      await Promise.all([loadListing(TRASH.id, ""), loadStorage(), loadTrashStatus()]);
    } finally { setBusy(""); }
  }
  function trashRootItems(items: NodeRef[]) {
    const roots = new Map<string, NodeRef>();
    for (const item of items) {
      const entry = item.type === "file" ? listing.files.find((file) => file.id === item.id) : listing.folders.find((folder) => folder.id === item.id);
      const id = item.trashRootId ?? entry?.trash_root_id ?? item.id;
      const type = item.trashRootType ?? entry?.trash_root_type ?? item.type;
      roots.set(type + ":" + id, { id, type });
    }
    return [...roots.values()];
  }
  async function ensureFolderPath(parts: string[]) {
    let parentId = current.id;
    for (const name of parts.filter(Boolean)) {
      const params = new URLSearchParams(); if (parentId) params.set("parentId", parentId);
      const children = await api<Listing>("/api/folders?" + params);
      const found = children.folders.find((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (found) parentId = found.id;
      else {
        const result = await api<{ folder: CloudFolder }>("/api/folders", {
          body: JSON.stringify({ isPinned: true, name, parentId }), headers: { "Content-Type": "application/json" }, method: "POST"
        });
        parentId = result.folder.id;
      }
    }
    return parentId;
  }
  async function uploadFiles(fileList: FileList | File[] | null, targetId = current.id) {
    if (isTrash) return;
    if (!fileList?.length) return;
    const files = Array.from(fileList); setNotice("");
    let completed = false;
    if (uploadProgressTimer.current !== null) window.clearTimeout(uploadProgressTimer.current);
    setUploadProgress({ current: 1, total: files.length, fileName: files[0].name, percent: 0 });
    try {
      for (const [index, file] of files.entries()) {
        const relative = String((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "");
        const parts = relative.split("/").filter(Boolean);
        const destination = targetId === current.id ? await ensureFolderPath(parts.slice(0, -1)) : targetId;
        const name = parts.at(-1) ?? file.name;
        const key = "personal-cloud-upload:" + (destination ?? "root") + ":" + name + ":" + file.size + ":" + file.lastModified;
        let uploadId = localStorage.getItem(key); let offset = 0;
        if (uploadId) {
          const status = await fetch("/api/uploads/" + uploadId, { credentials: "same-origin" });
          if (status.ok) offset = (await status.json() as { offset: number }).offset;
          else { uploadId = null; localStorage.removeItem(key); }
        }
        if (!uploadId) {
          const started = await api<{ uploadId: string; offset: number }>("/api/uploads", {
            body: JSON.stringify({ folderId: destination, mimeType: file.type, name, sizeBytes: file.size }),
            headers: { "Content-Type": "application/json" }, method: "POST"
          });
          uploadId = started.uploadId; offset = started.offset; localStorage.setItem(key, uploadId);
        }
        while (offset < file.size) {
          const end = Math.min(file.size, offset + CHUNK_SIZE);
          offset = (await api<{ offset: number }>("/api/uploads/" + uploadId, {
            body: file.slice(offset, end), headers: { "Upload-Offset": String(offset) }, method: "PUT"
          })).offset;
          setUploadProgress({ current: index + 1, total: files.length, fileName: name, percent: Math.floor(offset / Math.max(file.size, 1) * 100) });
        }
        await api("/api/uploads/" + uploadId, { method: "POST" }); localStorage.removeItem(key);
        setUploadProgress({ current: index + 1, total: files.length, fileName: name, percent: 100 });
      }
      await Promise.all([loadListing(current.id, query), loadPinned(), loadStorage()]);
      completed = true;
      uploadProgressTimer.current = window.setTimeout(() => setUploadProgress(null), 1500);
    } catch (error) { setNotice(error instanceof Error ? error.message : "업로드에 실패했습니다."); }
    finally {
      if (!completed) setUploadProgress(null);
      if (fileInput.current) fileInput.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    }
  }
  async function moveNode(item: NodeRef, targetId: string | null) {
    await api("/api/" + (item.type === "folder" ? "folders" : "files") + "/" + item.id, {
      body: JSON.stringify(item.type === "folder" ? { parentId: targetId } : { folderId: targetId }),
      headers: { "Content-Type": "application/json" }, method: "PATCH"
    });
  }
  function itemDragStart(event: DragEvent<HTMLElement>, item: NodeRef) {
    const items = selected.includes(keyOf(item)) ? selectedRefs : [{ id: item.id, type: item.type }];
    setDraggingItems(items);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(FILE_DRAG, JSON.stringify(items.filter((entry) => entry.type === "file").map((entry) => entry.id)));
    event.dataTransfer.setData(FOLDER_DRAG, JSON.stringify(items.filter((entry) => entry.type === "folder").map((entry) => entry.id)));
  }
  function invalidMoveTarget(items: NodeRef[], targetId: string | null) {
    return items.some((item) => item.type === "folder" && (item.id === targetId || crumbs.some((crumb) => crumb.id === item.id)));
  }
  function dropOver(event: DragEvent<HTMLElement>, targetId: string | null) {
    if (isTrash) return;
    if ([FILE_DRAG, FOLDER_DRAG, "Files"].some((type) => event.dataTransfer.types.includes(type))) {
      const internal = event.dataTransfer.types.includes(FILE_DRAG) || event.dataTransfer.types.includes(FOLDER_DRAG);
      const allowed = !internal || !invalidMoveTarget(draggingItems, targetId);
      event.preventDefault(); event.dataTransfer.dropEffect = allowed ? event.dataTransfer.types.includes("Files") && !internal ? "copy" : "move" : "none";
      setDropFolderId(allowed ? targetId ?? "root" : null);
    }
  }
  function getNodeName(item: NodeRef) {
    return item.type === "file"
      ? listing.files.find((entry) => entry.id === item.id)?.name ?? sidebarFiles.find((entry) => entry.id === item.id)?.name
      : listing.folders.find((entry) => entry.id === item.id)?.name ?? pinned.find((entry) => entry.id === item.id)?.name;
  }
  async function executeMove(items: NodeRef[], targetId: string | null, collisions: MoveCollision[] = [], overwrite = false) {
    setMovePrompt(null); setBusy("이동하는 중");
    try {
      if (overwrite) {
        const removed = new Set<string>();
        for (const collision of collisions) {
          const key = keyOf(collision.target);
          if (!removed.has(key)) {
            await api("/api/" + (collision.target.type === "folder" ? "folders" : "files") + "/" + collision.target.id, { method: "DELETE" });
            removed.add(key);
          }
        }
      }
      for (const item of items) await moveNode(item, targetId);
      setSelected([]);
      await Promise.all([loadListing(current.id, query), loadPinned(), loadStorage(), loadTrashStatus()]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "항목을 이동하지 못했습니다."); }
    finally { setBusy(""); setDraggingItems([]); }
  }
  async function requestMove(items: NodeRef[], targetId: string | null) {
    if (!items.length || invalidMoveTarget(items, targetId)) return;
    try {
      const params = new URLSearchParams(); if (targetId) params.set("parentId", targetId);
      const destination = await api<Listing>("/api/folders" + (params.size ? "?" + params : ""));
      const collisions: MoveCollision[] = [];
      for (const source of items) {
        const name = getNodeName(source);
        if (!name) continue;
        const target = [...destination.folders.map((entry) => ({ id: entry.id, type: "folder" as const, name: entry.name })), ...destination.files.map((entry) => ({ id: entry.id, type: "file" as const, name: entry.name }))]
          .find((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase() && entry.id !== source.id);
        if (target) collisions.push({ source, sourceName: name, target: { id: target.id, type: target.type }, targetName: target.name });
      }
      if (collisions.length) setMovePrompt({ items, targetId, collisions });
      else await executeMove(items, targetId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "대상 폴더를 확인하지 못했습니다."); }
  }
  async function dropOnFolder(event: DragEvent<HTMLElement>, targetId: string | null) {
    event.preventDefault(); event.stopPropagation(); setDropFolderId(null);
    if (isTrash) return;
    if (event.dataTransfer.files.length) { await uploadFiles(event.dataTransfer.files, targetId); return; }
    const files = JSON.parse(event.dataTransfer.getData(FILE_DRAG) || "[]") as string[];
    const folders = JSON.parse(event.dataTransfer.getData(FOLDER_DRAG) || "[]") as string[];
    const items: NodeRef[] = [...files.map((id) => ({ id, type: "file" as const })), ...folders.map((id) => ({ id, type: "folder" as const }))];
    await requestMove(items, targetId);
    setDraggingItems([]);
  }
  function beginRename(item: NodeRef) {
    const sidebarFile = item.type === "file" && !listing.files.some((file) => file.id === item.id) ? sidebarFiles.find((file) => file.id === item.id) : undefined;
    if (sidebarFile) {
      const name = window.prompt("파일 이름", sidebarFile.name)?.trim();
      if (name && name !== sidebarFile.name) void commitRename(item, name);
      return;
    }
    const name = item.type === "folder"
      ? listing.folders.find((folder) => folder.id === item.id)?.name ?? pinned.find((folder) => folder.id === item.id)?.name ?? ""
      : listing.files.find((file) => file.id === item.id)?.name ?? "";
    setEditName({ key: keyOf(item), value: name });
    window.setTimeout(() => { const input = document.querySelector<HTMLInputElement>('[data-edit-key="' + keyOf(item) + '"]'); input?.focus(); input?.select(); }, 0);
  }
  async function pasteClipboard() {
    if (!clipboard?.items.length) return;
    setBusy(clipboard.action === "cut" ? "이동하는 중" : "복사하는 중");
    try {
      for (const item of clipboard.items) {
        if (clipboard.action === "cut") await moveNode(item, current.id);
        else if (item.type === "file") await api("/api/files/" + item.id + "/copy", {
          body: JSON.stringify({ folderId: current.id }), headers: { "Content-Type": "application/json" }, method: "POST"
        });
        else await api("/api/folders/" + item.id + "/copy", {
          body: JSON.stringify({ folderId: current.id }), headers: { "Content-Type": "application/json" }, method: "POST"
        });
      }
      if (clipboard.action === "cut") setClipboard(null);
      await loadListing(current.id, query);
    } catch (error) { setNotice(error instanceof Error ? error.message : "붙여넣지 못했습니다."); }
    finally { setBusy(""); }
  }
  async function download(item: NodeRef) {
    if (item.type === "folder") {
      const response = await fetch("/api/download-zip", {
        body: JSON.stringify({ items: [{ type: "folder", id: item.id }] }),
        headers: { "Content-Type": "application/json" }, method: "POST", credentials: "same-origin"
      });
      if (!response.ok) { setNotice("폴더를 압축하지 못했습니다."); return; }
      const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(await response.blob());
      anchor.download = (listing.folders.find((folder) => folder.id === item.id)?.name ?? "폴더") + ".zip";
      anchor.click(); URL.revokeObjectURL(anchor.href);
    } else window.location.assign("/api/files/" + item.id + "/download");
  }
  async function downloadSelection() {
    if (selectedRefs.length === 1) { await download(selectedRefs[0]); return; }
    const response = await fetch("/api/download-zip", {
      body: JSON.stringify({ items: selectedRefs }), headers: { "Content-Type": "application/json" },
      method: "POST", credentials: "same-origin"
    });
    if (!response.ok) { setNotice("선택 항목을 압축하지 못했습니다."); return; }
    const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(await response.blob());
    anchor.download = "선택한 항목.zip"; anchor.click(); URL.revokeObjectURL(anchor.href);
  }
  async function compressItems(items: NodeRef[], format: "zip" | "7z" | "tar") {
    if (!items.length) return;
    setCompressMenu(false); setContextMenu(null); setBusy("압축 파일을 만드는 중"); setNotice("");
    try {
      const response = await fetch("/api/download-zip", {
        body: JSON.stringify({ format, items }), headers: { "Content-Type": "application/json" },
        method: "POST", credentials: "same-origin"
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "압축 파일을 만들지 못했습니다.");
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = objectUrl;
      const itemName = items.length === 1 ? (items[0].type === "folder" ? listing.folders.find((folder) => folder.id === items[0].id)?.name ?? pinned.find((folder) => folder.id === items[0].id)?.name : listing.files.find((file) => file.id === items[0].id)?.name ?? sidebarFiles.find((file) => file.id === items[0].id)?.name) : "선택한 항목";
      anchor.download = (itemName || "선택한 항목") + "." + format; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) { setNotice(error instanceof Error ? error.message : "압축 파일을 만들지 못했습니다."); }
    finally { setBusy(""); }
  }
  function showItemContext(event: MouseEvent, item: NodeRef) {
    event.preventDefault();
    if (!selected.includes(keyOf(item))) setSelected([keyOf(item)]);
    setContextMenu({ x: event.clientX, y: event.clientY, item });
  }
  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setAuthMessage("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        body: JSON.stringify({ username, password }), headers: { "Content-Type": "application/json" }, method: "POST"
      });
      setUser(result.user);
    } catch (error) { setAuthMessage(error instanceof Error ? error.message : "로그인하지 못했습니다."); }
    finally { setAuthBusy(false); }
  }
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    setUser(null); setListing({ files: [], folders: [] }); setPinned([]); setSidebarFiles([]); setSelected([]); setCrumbs([HOME]); setIsTrash(false);
  }

  useEffect(() => {
    function shortcuts(event: globalThis.KeyboardEvent) {
      if (!user) return;
      const typing = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
      if (event.key === "Escape") { setContextMenu(null); setMovePrompt(null); setNewMenu(false); setSortMenu(false); setCompressMenu(false); setCrumbMenu(null); setAddressEditing(false); return; }
      if (typing) return;
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "_", "Add", "Subtract"].includes(event.key)) {
        event.preventDefault(); setPreviewZoom((value) => Math.max(0.5, Math.min(3, value + (["-", "_", "Subtract"].includes(event.key) ? -0.1 : 0.1)))); return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "n" && !isTrash) { event.preventDefault(); createFolder(); }
      else if (mod && event.key.toLowerCase() === "f") { event.preventDefault(); searchInput.current?.focus(); }
      else if (mod && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected([...visibleFolders.map((folder) => "folder:" + folder.id), ...visibleFiles.map((file) => "file:" + file.id)]); }
      else if (mod && event.key.toLowerCase() === "c" && !isTrash) { event.preventDefault(); setClipboard({ action: "copy", items: selectedRefs }); }
      else if (mod && event.key.toLowerCase() === "x" && !isTrash) { event.preventDefault(); setClipboard({ action: "cut", items: selectedRefs }); }
      else if (mod && event.key.toLowerCase() === "v" && !isTrash) { event.preventDefault(); void pasteClipboard(); }
      else if (event.key === "F2" && selectedRefs[0] && !isTrash) { event.preventDefault(); beginRename(selectedRefs[0]); }
      else if (event.key === "Delete" && selectedRefs.length) { event.preventDefault(); if (isTrash) void permanentlyDeleteItems(selectedRefs); else void deleteItems(selectedRefs); }
      else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); }
      else if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); goForward(); }
      else if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); goUp(); }
      else if (event.key === "Backspace") { event.preventDefault(); goBack(); }
      else if (event.key === "Enter" && archiveSelected) { event.preventDefault(); openArchiveEntry(archiveSelected); }
      else if (event.key === "Enter" && selectedRefs.length === 1) { event.preventDefault(); openNode(selectedRefs[0]); }
      else if (event.key === " " && selectedFile) { event.preventDefault(); void loadPreview(selectedFile); }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [user, visibleFolders, visibleFiles, selectedRefs, selectedFile, selected, isTrash, archiveView, archiveSelected]);

  useEffect(() => {
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".win-new-menu-anchor")) setNewMenu(false);
      if (!event.target.closest(".win-sort-anchor")) setSortMenu(false);
      if (!event.target.closest(".win-compress-anchor")) setCompressMenu(false);
      if (!event.target.closest(".win-address")) setCrumbMenu(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  useEffect(() => {
    const panel = document.querySelector<HTMLElement>(".win-preview-top");
    if (!panel) return;
    const zoomWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setPreviewZoom((value) => Math.max(0.5, Math.min(3, value + (event.deltaY < 0 ? 0.08 : -0.08))));
    };
    panel.addEventListener("wheel", zoomWheel, { passive: false });
    return () => panel.removeEventListener("wheel", zoomWheel);
  }, [user, preview]);

  if (authLoading) return <main className="win-login-page"><LoaderCircle className="win-spin" /></main>;
  if (!user) return <main className="win-login-page"><form className="win-login-card" onSubmit={handleLogin}>
    <Image alt="" aria-hidden="true" height={48} src="/brand-icon.png" width={48} /><h1>내 클라우드</h1>
    <label>아이디<input autoComplete="username" autoCapitalize="none" onChange={(event) => setUsername(event.target.value)} required value={username} /></label>
    <label>비밀번호<input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
    <button disabled={authBusy} type="submit">{authBusy ? "로그인 중…" : "로그인"}</button>
  </form>{authMessage ? <div className="win-toast win-login-toast" role="alert"><span>{authMessage}</span><button aria-label="알림 닫기" onClick={() => setAuthMessage("")} type="button"><X /></button></div> : null}</main>;

  const resizeColumn = (target: "modified" | "type" | "size", event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); resizeState.current = { target, x: event.clientX, width: columnWidth[target] };
    document.body.classList.add("win-is-resizing");
  };
  const selectedLabel = archiveView ? archiveSelected ? "1개 항목 선택함" + (archiveSelected.size ? "  " + formatFileSize(archiveSelected.size) : "") : archiveView.entries.length + "개 항목" : selected.length ? selected.length + "개 항목 선택함" + (selectedBytes ? "  " + formatFileSize(selectedBytes) : "") : totalItems + "개 항목";
  const baseCrumbs = isTrash ? trashCrumbs : crumbs;
  const addressCrumbs = archiveView ? [...baseCrumbs, { id: "__archive__", name: archiveView.file.name }, ...archiveView.path.split("/").filter(Boolean).map((name, index) => ({ id: "__archive_path_" + index, name }))] : baseCrumbs;
  const showSidebarItems = isTrash ? trashCrumbs.length === 1 : !archiveView && crumbs.length === 1;
  const usedGb = (storage.usedBytes / (1024 ** 3)).toFixed(3);
  const quotaGb = (storage.quotaBytes / (1024 ** 3)).toFixed(2);

  return <main className={"win-shell " + (sidebarOpen ? "is-sidebar-open " : "")} data-theme={theme} onDragOver={(event) => !archiveView && dropOver(event, isTrash ? null : current.id)} onDrop={(event) => !archiveView && void dropOnFolder(event, isTrash ? null : current.id)} style={{ "--win-preview-width": previewWidth + "px", "--win-modified-width": columnWidth.modified + "px", "--win-type-width": columnWidth.type + "px", "--win-size-width": columnWidth.size + "px" } as CSSProperties}>
    <input className="win-hidden" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => void uploadFiles(event.target.files)} ref={fileInput} type="file" />
    <input className="win-hidden" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => void uploadFiles(event.target.files)} ref={folderInput} type="file" {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)} />
    {notice || busy ? <div className={"win-toast " + (notice ? "is-error" : "")} role={notice ? "alert" : "status"}>
      {notice ? <span>{notice}</span> : <><LoaderCircle className="win-spin" /><span>{busy}</span></>}
      {notice ? <button aria-label="알림 닫기" onClick={() => setNotice("")} type="button"><X /></button> : null}
    </div> : null}

    <header className="win-navigation">
      <button aria-label="사이드바 열기" className="win-mobile-sidebar-toggle" onClick={() => setSidebarOpen(true)} type="button"><Menu /></button>
      <div className="win-nav-buttons">
        <button aria-label="뒤로" disabled={isTrash ? trashCrumbs.length <= 1 && !archiveView : !archiveView && crumbs.length <= 1} onClick={goBack} title="뒤로" type="button"><ArrowLeft /></button>
        <button aria-label="앞으로" disabled={isTrash || archiveView !== null || historyIndex >= history.length - 1} onClick={goForward} title="앞으로" type="button"><ArrowRight /></button>
        <button aria-label="상위 폴더" disabled={isTrash ? trashCrumbs.length <= 1 && !archiveView : !archiveView && crumbs.length <= 1} onClick={goUp} title="상위 폴더" type="button"><ArrowUp /></button>
        <button aria-label="새로 고침" onClick={() => void refresh()} title="새로 고침" type="button"><RefreshCw /></button>
      </div>
      <div className={"win-address " + (addressEditing ? "is-editing" : "")} onClick={(event) => { if ((event.target as HTMLElement).closest("button,input")) return; setAddressValue(addressCrumbs.map((crumb) => crumb.name).join(" > ")); setAddressEditing(true); }}>
        <HardDrive aria-hidden="true" className="win-address-drive" />
        {addressEditing ? <input autoFocus aria-label="주소 입력" onFocus={(event) => event.currentTarget.select()} onChange={(event) => setAddressValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void commitAddress(); if (event.key === "Escape") setAddressEditing(false); }} onBlur={() => setAddressEditing(false)} value={addressValue} /> :
          <div className="win-breadcrumbs">
            {addressCrumbs.map((crumb, index) => <span className="win-crumb" key={(crumb.id ?? "root") + "-" + index}>
              {index ? <button aria-label={(addressCrumbs[index - 1]?.name ?? "폴더") + " 하위 폴더"} className="win-crumb-separator-button" onClick={() => { if (!archiveView && !isTrash) void showChildFolders(index - 1); }} type="button"><ChevronRight aria-hidden="true" className="win-crumb-separator" /></button> : null}
              <button onClick={() => chooseAddressCrumb(index)} onDragOver={(event) => !isTrash && !archiveView && dropOver(event, crumb.id)} onDrop={(event) => !isTrash && !archiveView && void dropOnFolder(event, crumb.id)} type="button">{crumb.name}</button>
              {!isTrash && !archiveView ? <button aria-label={crumb.name + " 하위 폴더"} className="win-crumb-menu-button" onClick={() => void showChildFolders(index)} type="button"><ChevronDown /></button> : null}
              {!isTrash && !archiveView && crumbMenu === index ? <div className="win-crumb-menu">{crumbChildren.length ? crumbChildren.map((folder) => <button key={folder.id} onClick={() => { setCrumbMenu(null); void navigate(folder); }} type="button"><ExplorerFolderIcon />{folder.name}</button>) : <span>하위 폴더가 없습니다.</span>}</div> : null}
            </span>)}
          </div>}
      </div>
      <label className="win-search"><Search aria-hidden="true" /><input aria-label={current.name + " 검색"} onChange={(event) => setQuery(event.target.value)} placeholder={current.name + " 검색"} ref={searchInput} value={query} />{query ? <button aria-label="검색 지우기" onClick={() => setQuery("")} type="button"><X /></button> : null}</label>
    </header>

    <nav aria-label="파일 작업" className="win-toolbar">
      {archiveView ? null : isTrash ? <>
        <button className="win-toolbar-trash-action win-trash-empty" disabled={!totalItems} onClick={() => void emptyTrash()} type="button"><Trash2 /><span>휴지통 비우기</span></button>
        <button className="win-toolbar-trash-action" disabled={!selected.length} onClick={() => void restoreItems(selectedRefs)} type="button"><ArrowUp /><span>선택 항목 복원</span></button>
        <button className="win-toolbar-trash-action" disabled={!selected.length} onClick={() => void permanentlyDeleteItems(selectedRefs)} type="button"><Trash2 /><span>영구 삭제</span></button>
      </> : <>
      <div className="win-new-menu-anchor"><button className="win-toolbar-new" onClick={() => setNewMenu((open) => !open)} type="button"><Plus /><span>새로 만들기</span><ChevronDown className="win-small-chevron" /></button>
        {newMenu ? <div className="win-menu win-dropdown"><button onClick={createFolder} type="button"><ExplorerFolderIcon />폴더</button><button onClick={() => { setNewMenu(false); fileInput.current?.click(); }} type="button"><Upload />파일 업로드</button><button onClick={() => { setNewMenu(false); folderInput.current?.click(); }} type="button"><FolderPlus />폴더 업로드</button></div> : null}
      </div>
      <span className="win-toolbar-divider" />
      <button aria-label="잘라내기" disabled={!selected.length} onClick={() => setClipboard({ action: "cut", items: selectedRefs })} title="잘라내기" type="button"><Scissors /></button>
      <button aria-label="복사" disabled={!selected.length} onClick={() => setClipboard({ action: "copy", items: selectedRefs })} title="복사" type="button"><Copy /></button>
      <button aria-label="붙여넣기" disabled={!clipboard?.items.length} onClick={() => void pasteClipboard()} title="붙여넣기" type="button"><Clipboard /></button>
      <button aria-label="이름 바꾸기" disabled={!selectedSingle} onClick={() => selectedSingle && beginRename(selectedSingle)} title="이름 바꾸기" type="button"><Pencil /></button>
      <button aria-label="삭제" disabled={!selected.length} onClick={() => void deleteItems(selectedRefs)} title="삭제" type="button"><Trash2 /></button>
      <span className="win-toolbar-divider" />
      <div className="win-compress-anchor"><button aria-label="압축" disabled={!selected.length} onClick={() => setCompressMenu((open) => !open)} title="선택 항목 압축" type="button"><Archive /><ChevronDown className="win-small-chevron" /></button>
        {compressMenu ? <div className="win-menu win-dropdown win-compress-menu"><p>압축 형식</p>
          <button onClick={() => void compressItems(selectedRefs, "zip")} type="button"><Archive />ZIP으로 압축</button>
          <button onClick={() => void compressItems(selectedRefs, "7z")} type="button"><Archive />7z으로 압축</button>
          <button onClick={() => void compressItems(selectedRefs, "tar")} type="button"><Archive />TAR로 압축</button>
        </div> : null}
      </div>
      <span className="win-toolbar-divider" />
      <div className="win-sort-anchor"><button className="win-sort-button" onClick={() => setSortMenu((open) => !open)} type="button"><span className="win-sort-glyph"><ArrowUp /><ArrowDown /></span><span>정렬</span><ChevronDown className="win-small-chevron" /></button>
        {sortMenu ? <div className="win-menu win-dropdown win-sort-menu"><p>정렬 기준</p>
          {([["name", "이름"], ["modified", "수정한 날짜"], ["type", "유형"], ["size", "크기"]] as Array<[SortBy, string]>).map(([value, label]) => <button key={value} onClick={() => { setSortBy(value); setSortMenu(false); }} type="button">{sortBy === value ? <Check /> : <span className="win-menu-spacer" />}{label}</button>)}
          <hr /><button onClick={() => { setDescending(false); setSortMenu(false); }} type="button">{!descending ? <Check /> : <span className="win-menu-spacer" />}오름차순</button><button onClick={() => { setDescending(true); setSortMenu(false); }} type="button">{descending ? <Check /> : <span className="win-menu-spacer" />}내림차순</button>
        </div> : null}
      </div>
      </>}
      <span className="win-toolbar-spacer" /><span className="win-toolbar-location">{archiveView ? archiveView.file.name + " 내부 항목" : current.name}</span>
    </nav>

    <aside className="win-sidebar">
      {showSidebarItems ? <div className="win-sidebar-heading">{isTrash ? "삭제된 항목" : "고정됨"}</div> : null}
      <div className="win-pinned-list">
        {showSidebarItems ? isTrash ? <>
          {listing.folders.map((folder) => <button className={"win-sidebar-item " + (selected.includes("folder:" + folder.id) ? "is-current" : "")} key={folder.id} onClick={() => navigateTrashFolder(folder)} onContextMenu={(event) => showItemContext(event, { id: folder.id, type: "folder" })} type="button"><ExplorerFolderIcon /><span title={folder.name}>{folder.name}</span></button>)}
          {listing.files.map((file) => <button className={"win-sidebar-item " + (selected.includes("file:" + file.id) ? "is-current" : "")} key={file.id} onClick={() => { setSidebarOpen(false); setSelected(["file:" + file.id]); }} onContextMenu={(event) => showItemContext(event, { id: file.id, type: "file" })} type="button"><span className={"win-file-icon win-file-" + getPreviewKind(file.mime_type, file.name)}><FileKindIcon file={file} /></span><span title={file.name}>{file.name}</span></button>)}
        </> : <>
          {pinned.map((folder) => <button className={"win-sidebar-item " + (current.id === folder.id ? "is-current " : "") + (dropFolderId === folder.id ? " is-drop-target" : "")} draggable key={folder.id} onClick={() => { setSidebarOpen(false); void navigate(folder); }} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, pinned: folder }); }} onDragStart={(event) => itemDragStart(event, { id: folder.id, type: "folder" })} onDragEnd={() => { setDraggingItems([]); setDropFolderId(null); }} onDragOver={(event) => dropOver(event, folder.id)} onDrop={(event) => void dropOnFolder(event, folder.id)} type="button"><ExplorerFolderIcon /><span title={folder.name}>{folder.name}</span><Pin aria-hidden="true" className="win-pin" /></button>)}
          {sidebarFiles.map((file) => <button className={"win-sidebar-item " + (selected.includes("file:" + file.id) ? "is-current" : "")} draggable key={file.id} onClick={() => { setSidebarOpen(false); setSelected(["file:" + file.id]); }} onDoubleClick={() => openNode({ id: file.id, type: "file" })} onContextMenu={(event) => showItemContext(event, { id: file.id, type: "file" })} onDragStart={(event) => itemDragStart(event, { id: file.id, type: "file" })} onDragEnd={() => { setDraggingItems([]); setDropFolderId(null); }} type="button"><span className={"win-file-icon win-file-" + getPreviewKind(file.mime_type, file.name)}><FileKindIcon file={file} /></span><span title={file.name}>{file.name}</span></button>)}
        </> : null}
      </div>
      <div className="win-sidebar-footer">
        <button className="win-sidebar-item win-trash-sidebar" onClick={() => { setSidebarOpen(false); if (isTrash) { setIsTrash(false); setSelected([]); setQuery(""); } else showTrash(); }} type="button">{isTrash ? <HardDrive /> : <TrashIcon filled={trashHasItems} />}<span>{isTrash ? "내 클라우드" : "휴지통"}</span></button>
        <div aria-hidden="true" className="win-sidebar-divider" />
        <div className="win-sidebar-bottom"><div><span>저장 공간</span><strong>사용 중 {usedGb} GB / 전체 {quotaGb} GB</strong></div><div aria-label={"저장 공간 " + usedGb + " GB / " + quotaGb + " GB"} className="win-storage-meter"><span style={{ width: (storage.quotaBytes ? Math.min(100, storage.usedBytes / storage.quotaBytes * 100) : 0) + "%" }} /></div></div>
        <button className="win-theme-toggle" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? <Sun /> : <Moon />}{theme === "dark" ? "라이트 모드" : "다크 모드"}</button>
        <button className="win-signout" onClick={() => void signOut()} type="button"><LogOut />로그아웃 · {user.username}</button>
      </div>
    </aside>
    {sidebarOpen ? <button aria-label="사이드바 닫기" className="win-sidebar-backdrop" onClick={() => setSidebarOpen(false)} type="button" /> : null}

    <section className="win-file-area" onDragOver={(event) => !archiveView && dropOver(event, current.id)} onDrop={(event) => !archiveView && void dropOnFolder(event, current.id)}>
      {archiveView ? <>
        <div className="win-table-head" role="row"><div className="win-name-head">이름</div><div className="win-name-head">수정한 날짜</div><div className="win-name-head">유형</div><div className="win-name-head">크기</div></div>
        <div className="win-items">
          {archiveView.entries.map((entry) => {
            const file: CloudFile = { ...archiveView.file, name: entry.name, mime_type: "application/octet-stream", size_bytes: entry.size };
            return <div aria-selected={archiveSelected?.path === entry.path} className={"win-row " + (archiveSelected?.path === entry.path ? "is-selected" : "")} key={entry.path} onClick={() => { setArchiveSelected(entry); if (entry.type === "file") void loadArchivePreview(entry); else setPreview({ status: "idle" }); }} onDoubleClick={() => openArchiveEntry(entry)} role="row" tabIndex={0}>
              <div className="win-cell win-cell-name">{entry.type === "folder" ? <ExplorerFolderIcon /> : <span className={"win-file-icon win-file-" + getPreviewKind(file.mime_type, file.name)}><FileKindIcon file={file} /></span>}<span title={entry.name}>{entry.name}</span></div>
              <span className="win-cell win-cell-modified" /><span className="win-cell win-cell-type">{entry.type === "folder" ? "파일 폴더" : fileType(file)}</span><span className="win-cell win-cell-size">{entry.type === "folder" ? "" : formatFileSize(entry.size)}</span>
            </div>;
          })}
          {!archiveView.entries.length ? <div className="win-empty">압축 파일이 비어 있습니다.</div> : null}
        </div>
      </> : <>
      {view === "details" ? <div className="win-table-head" role="row">
        <button className="win-name-head" onClick={() => { setSortBy("name"); setDescending((value) => sortBy === "name" ? !value : false); }} type="button">이름{sortBy === "name" ? <span>{descending ? " ↓" : " ↑"}</span> : null}</button>
        {(["modified", "type", "size"] as const).map((column) => <div className={"win-col-head win-col-" + column} key={column}><button onClick={() => { setSortBy(column); setDescending((value) => sortBy === column ? !value : false); }} type="button">{isTrash ? (column === "modified" ? "원래 위치" : column === "type" ? "삭제한 날짜" : "크기") : (column === "modified" ? "수정한 날짜" : column === "type" ? "유형" : "크기")}{!isTrash && sortBy === column ? <span>{descending ? " ↓" : " ↑"}</span> : null}</button>{!isTrash ? <button aria-label={column + " 열 너비 조절"} className="win-column-resizer" onPointerDown={(event) => resizeColumn(column, event)} type="button" /> : null}</div>)}
      </div> : null}
      <div className={"win-items " + (view === "icons" ? "is-icons " : "") + (virtualized ? "is-virtualized" : "")} onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }} onPointerDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); setSelectionBox({ startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY }); } }} onDragOver={(event) => dropOver(event, current.id)} onDrop={(event) => void dropOnFolder(event, current.id)} onScroll={(event) => setItemsViewport({ height: event.currentTarget.clientHeight, scrollTop: event.currentTarget.scrollTop, width: event.currentTarget.clientWidth })} ref={itemsViewportRef} style={virtualized ? { height: Math.ceil(totalItems / virtualColumns) * virtualRowHeight, flex: "0 0 auto" } : undefined}>
        {selectionBox ? <div aria-hidden="true" className="win-selection-rectangle" style={{ left: Math.min(selectionBox.startX, selectionBox.x), top: Math.min(selectionBox.startY, selectionBox.y), width: Math.abs(selectionBox.x - selectionBox.startX), height: Math.abs(selectionBox.y - selectionBox.startY) }} /> : null}
        {newFolderDraft ? <div className={"win-row " + (view === "icons" ? "win-tile" : "")}><ExplorerFolderIcon /><input aria-label="새 폴더 이름" data-new-folder-input value={editName?.value ?? "새 폴더"} onChange={(event) => setEditName({ key: "new-folder", value: event.target.value })} onBlur={() => { if (newFolderDraft) void saveNewFolder(editName?.value ?? "새 폴더"); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveNewFolder(editName?.value ?? "새 폴더"); } if (event.key === "Escape") { setNewFolderDraft(false); setEditName(null); } }} /></div> : null}
        {renderFolders.map((folder, localIndex) => { const index = visibleStart + localIndex; return <div aria-selected={selected.includes("folder:" + folder.id)} className={"win-row " + (view === "icons" ? "win-tile " : "") + (selected.includes("folder:" + folder.id) ? "is-selected " : "") + (dropFolderId === folder.id ? "is-drop-target" : "")} data-item-key={"folder:" + folder.id} draggable={!isTrash} onClick={(event) => changeSelection("folder", folder.id, event)} onContextMenu={(event) => showItemContext(event, { id: folder.id, type: "folder" })} onDoubleClick={() => openNode({ id: folder.id, type: "folder" })} onDragStart={(event) => itemDragStart(event, { id: folder.id, type: "folder" })} onDragEnd={() => { setDraggingItems([]); setDropFolderId(null); }} onDragOver={(event) => dropOver(event, folder.id)} onDrop={(event) => void dropOnFolder(event, folder.id)} key={folder.id} role="row" style={virtualStyle(index)} tabIndex={0}>
          <div className="win-cell win-cell-name"><ExplorerFolderIcon />{editName?.key === "folder:" + folder.id ? <input aria-label="폴더 이름" data-edit-key={"folder:" + folder.id} value={editName.value} onBlur={() => void commitRename({ id: folder.id, type: "folder" }, editName.value)} onChange={(event) => setEditName({ ...editName, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitRename({ id: folder.id, type: "folder" }, editName.value); } if (event.key === "Escape") setEditName(null); }} /> : <span title={folder.name}>{folder.name}</span>}</div>
          <span className="win-cell win-cell-modified">{isTrash ? (folder.original_path ?? "내 클라우드") : dateLabel(folder.updated_at)}</span><span className="win-cell win-cell-type">{isTrash ? dateLabel(folder.deleted_at ?? folder.updated_at) : "파일 폴더"}</span><span className="win-cell win-cell-size" />
        </div>; })}
        {renderFiles.map((file, localIndex) => { const index = visibleFolders.length + firstFileIndex + localIndex; return <div aria-selected={selected.includes("file:" + file.id)} className={"win-row " + (view === "icons" ? "win-tile " : "") + (selected.includes("file:" + file.id) ? "is-selected" : "")} data-item-key={"file:" + file.id} draggable={!isTrash} onClick={(event) => changeSelection("file", file.id, event)} onContextMenu={(event) => showItemContext(event, { id: file.id, type: "file" })} onDoubleClick={() => openNode({ id: file.id, type: "file" })} onDragStart={(event) => itemDragStart(event, { id: file.id, type: "file" })} onDragEnd={() => { setDraggingItems([]); setDropFolderId(null); }} key={file.id} role="row" style={virtualStyle(index)} tabIndex={0}>
          <div className="win-cell win-cell-name">{view === "icons" && getPreviewKind(file.mime_type, file.name) === "image" ? <img alt="" className="win-icon-thumbnail" loading="lazy" src={"/api/files/" + file.id + "/content"} /> : <span className={"win-file-icon win-file-" + getPreviewKind(file.mime_type, file.name)}><FileKindIcon file={file} /></span>}{editName?.key === "file:" + file.id ? <input aria-label="파일 이름" data-edit-key={"file:" + file.id} value={editName.value} onBlur={() => void commitRename({ id: file.id, type: "file" }, editName.value)} onChange={(event) => setEditName({ ...editName, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitRename({ id: file.id, type: "file" }, editName.value); } if (event.key === "Escape") setEditName(null); }} /> : <span title={file.name}>{file.name}</span>}</div>
          <span className="win-cell win-cell-modified">{isTrash ? (file.original_path ?? "내 클라우드") : dateLabel(file.updated_at)}</span><span className="win-cell win-cell-type">{isTrash ? dateLabel(file.deleted_at ?? file.updated_at) : fileType(file)}</span><span className="win-cell win-cell-size">{formatFileSize(Number(file.size_bytes))}</span>
        </div>; })}
        {totalItems === 0 && !newFolderDraft && (isTrash || current.id !== null) ? <div className="win-empty">{isTrash && trashCrumbs.length === 1 ? "휴지통이 비어 있습니다." : "이 폴더는 비어 있습니다."}</div> : null}
      </div>
      </>}
    </section>

    <aside className="win-preview-panel">
      <button aria-label="미리보기 패널 너비 조절" className="win-preview-resizer" onPointerDown={(event) => { event.preventDefault(); resizeState.current = { target: "preview", x: event.clientX, width: previewWidth }; document.body.classList.add("win-is-resizing"); }} type="button" />
      <div className="win-preview-top" onPointerDown={(event) => { if (event.ctrlKey) { event.preventDefault(); previewDragY.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={(event) => { if (previewDragY.current !== null) { const delta = previewDragY.current - event.clientY; previewDragY.current = event.clientY; setPreviewZoom((value) => Math.max(0.5, Math.min(3, value + delta * 0.01))); } }} onPointerUp={() => { previewDragY.current = null; }}>
        <div className="win-preview-zoom" style={{ zoom: previewZoom }}>
        {archiveView ? archiveSelected?.type === "file" ? <PreviewContent preview={preview} /> : archiveSelected ? <div className="win-folder-summary"><ExplorerFolderIcon className="is-large" /><strong>{archiveSelected.name}</strong><span>{archiveSelected.type === "folder" ? "폴더" : formatFileSize(archiveSelected.size)}</span></div> : <div className="win-folder-summary"><Archive className="win-archive-summary-icon" /><strong>{archiveView.file.name}</strong><span>{archiveView.entries.length}개 항목</span></div>
          : selected.length > 1 ? <div className="win-selection-summary"><div className="win-summary-icon"><FileText /></div><strong>{selected.length}개 항목 선택됨</strong><span>{formatFileSize(selectedBytes)}</span></div>
          : selectedFolder ? <div className="win-folder-summary"><ExplorerFolderIcon className="is-large" /><strong>{selectedFolder.name}</strong><span>{folderChildCount ?? 0}개 항목</span></div>
            : selectedFile && getPreviewKind(selectedFile.mime_type, selectedFile.name) === "archive" ? <div className="win-preview-placeholder"><Archive /></div>
              : selectedFile ? <PreviewContent preview={preview} />
              : <div className="win-folder-summary"><ExplorerFolderIcon className="is-large" /><strong>{current.name}</strong><span>{totalItems}개 항목</span></div>}
        </div>
      </div>
    </aside>

    <footer className="win-statusbar"><span>{selectedLabel}</span>{uploadProgress ? <div aria-label="업로드 진행률" className="win-upload-progress" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={uploadProgress.percent}>
      <span>{uploadProgress.total > 1 ? `${uploadProgress.current}/${uploadProgress.total} 업로드 중 · ` : ""}{uploadProgress.fileName}</span><strong>{uploadProgress.percent}%</strong><i><b style={{ width: uploadProgress.percent + "%" }} /></i>
    </div> : null}<div className="win-view-switch">
      <button aria-label="자세히 보기" aria-pressed={view === "details"} className={view === "details" ? "is-active" : ""} onClick={() => setView("details")} title="자세히" type="button"><List /></button>
      <button aria-label="큰 아이콘" aria-pressed={view === "icons"} className={view === "icons" ? "is-active" : ""} onClick={() => setView("icons")} title="큰 아이콘" type="button"><Grid2X2 /></button>
    </div></footer>

    {movePrompt ? <div className="win-dialog-backdrop" onClick={() => setMovePrompt(null)}><section aria-labelledby="win-move-conflict-title" aria-modal="true" className="win-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
      <h2 id="win-move-conflict-title">같은 이름의 항목이 있습니다</h2><p>기존 항목을 덮어쓰거나, 새 이름으로 이동할 수 있습니다. 덮어쓴 항목은 휴지통으로 이동합니다.</p>
      <div className="win-conflict-list">{movePrompt.collisions.map((collision) => <div key={keyOf(collision.source)}><span>{collision.sourceName}</span><span>→</span><span>{collision.targetName}</span></div>)}</div>
      <div className="win-dialog-actions"><button onClick={() => setMovePrompt(null)} type="button">취소</button><button onClick={() => void executeMove(movePrompt.items, movePrompt.targetId, movePrompt.collisions, false)} type="button">이름 변경</button><button className="is-primary" onClick={() => void executeMove(movePrompt.items, movePrompt.targetId, movePrompt.collisions, true)} type="button">덮어쓰기</button></div>
    </section></div> : null}
    {contextMenu ? <div className="win-context-backdrop" onClick={() => setContextMenu(null)}><div className="win-menu win-context-menu" onClick={(event) => event.stopPropagation()} style={{ left: Math.min(contextMenu.x, window.innerWidth - 235), top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 360)) }}>
      {contextMenu.pinned ? <>
        <button onClick={() => { setContextMenu(null); void navigate(contextMenu.pinned!); }} type="button"><ExplorerFolderIcon />열기</button>
        <button onClick={() => { setContextMenu(null); void renamePinned(contextMenu.pinned!); }} type="button"><Pencil />이름 바꾸기</button>
        <button onClick={() => void togglePin(contextMenu.pinned!, false)} type="button"><PinOff />고정 해제</button>
        <button className="is-danger" onClick={() => { setContextMenu(null); void deleteItems([{ id: contextMenu.pinned!.id, type: "folder" }]); }} type="button"><Trash2 />삭제</button>
      </> : contextMenu.item && isTrash ? <>
        <button onClick={() => { const item = contextMenu.item!; setContextMenu(null); void restoreItems([item]); }} type="button"><ArrowUp />복원</button>
        <button className="is-danger" onClick={() => { const item = contextMenu.item!; setContextMenu(null); void permanentlyDeleteItems([item]); }} type="button"><Trash2 />영구 삭제</button>
      </> : contextMenu.item ? <>
        <button onClick={() => { setContextMenu(null); openNode(contextMenu.item!); }} type="button"><ArrowRight />열기</button>
        <button onClick={() => { setContextMenu(null); beginRename(contextMenu.item!); }} type="button"><Pencil />이름 바꾸기</button>
        <button onClick={() => { setClipboard({ action: "cut", items: [contextMenu.item!] }); setContextMenu(null); }} type="button"><Scissors />잘라내기</button>
        <button onClick={() => { setClipboard({ action: "copy", items: [contextMenu.item!] }); setContextMenu(null); }} type="button"><Copy />복사</button>
        {([["zip", "ZIP"], ["7z", "7z"], ["tar", "TAR"]] as const).map(([format, label]) => <button key={format} onClick={() => void compressItems(selected.includes(keyOf(contextMenu.item!)) ? selectedRefs : [contextMenu.item!], format)} type="button"><Archive />{label}으로 압축</button>)}
        <button onClick={() => { setContextMenu(null); void (selectedRefs.length > 1 ? downloadSelection() : download(contextMenu.item!)); }} type="button"><ArrowDown />{selectedRefs.length > 1 ? "선택 항목 다운로드" : "다운로드"}</button>
        {contextMenu.item.type === "folder" ? <button onClick={() => { const folder = listing.folders.find((entry) => entry.id === contextMenu.item?.id); if (folder) void togglePin(folder, !folder.is_pinned); else setContextMenu(null); }} type="button">{contextMenu.item && listing.folders.find((entry) => entry.id === contextMenu.item?.id)?.is_pinned ? <PinOff /> : <Pin />}{contextMenu.item && listing.folders.find((entry) => entry.id === contextMenu.item?.id)?.is_pinned ? "고정 해제" : "사이드바에 고정"}</button> : null}
        <button className="is-danger" onClick={() => { setContextMenu(null); void deleteItems([contextMenu.item!]); }} type="button"><Trash2 />휴지통으로 이동</button>
      </> : null}
    </div></div> : null}
  </main>;
}

function PreviewContent({ preview }: { preview: Preview }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const codeLines = useMemo(() => preview.status === "ready" && preview.kind === "text" && !preview.file.name.toLowerCase().endsWith(".csv")
    ? hljs.highlightAuto(preview.text ?? "").value.split(/\r?\n/)
    : [], [preview]);
  useEffect(() => { setActiveSheet(0); }, [preview.status === "ready" ? preview.file.id : ""]);
  if (preview.status === "idle") return <div className="win-preview-placeholder"><FileText /></div>;
  if (preview.status === "loading") return <div className="win-preview-placeholder"><LoaderCircle className="win-spin" /></div>;
  if (preview.status === "error") return <div className="win-preview-placeholder"><FileKindIcon file={preview.file} /><span>{preview.message}</span></div>;
  if (preview.status === "blocked") return <div className="win-preview-large-notice"><FileKindIcon file={preview.file} /><strong>파일이 커서 미리보기를 지원하지 않습니다</strong><span>{formatFileSize(Number(preview.file.size_bytes))}</span></div>;
  if (preview.kind === "archive") return <div className="win-preview-placeholder"><Archive /><span>압축 파일을 열면 내부 항목을 탐색할 수 있습니다.</span></div>;
  if (preview.kind === "image") return <img alt={preview.file.name} className="win-preview-image" src={preview.url} />;
  if (preview.kind === "pdf") return <iframe className="win-preview-frame" src={preview.url} title={preview.file.name} />;
  if (preview.kind === "audio") return <div className="win-preview-media"><FileAudio /><audio controls src={preview.url} /></div>;
  if (preview.kind === "video") return <video className="win-preview-media-video" controls src={preview.url} />;
  if (preview.kind === "text") {
    if (preview.file.name.toLowerCase().endsWith(".csv")) {
      const rows = (preview.text ?? "").split(/\r?\n/).slice(0, 80).map((row) => row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).slice(0, 12));
      return <div className="win-preview-table-scroll"><table className="win-preview-table"><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell.replace(/^"|"$/g, "")}</td>)}</tr>)}</tbody></table></div>;
    }
    return <pre className="win-preview-code"><code>{codeLines.map((line, index) => <span key={index}><i>{index + 1}</i><b dangerouslySetInnerHTML={{ __html: line || " " }} /></span>)}</code></pre>;
  }
  if (preview.kind === "document" && preview.docxBuffer) return <DocxCanvas buffer={preview.docxBuffer} />;
  if (preview.kind === "spreadsheet" && preview.spreadsheet) {
    const sheet = preview.spreadsheet.sheets[Math.min(activeSheet, preview.spreadsheet.sheets.length - 1)];
    return <div className="win-spreadsheet-preview">
      <div aria-label="시트 선택" className="win-preview-sheet-tabs" role="tablist">{preview.spreadsheet.sheets.map((entry, index) => <button aria-selected={activeSheet === index} className={activeSheet === index ? "is-active" : ""} key={entry.name} onClick={() => setActiveSheet(index)} role="tab" type="button">{entry.name}</button>)}</div>
      <div className="win-preview-table-scroll"><table className="win-preview-table"><tbody>{sheet?.rows.slice(0, 100).map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 24).map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
    </div>;
  }
  return <div className="win-preview-placeholder"><FileKindIcon file={preview.file} /><span>미리 볼 수 없습니다.</span></div>;
}

function DocxCanvas({ buffer }: { buffer: ArrayBuffer }) {
  const styleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void import("docx-preview").then(({ renderAsync }) => {
      if (!active || !contentRef.current || !styleRef.current) return;
      return renderAsync(new Blob([buffer]), contentRef.current, styleRef.current, { breakPages: true, className: "win-docx-page", renderHeaders: true, renderFooters: true });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (contentRef.current) contentRef.current.replaceChildren(); if (styleRef.current) styleRef.current.replaceChildren(); };
  }, [buffer]);
  if (failed) return <div className="win-preview-placeholder"><FileText /><span>Word 문서를 렌더링하지 못했습니다.</span></div>;
  return <div className="win-docx-render"><div ref={styleRef} /><div ref={contentRef} /></div>;
}
