import {
  parseOfficeXml,
  readOfficeTextEntry,
  readOfficeZipEntries
} from "@/lib/office-zip";

export type DocxPreviewBlock =
  | {
      text: string;
      type: "paragraph";
    }
  | {
      rows: string[][];
      type: "table";
    };

export type DocxPreview = {
  blocks: DocxPreviewBlock[];
  truncated: boolean;
};

const MAX_DOCX_BLOCKS = 90;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 40;

function localName(element: Element) {
  return element.localName || element.nodeName.split(":").pop() || element.nodeName;
}

function directChildrenByName(element: Element, name: string) {
  return Array.from(element.children).filter((child) => localName(child) === name);
}

function descendantsByName(element: Element, name: string) {
  return Array.from(element.getElementsByTagName("*")).filter(
    (child) => localName(child) === name
  );
}

function firstDescendantByName(root: Document, name: string) {
  return Array.from(root.getElementsByTagName("*")).find(
    (element) => localName(element) === name
  );
}

function extractWordText(element: Element) {
  const parts: string[] = [];

  function walk(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const child = node as Element;
    const name = localName(child);

    if (name === "t") {
      parts.push(child.textContent ?? "");
      return;
    }

    if (name === "tab") {
      parts.push("\t");
      return;
    }

    if (name === "br" || name === "cr") {
      parts.push("\n");
      return;
    }

    for (const nested of Array.from(child.childNodes)) {
      walk(nested);
    }
  }

  walk(element);

  return parts.join("").replace(/\u00a0/g, " ").trim();
}

function parseParagraph(paragraph: Element): DocxPreviewBlock | null {
  const text = extractWordText(paragraph);

  if (!text) {
    return null;
  }

  return {
    text,
    type: "paragraph"
  };
}

function getCellText(cell: Element) {
  const paragraphs = descendantsByName(cell, "p")
    .map((paragraph) => extractWordText(paragraph))
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs.join(" ");
  }

  return extractWordText(cell);
}

function parseTable(table: Element) {
  const rowElements = directChildrenByName(table, "tr");
  const rows: string[][] = [];
  let truncated =
    rowElements.length > MAX_TABLE_ROWS ||
    rowElements.some((row) => directChildrenByName(row, "tc").length > MAX_TABLE_COLUMNS);

  for (const rowElement of rowElements.slice(0, MAX_TABLE_ROWS)) {
    const cells = directChildrenByName(rowElement, "tc")
      .slice(0, MAX_TABLE_COLUMNS)
      .map((cell) => getCellText(cell));

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) {
    return null;
  }

  return {
    block: {
      rows,
      type: "table" as const
    },
    truncated
  };
}

function parseDocumentBlocks(documentXml: string): DocxPreview {
  const document = parseOfficeXml(documentXml);
  const body = firstDescendantByName(document, "body");

  if (!body) {
    throw new Error("Word 문서 본문을 찾지 못했습니다.");
  }

  const blocks: DocxPreviewBlock[] = [];
  let truncated = false;

  for (const child of Array.from(body.children)) {
    if (blocks.length >= MAX_DOCX_BLOCKS) {
      truncated = true;
      break;
    }

    if (localName(child) === "p") {
      const paragraph = parseParagraph(child);
      if (paragraph) {
        blocks.push(paragraph);
      }
    }

    if (localName(child) === "tbl") {
      const table = parseTable(child);
      if (table) {
        blocks.push(table.block);
        truncated = truncated || table.truncated;
      }
    }
  }

  return {
    blocks,
    truncated
  };
}

export async function parseDocxPreview(buffer: ArrayBuffer): Promise<DocxPreview> {
  const entries = readOfficeZipEntries(buffer);
  const documentXml = await readOfficeTextEntry(buffer, entries, "word/document.xml");

  if (!documentXml) {
    throw new Error("Word 문서 내용을 찾지 못했습니다.");
  }

  return parseDocumentBlocks(documentXml);
}

