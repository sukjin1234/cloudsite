const SIGNATURES = {
  centralDirectoryHeader: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
  localFileHeader: 0x04034b50
};

export type OfficeZipEntry = {
  compressedSize: number;
  localHeaderOffset: number;
  method: number;
  name: string;
};

function findEndOfCentralDirectory(view: DataView) {
  const minOffset = Math.max(0, view.byteLength - 66000);

  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === SIGNATURES.endOfCentralDirectory) {
      return offset;
    }
  }

  throw new Error("Office 파일 구조를 읽지 못했습니다.");
}

export function readOfficeZipEntries(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const eocdOffset = findEndOfCentralDirectory(view);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map<string, OfficeZipEntry>();

  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(offset, true) !== SIGNATURES.centralDirectoryHeader) {
      throw new Error("Office 파일 목록을 읽지 못했습니다.");
    }

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
    const name = decoder.decode(nameBytes);

    entries.set(name, {
      compressedSize,
      localHeaderOffset,
      method,
      name
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function decompressRaw(data: Uint8Array) {
  if (!("DecompressionStream" in globalThis)) {
    throw new Error("이 브라우저는 Office 미리보기에 필요한 압축 해제를 지원하지 않습니다.");
  }

  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const stream = new Blob([buffer]).stream().pipeThrough(
    new DecompressionStream("deflate-raw")
  );

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readOfficeZipEntry(
  buffer: ArrayBuffer,
  entry: OfficeZipEntry
) {
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;

  if (view.getUint32(offset, true) !== SIGNATURES.localFileHeader) {
    throw new Error("Office 파일 내용을 읽지 못했습니다.");
  }

  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = new Uint8Array(buffer, dataOffset, entry.compressedSize);

  if (entry.method === 0) {
    return compressed;
  }

  if (entry.method === 8) {
    return decompressRaw(compressed);
  }

  throw new Error("지원하지 않는 Office 압축 형식입니다.");
}

export async function readOfficeTextEntry(
  buffer: ArrayBuffer,
  entries: Map<string, OfficeZipEntry>,
  path: string
) {
  const entry = entries.get(path);

  if (!entry) {
    return null;
  }

  const bytes = await readOfficeZipEntry(buffer, entry);
  return new TextDecoder().decode(bytes);
}

export function parseOfficeXml(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const error = document.getElementsByTagName("parsererror")[0];

  if (error) {
    throw new Error("Office XML을 해석하지 못했습니다.");
  }

  return document;
}

export function normalizeOfficePartPath(baseDir: string, target: string) {
  if (target.startsWith("/")) {
    return target.replace(/^\/+/, "");
  }

  const parts = baseDir.split("/").filter(Boolean);

  for (const segment of target.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  return parts.join("/");
}

