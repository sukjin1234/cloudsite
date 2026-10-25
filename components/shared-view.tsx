"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, File, FileText, Folder, LockKeyhole, Loader2, Pencil, Trash2 } from "lucide-react";
import { formatFileSize } from "@/lib/file-utils";

type SharedData = {
  type: "file" | "folder";
  permission: "read" | "edit";
  rootId?: string;
  folder?: { id: string; parent_id: string | null; name: string };
  folders?: Array<{ id: string; parent_id: string | null; name: string }>;
  files?: Array<{ id: string; folder_id: string | null; name: string; mime_type: string; size_bytes: number }>;
  file?: { id: string; name: string; mime_type: string; size_bytes: number };
};

export function SharedView({ token }: { token: string }) {
  const [data, setData] = useState<SharedData | null>(null);
  const [password, setPassword] = useState("");
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);

  const load = useCallback(async (nextParentId: string | null = null, pass = "") => {
    setLoading(true);
    setError("");
    try {
      const url = new URL(`/api/shares/${token}`, window.location.origin);
      if (nextParentId) url.searchParams.set("parentId", nextParentId);
      const response = await fetch(url, { headers: { "X-Share-Password": pass } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) setPasswordNeeded(true);
        throw new Error(payload.error ?? "공유 항목을 열지 못했습니다.");
      }
      setPasswordNeeded(false);
      setParentId(nextParentId);
      setData(payload as SharedData);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "공유 항목을 열지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(null, ""); }, [load]);

  async function download(id: string, name: string) {
    const response = await fetch(`/api/shares/${token}/content`, { headers: { "X-Share-Password": password } });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "파일을 다운로드하지 못했습니다.");
      return;
    }
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(href);
    void id;
  }

  async function rename(type: "file" | "folder", id: string, currentName: string) {
    const name = window.prompt("이름 변경", currentName)?.trim();
    if (!name || name === currentName) return;
    const response = await fetch(`/api/shares/${token}`, {
      body: JSON.stringify({ id, name, type }),
      headers: { "Content-Type": "application/json", "X-Share-Password": password },
      method: "PATCH"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "이름을 바꾸지 못했습니다.");
      return;
    }
    await load(parentId, password);
  }

  async function moveToTrash(type: "file" | "folder", id: string, name: string) {
    if (!window.confirm(`'${name}' 항목을 휴지통으로 이동할까요?`)) return;
    const response = await fetch(`/api/shares/${token}`, {
      body: JSON.stringify({ id, type }),
      headers: { "Content-Type": "application/json", "X-Share-Password": password },
      method: "DELETE"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "항목을 이동하지 못했습니다.");
      return;
    }
    await load(parentId, password);
  }

  return <main className="shared-page">
    <section className="shared-card">
      <div className="shared-brand"><Folder aria-hidden="true" /><span>내 클라우드 공유</span></div>
      {loading ? <div className="shared-state"><Loader2 className="spin" aria-hidden="true" /> 불러오는 중</div> : null}
      {passwordNeeded ? <form className="shared-password" onSubmit={(event) => { event.preventDefault(); void load(parentId, password); }}>
        <LockKeyhole aria-hidden="true" /><h1>비밀번호가 필요합니다</h1>
        <input autoComplete="current-password" aria-label="공유 비밀번호" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        <button className="primary-button" type="submit">열기</button>
      </form> : null}
      {!loading && !passwordNeeded && data?.type === "file" && data.file ? <div className="shared-file">
        <span className="shared-file-icon"><FileText aria-hidden="true" /></span><h1>{data.file.name}</h1>
        <p>{data.file.mime_type} · {formatFileSize(data.file.size_bytes)}</p>
        <div className="shared-file-actions"><button className="primary-button" onClick={() => void download(data.file!.id, data.file!.name)} type="button"><Download aria-hidden="true" /> 다운로드</button>{data.permission === "edit" ? <><button aria-label="파일 이름 변경" className="icon-button" onClick={() => void rename("file", data.file!.id, data.file!.name)} type="button"><Pencil aria-hidden="true" /></button><button aria-label="파일을 휴지통으로 이동" className="icon-button" onClick={() => void moveToTrash("file", data.file!.id, data.file!.name)} type="button"><Trash2 aria-hidden="true" /></button></> : null}</div>
      </div> : null}
      {!loading && !passwordNeeded && data?.type === "folder" ? <>
        <header className="shared-folder-header">
          {parentId && parentId !== data.rootId ? <button className="text-button" onClick={() => void load(data.folder?.parent_id ?? data.rootId ?? null, password)} type="button">이전 폴더</button> : null}
          <h1>{data.folder?.name ?? "공유 폴더"}</h1>
          <span>{(data.folders?.length ?? 0) + (data.files?.length ?? 0)}개 항목 · {data.permission === "edit" ? "편집 가능" : "읽기 전용"}</span>
        </header>
        <div className="shared-list">
          {data.folders?.map((folder) => <div className="shared-folder-row" key={folder.id}><button onClick={() => void load(folder.id, password)} type="button"><Folder aria-hidden="true" /><span>{folder.name}</span></button>{data.permission === "edit" ? <><button aria-label={`${folder.name} 이름 변경`} onClick={() => void rename("folder", folder.id, folder.name)} type="button"><Pencil aria-hidden="true" /></button><button aria-label={`${folder.name} 휴지통으로 이동`} onClick={() => void moveToTrash("folder", folder.id, folder.name)} type="button"><Trash2 aria-hidden="true" /></button></> : null}</div>)}
          {data.files?.map((file) => <div className="shared-file-row" key={file.id}><span><File aria-hidden="true" />{file.name}</span><small>{formatFileSize(file.size_bytes)}</small>{data.permission === "edit" ? <button aria-label={`${file.name} 이름 변경`} onClick={() => void rename("file", file.id, file.name)} type="button"><Pencil aria-hidden="true" /></button> : null}<button aria-label={`${file.name} 다운로드`} onClick={() => void download(file.id, file.name)} type="button"><Download aria-hidden="true" /></button>{data.permission === "edit" ? <button aria-label={`${file.name} 휴지통으로 이동`} onClick={() => void moveToTrash("file", file.id, file.name)} type="button"><Trash2 aria-hidden="true" /></button> : null}</div>)}
          {!data.folders?.length && !data.files?.length ? <p className="shared-empty">폴더가 비어 있습니다.</p> : null}
        </div>
      </> : null}
      {error ? <p className="shared-error" role="alert">{error}</p> : null}
      <footer>암호화된 연결로 공유 중</footer>
    </section>
  </main>;
}
