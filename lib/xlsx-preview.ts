import {
  normalizeOfficePartPath,
  parseOfficeXml,
  readOfficeTextEntry,
  readOfficeZipEntries
} from "@/lib/office-zip";

export type SpreadsheetPreview = {
  rows: string[][];
  sheetName: string;
  truncated: boolean;
  sheets: Array<{ name: string; rows: string[][]; truncated: boolean }>;
};

const MAX_PREVIEW_COLUMNS = 24;
const MAX_PREVIEW_ROWS = 100;

function getWorkbookRelationships(relsXml: string | null) {
  const relationships = new Map<string, string>();

  if (!relsXml) {
    return relationships;
  }

  const document = parseOfficeXml(relsXml);

  for (const relationship of Array.from(document.getElementsByTagName("Relationship"))) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");

    if (id && target) {
      relationships.set(id, normalizeOfficePartPath("xl", target));
    }
  }

  return relationships;
}

function getWorksheetPaths(workbookXml: string, relsXml: string | null) {
  const workbook = parseOfficeXml(workbookXml);
  const sheets = Array.from(workbook.getElementsByTagName("sheet"));
  if (!sheets.length) {
    throw new Error("Excel 시트를 찾지 못했습니다.");
  }
  const relationships = getWorkbookRelationships(relsXml);
  return sheets.map((sheet, index) => {
    const relationshipId = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    return { name: sheet.getAttribute("name") || `Sheet${index + 1}`, path: (relationshipId ? relationships.get(relationshipId) : null) || `xl/worksheets/sheet${index + 1}.xml` };
  });
}

function parseSharedStrings(sharedStringsXml: string | null) {
  if (!sharedStringsXml) {
    return [];
  }

  const document = parseOfficeXml(sharedStringsXml);

  return Array.from(document.getElementsByTagName("si")).map((item) =>
    item.textContent?.trim() ?? ""
  );
}

function getCellColumnIndex(reference: string | null, fallback: number) {
  const letters = reference?.toUpperCase().match(/^[A-Z]+/)?.[0];

  if (!letters) {
    return fallback;
  }

  let index = 0;
  for (const letter of letters) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }

  return index - 1;
}

function getCellText(cell: Element, sharedStrings: string[]) {
  const type = cell.getAttribute("t");
  const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";

  if (type === "s") {
    const index = Number(value);
    return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
  }

  if (type === "inlineStr") {
    return cell.textContent?.trim() ?? "";
  }

  if (type === "b") {
    return value === "1" ? "TRUE" : "FALSE";
  }

  return value;
}

function trimTrailingEmptyCells(row: string[]) {
  let end = row.length;

  while (end > 0 && !row[end - 1]) {
    end -= 1;
  }

  return row.slice(0, end);
}

function parseWorksheetRows(sheetXml: string, sharedStrings: string[]) {
  const document = parseOfficeXml(sheetXml);
  const rowElements = Array.from(document.getElementsByTagName("row"));
  const rows: string[][] = [];
  let truncated = rowElements.length > MAX_PREVIEW_ROWS;

  for (const rowElement of rowElements.slice(0, MAX_PREVIEW_ROWS)) {
    const row: string[] = [];
    let fallbackColumn = 0;

    for (const cell of Array.from(rowElement.getElementsByTagName("c"))) {
      const columnIndex = getCellColumnIndex(cell.getAttribute("r"), fallbackColumn);
      fallbackColumn = columnIndex + 1;

      if (columnIndex >= MAX_PREVIEW_COLUMNS) {
        truncated = true;
        continue;
      }

      row[columnIndex] = getCellText(cell, sharedStrings);
    }

    rows.push(trimTrailingEmptyCells(row));
  }

  return {
    rows,
    truncated
  };
}

export async function parseXlsxPreview(buffer: ArrayBuffer): Promise<SpreadsheetPreview> {
  const entries = readOfficeZipEntries(buffer);
  const [workbookXml, relsXml, sharedStringsXml] = await Promise.all([
    readOfficeTextEntry(buffer, entries, "xl/workbook.xml"),
    readOfficeTextEntry(buffer, entries, "xl/_rels/workbook.xml.rels"),
    readOfficeTextEntry(buffer, entries, "xl/sharedStrings.xml")
  ]);

  if (!workbookXml) {
    throw new Error("Excel 통합 문서를 찾지 못했습니다.");
  }

  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const sheets = await Promise.all(getWorksheetPaths(workbookXml, relsXml).map(async ({ name, path }) => {
    const sheetXml = await readOfficeTextEntry(buffer, entries, path);
    if (!sheetXml) throw new Error(`Excel 시트(${name}) 내용을 찾지 못했습니다.`);
    return { name, ...parseWorksheetRows(sheetXml, sharedStrings) };
  }));

  return { rows: sheets[0].rows, sheetName: sheets[0].name, truncated: sheets.some((sheet) => sheet.truncated), sheets };
}

