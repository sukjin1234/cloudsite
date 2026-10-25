const decoder = new TextDecoder();

function decodeXml(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attribute(attributes, name) {
  const escaped = name.replace(":", "\\:");
  return decodeXml(new RegExp("(?:^|\\s)" + escaped + '="([^"]*)"').exec(attributes)?.[1] ?? "");
}

function zipDirectory(buffer) {
  const view = new DataView(buffer);
  const minOffset = Math.max(0, view.byteLength - 66000);
  let endOffset = -1;
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("Excel ZIP 구조를 읽지 못했습니다.");
  const totalEntries = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const entries = new Map();
  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Excel 파일 목록을 읽지 못했습니다.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
    entries.set(name, { compressedSize, localHeaderOffset, method });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEntry(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("Excel 파일 내용을 읽지 못했습니다.");
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = new Uint8Array(buffer, dataOffset, entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method !== 8) throw new Error("지원하지 않는 Excel 압축 방식입니다.");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function columnIndex(reference, fallback) {
  const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase();
  if (!letters) return fallback;
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function parseRows(xml, sharedStrings) {
  const rowElements = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)];
  let truncated = rowElements.length > 100;
  const rows = rowElements.slice(0, 100).map(([, rowXml]) => {
    const row = [];
    let fallback = 0;
    for (const match of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const attrs = match[1];
      const body = match[2] ?? "";
      const index = columnIndex(attribute(attrs, "r"), fallback);
      fallback = index + 1;
      if (index >= 24) { truncated = true; continue; }
      const type = attribute(attrs, "t");
      const value = decodeXml(/<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? "");
      const inlineText = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(([, text]) => decodeXml(text)).join("");
      row[index] = type === "s" ? sharedStrings[Number(value)] ?? "" : type === "inlineStr" ? inlineText : type === "b" ? value === "1" ? "TRUE" : "FALSE" : value;
    }
    while (row.length && !row.at(-1)) row.pop();
    return row;
  });
  return { rows, truncated };
}

async function parseFirstSheet(buffer) {
  const entries = zipDirectory(buffer);
  const workbook = decoder.decode(await readEntry(buffer, entries, "xl/workbook.xml") ?? new Uint8Array());
  const relationships = decoder.decode(await readEntry(buffer, entries, "xl/_rels/workbook.xml.rels") ?? new Uint8Array());
  if (!workbook) throw new Error("Excel 통합 문서를 찾지 못했습니다.");
  const sheetAttributes = /<sheet\b([^>]*?)(?:\/>|>)/i.exec(workbook)?.[1];
  if (!sheetAttributes) throw new Error("Excel 시트를 찾지 못했습니다.");
  const sheetName = attribute(sheetAttributes, "name") || "Sheet1";
  const relationshipId = attribute(sheetAttributes, "r:id");
  const relationship = [...relationships.matchAll(/<Relationship\b([^>]*?)(?:\/>|>)/gi)]
    .map(([, attrs]) => ({ id: attribute(attrs, "Id"), target: attribute(attrs, "Target") }))
    .find((item) => item.id === relationshipId);
  const sheetPath = relationship?.target.startsWith("/") ? relationship.target.slice(1) : "xl/" + (relationship?.target || "worksheets/sheet1.xml");
  const sharedXml = decoder.decode(await readEntry(buffer, entries, "xl/sharedStrings.xml") ?? new Uint8Array());
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(([, item]) =>
    [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(([, text]) => decodeXml(text)).join("")
  );
  const sheetXml = decoder.decode(await readEntry(buffer, entries, sheetPath) ?? new Uint8Array());
  if (!sheetXml) throw new Error("Excel 시트 내용을 찾지 못했습니다.");
  const sheet = { name: sheetName, ...parseRows(sheetXml, sharedStrings) };
  return { rows: sheet.rows, sheetName, sheets: [sheet], truncated: sheet.truncated };
}

self.onmessage = async (event) => {
  try {
    const spreadsheet = await parseFirstSheet(event.data.buffer);
    self.postMessage({ ok: true, spreadsheet });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Excel 미리보기를 만들지 못했습니다.", ok: false });
  }
};
