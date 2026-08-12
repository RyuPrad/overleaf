import type { TLRichText, TLRecord } from "tldraw";

export const DEFAULT_ASSISTANT_TEXT_WIDTH = 640;

const MIN_READABLE_TEXT_WIDTH = 320;
const MAX_READABLE_TEXT_WIDTH = 900;
const LONG_SINGLE_LINE_LENGTH = 160;
const LEGACY_AUTO_SIZE_WIDTH = 32;
const LEGACY_COLUMN_TOLERANCE = 80;
const LEGACY_BLOCK_MARGIN = 128;

export function normalizeTextShapeProps(props: Record<string, unknown>) {
  const dimensionlessProps = { ...props };
  delete dimensionlessProps.h;
  delete dimensionlessProps.height;
  if (typeof dimensionlessProps.text !== "string") return dimensionlessProps;

  const { text, ...rest } = dimensionlessProps;
  const normalizedText = normalizeLineBreaks(text);
  const shouldWrap =
    normalizedText.includes("\n") ||
    normalizedText.length > LONG_SINGLE_LINE_LENGTH;

  return {
    ...rest,
    ...(shouldWrap
      ? {
          w: readableWidth(rest.w),
          autoSize: false,
        }
      : {}),
    richText: plainTextToRichText(normalizedText),
  };
}

/**
 * Early assistant transactions double-escaped line breaks before they reached
 * tldraw. Those records have a distinctive auto-sized, near-zero-width text
 * shape. Repair them during replay so already-applied work becomes readable.
 */
export function repairLegacyAssistantTextRecord(record: TLRecord): TLRecord {
  const candidate = record as TLRecord & {
    typeName?: string;
    type?: string;
    props?: Record<string, unknown>;
  };
  const props = candidate.props;

  if (
    candidate.typeName !== "shape" ||
    candidate.type !== "text" ||
    !props ||
    props.autoSize !== true ||
    typeof props.w !== "number" ||
    props.w > LEGACY_AUTO_SIZE_WIDTH
  ) {
    return record;
  }

  const escapedText = singlePlainTextNode(props.richText);
  if (!escapedText?.includes("\\n")) return record;

  return {
    ...candidate,
    props: normalizeTextShapeProps({ ...props, text: escapedText }),
  } as TLRecord;
}

export function repairLegacyAssistantTextRecords(
  records: TLRecord[],
): TLRecord[] {
  const normalized = records.map((record) => ({
    legacy: isLegacyAssistantTextRecord(record),
    record: repairLegacyAssistantTextRecord(record),
  }));
  const columns: Array<{
    parentId: unknown;
    x: number;
    records: Array<{ index: number; record: TextShapeRecord }>;
  }> = [];

  normalized.forEach((entry, index) => {
    const record = entry.record;
    if (!entry.legacy || !isPositionedTextShape(record)) return;
    let column = columns.find(
      (candidate) =>
        candidate.parentId === record.parentId &&
        Math.abs(candidate.x - record.x) <= LEGACY_COLUMN_TOLERANCE,
    );
    if (!column) {
      column = {
        parentId: record.parentId,
        x: record.x,
        records: [],
      };
      columns.push(column);
    }
    column.records.push({ index, record });
  });

  for (const column of columns) {
    column.records.sort((left, right) => left.record.y - right.record.y);
    let nextY = Number.NEGATIVE_INFINITY;
    for (const entry of column.records) {
      const y = Math.max(entry.record.y, nextY);
      if (y !== entry.record.y) {
        entry.record = { ...entry.record, y };
        normalized[entry.index].record = entry.record;
      }
      nextY = y + estimatedTextHeight(entry.record) + LEGACY_BLOCK_MARGIN;
    }
  }

  return normalized.map((entry) => entry.record);
}

function normalizeLineBreaks(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/\\r\\n|\\n|\\r/g, "\n");
}

function plainTextToRichText(text: string): TLRichText {
  return {
    type: "doc",
    content: text
      .split("\n")
      .map((line) =>
        line
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
  };
}

function readableWidth(value: unknown) {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_READABLE_TEXT_WIDTH &&
    value <= MAX_READABLE_TEXT_WIDTH
  ) {
    return value;
  }
  return DEFAULT_ASSISTANT_TEXT_WIDTH;
}

function singlePlainTextNode(value: unknown) {
  if (!isObject(value) || value.type !== "doc") return null;
  if (!Array.isArray(value.content) || value.content.length !== 1) return null;

  const paragraph = value.content[0];
  if (!isObject(paragraph) || paragraph.type !== "paragraph") return null;
  if (!Array.isArray(paragraph.content) || paragraph.content.length !== 1) {
    return null;
  }

  const textNode = paragraph.content[0];
  if (
    !isObject(textNode) ||
    textNode.type !== "text" ||
    typeof textNode.text !== "string"
  ) {
    return null;
  }
  return textNode.text;
}

function isLegacyAssistantTextRecord(record: TLRecord) {
  if (!isPositionedTextShape(record)) return false;
  const props = record.props;
  return (
    props.autoSize === true &&
    typeof props.w === "number" &&
    props.w <= LEGACY_AUTO_SIZE_WIDTH &&
    Boolean(singlePlainTextNode(props.richText)?.includes("\\n"))
  );
}

type TextShapeRecord = TLRecord & {
  typeName: "shape";
  type: "text";
  x: number;
  y: number;
  parentId: unknown;
  props: Record<string, unknown>;
};

function isPositionedTextShape(record: TLRecord): record is TextShapeRecord {
  const candidate = record as Partial<TextShapeRecord>;
  return (
    candidate.typeName === "shape" &&
    candidate.type === "text" &&
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y) &&
    Boolean(candidate.props)
  );
}

function estimatedTextHeight(record: TextShapeRecord) {
  return estimateTextShapePropsHeight(record.props);
}

export function estimateTextShapePropsHeight(props: Record<string, unknown>) {
  const richText = props.richText;
  const width =
    typeof props.w === "number" ? props.w : DEFAULT_ASSISTANT_TEXT_WIDTH;
  const lineHeight =
    {
      s: 26,
      m: 32,
      l: 40,
      xl: 52,
    }[String(props.size)] ?? 32;
  const charactersPerLine = Math.max(24, Math.floor(width / 10));

  if (!isObject(richText) || !Array.isArray(richText.content)) {
    return lineHeight;
  }

  return richText.content.reduce((height, paragraph) => {
    if (!isObject(paragraph) || !Array.isArray(paragraph.content)) {
      return height + lineHeight;
    }
    const text = paragraph.content
      .filter(isObject)
      .map((node) => (typeof node.text === "string" ? node.text : ""))
      .join("");
    return (
      height +
      Math.max(1, Math.ceil(Math.max(1, text.length) / charactersPerLine)) *
        lineHeight
    );
  }, 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
