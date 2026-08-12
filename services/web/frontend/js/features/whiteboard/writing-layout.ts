import { normalizeInkShapeProps } from "./ink-rendering";
import type { WhiteboardSceneAction } from "./scene-actions";
import {
  DEFAULT_ASSISTANT_TEXT_WIDTH,
  estimateTextShapePropsHeight,
  normalizeTextShapeProps,
} from "./text-shape-normalization";

export type WritingBounds = { x: number; y: number; w: number; h: number };

type WritingRole = "heading" | "prose" | "equation" | "table" | "answer";

const WRITING_COLUMN_TOLERANCE = 80;
const COLUMN_COLLISION_MARGIN = 120;
const COLUMN_SHIFT = 760;
const MAX_COLUMN_SHIFTS = 24;

export function normalizeWritingLayout(
  actions: WhiteboardSceneAction[],
  occupiedBounds: WritingBounds[] = [],
) {
  const normalized = actions.map((action) => {
    if (
      action.type !== "create" ||
      (action.shape.type !== "text" && action.shape.type !== "ink")
    ) {
      return action;
    }
    return {
      ...action,
      shape: {
        ...action.shape,
        props: normalizeWritingProps(action.shape.type, action.shape.props),
      },
    } as WhiteboardSceneAction;
  });
  const columns: Array<{
    x: number;
    entries: Array<{
      index: number;
      action: Extract<WhiteboardSceneAction, { type: "create" }>;
    }>;
  }> = [];

  normalized.forEach((action, index) => {
    if (
      action.type !== "create" ||
      (action.shape.type !== "text" && action.shape.type !== "ink")
    ) {
      return;
    }
    let column = columns.find(
      (candidate) =>
        Math.abs(candidate.x - action.shape.x) <= WRITING_COLUMN_TOLERANCE,
    );
    if (!column) {
      column = { x: action.shape.x, entries: [] };
      columns.push(column);
    }
    column.entries.push({ index, action });
  });

  const occupied = [...occupiedBounds];
  for (const column of columns) {
    column.entries.sort(
      (left, right) => left.action.shape.y - right.action.shape.y,
    );
    compactColumn(column.entries, normalized);
    shiftColumnAwayFromExisting(column.entries, normalized, occupied);
    const bounds = writingColumnBounds(column.entries);
    if (bounds) occupied.push(bounds);
  }
  return normalized;
}

function compactColumn(
  entries: Array<{
    index: number;
    action: Extract<WhiteboardSceneAction, { type: "create" }>;
  }>,
  normalized: WhiteboardSceneAction[],
) {
  let previous:
    | Extract<WhiteboardSceneAction, { type: "create" }>["shape"]
    | null = null;
  let nextY = entries[0]?.action.shape.y ?? 0;

  for (const entry of entries) {
    const shape = entry.action.shape;
    const y = previous
      ? nextY + writingBlockGap(writingRole(previous), writingRole(shape))
      : shape.y;
    entry.action = {
      ...entry.action,
      shape: { ...shape, y },
    };
    normalized[entry.index] = entry.action;
    previous = entry.action.shape;
    nextY = y + writingShapeHeight(entry.action.shape);
  }
}

function shiftColumnAwayFromExisting(
  entries: Array<{
    index: number;
    action: Extract<WhiteboardSceneAction, { type: "create" }>;
  }>,
  normalized: WhiteboardSceneAction[],
  occupied: WritingBounds[],
) {
  let shifts = 0;
  let bounds = writingColumnBounds(entries);
  if (!bounds) return;

  while (
    shifts < MAX_COLUMN_SHIFTS &&
    occupied.some((candidate) =>
      boundsIntersect(
        expandBounds(bounds!, COLUMN_COLLISION_MARGIN),
        candidate,
      ),
    )
  ) {
    const delta = Math.max(
      COLUMN_SHIFT,
      bounds.w + COLUMN_COLLISION_MARGIN * 2,
    );
    for (const entry of entries) {
      entry.action = {
        ...entry.action,
        shape: {
          ...entry.action.shape,
          x: entry.action.shape.x + delta,
        },
      };
      normalized[entry.index] = entry.action;
    }
    shifts += 1;
    bounds = writingColumnBounds(entries)!;
  }
}

function writingColumnBounds(
  entries: Array<{
    action: Extract<WhiteboardSceneAction, { type: "create" }>;
  }>,
): WritingBounds | null {
  if (entries.length === 0) return null;
  const bounds = entries.map(({ action }) => ({
    x: action.shape.x,
    y: action.shape.y,
    w: writingShapeWidth(action.shape),
    h: writingShapeHeight(action.shape),
  }));
  const minX = Math.min(...bounds.map((value) => value.x));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxX = Math.max(...bounds.map((value) => value.x + value.w));
  const maxY = Math.max(...bounds.map((value) => value.y + value.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function writingBlockGap(previous: WritingRole, current: WritingRole) {
  if (current === "answer") return 38;
  if (previous === "heading") return 28;
  if (previous === "table" || current === "table") return 30;
  return 20;
}

function writingRole(
  shape: Extract<WhiteboardSceneAction, { type: "create" }>["shape"],
): WritingRole {
  const source = writingSource(shape).trim();
  if (
    /\\(?:boxed|fbox)\b/.test(source) ||
    /^(?:final answer|therefore)\b/i.test(source)
  ) {
    return "answer";
  }
  if (
    /^(?:question|q(?:uestion)?\s*\d+|student solution|solution)\b/i.test(
      source,
    ) &&
    source.length <= 80
  ) {
    return "heading";
  }
  if (
    /sign\s*chart/i.test(source) ||
    source.split("\n").some((line) => /\S\s{2,}\S/.test(line))
  ) {
    return "table";
  }
  if (shape.type === "ink" && shape.props.format === "latex") {
    return "equation";
  }
  return "prose";
}

function writingSource(
  shape: Extract<WhiteboardSceneAction, { type: "create" }>["shape"],
) {
  if (shape.type === "ink" && typeof shape.props.source === "string") {
    return shape.props.source;
  }
  const richText = shape.props.richText;
  return richTextPlainText(richText);
}

function richTextPlainText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  if (!Array.isArray(record.content)) return "";
  return record.content.map(richTextPlainText).join("\n");
}

function normalizeWritingProps(
  type: "text" | "ink",
  props: Record<string, unknown>,
) {
  return type === "ink"
    ? normalizeInkShapeProps(props)
    : normalizeTextShapeProps(props);
}

function writingShapeHeight(
  shape: Extract<WhiteboardSceneAction, { type: "create" }>["shape"],
) {
  if (shape.type === "ink" && typeof shape.props.h === "number") {
    return shape.props.h;
  }
  return estimateTextShapePropsHeight(shape.props);
}

function writingShapeWidth(
  shape: Extract<WhiteboardSceneAction, { type: "create" }>["shape"],
) {
  if (typeof shape.props.w === "number" && Number.isFinite(shape.props.w)) {
    return shape.props.w;
  }
  const source = writingSource(shape);
  return Math.min(
    DEFAULT_ASSISTANT_TEXT_WIDTH,
    Math.max(180, source.length * 17),
  );
}

function expandBounds(bounds: WritingBounds, amount: number): WritingBounds {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    w: bounds.w + amount * 2,
    h: bounds.h + amount * 2,
  };
}

function boundsIntersect(left: WritingBounds, right: WritingBounds) {
  return !(
    left.x + left.w <= right.x ||
    right.x + right.w <= left.x ||
    left.y + left.h <= right.y ||
    right.y + right.h <= left.y
  );
}
