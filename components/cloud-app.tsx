"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ChevronRight,
  Cloud,
  Download,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Home,
  Loader2,
  LogOut,
  Pencil,
  RefreshCcw,
  Search,
  Trash2,
  Upload
} from "lucide-react";
import { formatFileSize, getPreviewKind } from "@/lib/file-utils";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import type { CloudFile, Folder as CloudFolder, FolderListing, PreviewKind } from "@/lib/types";

type Breadcrumb = {
  id: string | null;
  name: string;
};

type PreviewState =
  | { status: "idle"; file: null }
  | { status: "loading"; file: CloudFile }
  | {
      status: "ready";
      file: CloudFile;
      kind: PreviewKind;
      text?: string;
      url: string;
    }
  | { status: "error"; file: CloudFile | null; message: string };

type PreviewResponse = {
  kind: PreviewKind;
  url: string;
};

type DownloadResponse = {
  fileName: string;
  url: string;
};

const ROOT_BREADCRUMB: Breadcrumb = {
  id: null,
  name: "내 드라이브"
};

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

  if (kind === "text" || kind === "pdf" || kind === "office") {
    return <FileText aria-hidden="true" />;
  }

  return <File aria-hidden="true" />;
}

export function CloudApp() {
  const supabase = useMemo(() => {
    try {
      return getBrowserSupabase();
    } catch {
      return null;
    }
  }, []);

  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([ROOT_BREADCRUMB]);
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [listingLoading, setListingLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    file: null,
    status: "idle"
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewRequestRef = useRef(0);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session);
        setAuthLoading(false);
      }
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
      if (!nextSession) {
        setBreadcrumbs([ROOT_BREADCRUMB]);
        setFolders([]);
        setFiles([]);
        setPreview({ file: null, status: "idle" });
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (!supabase) {
        throw new Error("Supabase 환경 변수가 필요합니다.");
      }

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        throw new Error("로그인이 필요합니다.");
      }

      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);

      return fetch(input, {
        ...init,
        headers
      });
    },
    [supabase]
  );

  const loadListing = useCallback(
    async (folderId: string | null) => {
      setListingLoading(true);
      setNotice(null);

      try {
        const params = new URLSearchParams();
        if (folderId) {
          params.set("parentId", folderId);
        }

        const response = await authFetch(`/api/folders?${params.toString()}`);
        const data = await parseApiResponse<FolderListing>(response);
        setFolders(data.folders);
        setFiles(data.files);
      } catch (error) {
        const message = error instanceof Error ? error.message : "목록을 불러오지 못했습니다.";
        setNotice(message);
      } finally {
        setListingLoading(false);
      }
    },
    [authFetch]
  );

  useEffect(() => {
    if (session) {
      void loadListing(currentFolderId);
    }
  }, [currentFolderId, loadListing, session]);

  const filteredFolders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return folders;
    }

    return folders.filter((folder) => folder.name.toLowerCase().includes(normalized));
  }, [folders, query]);

  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return files;
    }

    return files.filter((file) => file.name.toLowerCase().includes(normalized));
  }, [files, query]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setAuthSubmitting(true);
    setAuthMessage(null);

    const result =
      authMode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) {
      setAuthMessage(result.error.message);
    } else if (authMode === "signup" && !result.data.session) {
      setAuthMessage("가입 확인 메일을 확인하세요.");
    }

    setAuthSubmitting(false);
  }

  async function handleSignOut() {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
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

      await parseApiResponse<{ folder: CloudFolder }>(response);
      setNewFolderName("");
      await loadListing(currentFolderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "폴더를 만들지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    const selected = Array.from(fileList);
    setBusyLabel(`${selected.length}개 파일 업로드 중`);
    setNotice(null);

    try {
      for (const file of selected) {
        const formData = new FormData();
        formData.append("file", file);
        if (currentFolderId) {
          formData.append("folderId", currentFolderId);
        }

        const response = await authFetch("/api/files/upload", {
          body: formData,
          method: "POST"
        });

        await parseApiResponse<{ file: CloudFile }>(response);
      }

      await loadListing(currentFolderId);
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
      let text: string | undefined;

      if (data.kind === "text") {
        const textResponse = await fetch(data.url);
        if (!textResponse.ok) {
          throw new Error("문서 내용을 불러오지 못했습니다.");
        }
        text = await textResponse.text();
      }

      if (previewRequestRef.current !== requestId) {
        return;
      }

      setPreview({
        file,
        kind: data.kind,
        status: "ready",
        text,
        url: data.url
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "미리보기를 열지 못했습니다.";
      setPreview({ file, message, status: "error" });
    }
  }

  async function downloadFile(file: CloudFile) {
    setBusyLabel("다운로드 준비 중");
    setNotice(null);

    try {
      const response = await authFetch(`/api/files/${file.id}/download`);
      const data = await parseApiResponse<DownloadResponse>(response);
      const anchor = document.createElement("a");
      anchor.href = data.url;
      anchor.download = data.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      const message = error instanceof Error ? error.message : "다운로드를 시작하지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
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
      await parseApiResponse<{ folder: CloudFolder }>(response);
      setBreadcrumbs((previous) =>
        previous.map((crumb) => (crumb.id === folder.id ? { ...crumb, name } : crumb))
      );
      await loadListing(currentFolderId);
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
      await loadListing(currentFolderId);
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
      await loadListing(currentFolderId);
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
      await loadListing(currentFolderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "파일을 삭제하지 못했습니다.";
      setNotice(message);
    } finally {
      setBusyLabel(null);
    }
  }

  function openFolder(folder: CloudFolder) {
    setPreview({ file: null, status: "idle" });
    setQuery("");
    setBreadcrumbs((previous) => [
      ...previous,
      {
        id: folder.id,
        name: folder.name
      }
    ]);
  }

  function handleTileKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    action: () => void
  ) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  }

  if (!supabase) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <Cloud aria-hidden="true" className="auth-logo" />
          <h1>Personal Cloud</h1>
          <p className="auth-error">Supabase 환경 변수가 설정되지 않았습니다.</p>
        </section>
      </main>
    );
  }

  if (authLoading) {
    return (
      <main className="auth-page">
        <section className="auth-panel compact">
          <Loader2 aria-hidden="true" className="spin auth-logo" />
          <h1>Personal Cloud</h1>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <Cloud aria-hidden="true" className="auth-logo" />
          <h1>Personal Cloud</h1>
          <form onSubmit={handleAuthSubmit} className="auth-form">
            <label>
              이메일
              <input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label>
              비밀번호
              <input
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                minLength={6}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {authMessage ? <p className="auth-error">{authMessage}</p> : null}
            <button className="primary-button" disabled={authSubmitting} type="submit">
              {authSubmitting ? <Loader2 aria-hidden="true" className="spin" /> : null}
              {authMode === "login" ? "로그인" : "가입"}
            </button>
          </form>
          <button
            className="text-button"
            onClick={() => {
              setAuthMessage(null);
              setAuthMode((mode) => (mode === "login" ? "signup" : "login"));
            }}
            type="button"
          >
            {authMode === "login" ? "새 계정 만들기" : "로그인으로 돌아가기"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <input
        multiple
        onChange={(event: ChangeEvent<HTMLInputElement>) => void uploadFiles(event.target.files)}
        ref={fileInputRef}
        type="file"
        className="hidden-input"
      />

      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-icon">
            <Cloud aria-hidden="true" />
          </div>
          <div>
            <strong>Personal Cloud</strong>
            <span>{session.user.email}</span>
          </div>
        </div>

        <form className="folder-form" onSubmit={createFolder}>
          <label htmlFor="folder-name">폴더</label>
          <div className="inline-control">
            <input
              id="folder-name"
              maxLength={80}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="새 폴더"
              value={newFolderName}
            />
            <button
              aria-label="폴더 만들기"
              className="icon-button"
              disabled={Boolean(busyLabel)}
              title="폴더 만들기"
              type="submit"
            >
              <FolderPlus aria-hidden="true" />
            </button>
          </div>
        </form>

        <button
          className="wide-button"
          disabled={Boolean(busyLabel)}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <Upload aria-hidden="true" />
          업로드
        </button>

        <div className="storage-summary">
          <div>
            <span>폴더</span>
            <strong>{folders.length}</strong>
          </div>
          <div>
            <span>파일</span>
            <strong>{files.length}</strong>
          </div>
        </div>

        <button className="signout-button" onClick={() => void handleSignOut()} type="button">
          <LogOut aria-hidden="true" />
          로그아웃
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <nav aria-label="현재 경로" className="breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span className="breadcrumb-item" key={`${crumb.id ?? "root"}-${index}`}>
                {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
                <button
                  onClick={() => {
                    setPreview({ file: null, status: "idle" });
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
            <label className="search-box">
              <Search aria-hidden="true" />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="검색"
                value={query}
              />
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
              <h1>{breadcrumbs[breadcrumbs.length - 1]?.name}</h1>
              <span>
                {filteredFolders.length} 폴더 · {filteredFiles.length} 파일
              </span>
            </div>
          </div>

          {listingLoading ? (
            <div className="loading-state">
              <Loader2 aria-hidden="true" className="spin" />
            </div>
          ) : filteredFolders.length === 0 && filteredFiles.length === 0 ? (
            <div className="empty-state">비어 있음</div>
          ) : (
            <div className="items-grid">
              {filteredFolders.map((folder) => (
                <article className="item-tile folder-tile" key={folder.id}>
                  <button
                    className="tile-main"
                    onClick={() => openFolder(folder)}
                    onKeyDown={(event) => handleTileKeyDown(event, () => openFolder(folder))}
                    type="button"
                  >
                    <span className="tile-icon folder-icon">
                      <Folder aria-hidden="true" />
                    </span>
                    <span className="tile-copy">
                      <strong title={folder.name}>{folder.name}</strong>
                      <span>{formatDate(folder.updated_at)}</span>
                    </span>
                  </button>
                  <div className="tile-actions">
                    <button
                      aria-label="폴더 이름 변경"
                      className="mini-icon-button"
                      onClick={() => void renameFolder(folder)}
                      title="폴더 이름 변경"
                      type="button"
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      aria-label="폴더 삭제"
                      className="mini-icon-button danger"
                      onClick={() => void deleteFolder(folder)}
                      title="폴더 삭제"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}

              {filteredFiles.map((file) => (
                <article
                  className={`item-tile ${preview.file?.id === file.id ? "selected" : ""}`}
                  key={file.id}
                >
                  <button
                    className="tile-main"
                    onClick={() => void selectFile(file)}
                    onKeyDown={(event) => handleTileKeyDown(event, () => void selectFile(file))}
                    type="button"
                  >
                    <span className="tile-icon file-icon">
                      <FileKindIcon file={file} />
                    </span>
                    <span className="tile-copy">
                      <strong title={file.name}>{file.name}</strong>
                      <span>
                        {formatFileSize(file.size_bytes)} · {formatDate(file.updated_at)}
                      </span>
                    </span>
                  </button>
                  <div className="tile-actions">
                    <button
                      aria-label="다운로드"
                      className="mini-icon-button"
                      onClick={() => void downloadFile(file)}
                      title="다운로드"
                      type="button"
                    >
                      <Download aria-hidden="true" />
                    </button>
                    <button
                      aria-label="파일 이름 변경"
                      className="mini-icon-button"
                      onClick={() => void renameFile(file)}
                      title="파일 이름 변경"
                      type="button"
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      aria-label="파일 삭제"
                      className="mini-icon-button danger"
                      onClick={() => void deleteFile(file)}
                      title="파일 삭제"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>

      <PreviewPanel
        onDownload={(file) => void downloadFile(file)}
        preview={preview}
      />
    </main>
  );
}

function PreviewPanel({
  onDownload,
  preview
}: {
  onDownload: (file: CloudFile) => void;
  preview: PreviewState;
}) {
  const file = preview.file;

  return (
    <aside className="preview-panel">
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
