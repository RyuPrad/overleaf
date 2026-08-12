import {
  Box,
  Editor,
  TLRecord,
  TLShape,
  TLShapeId,
  TLShapePartial,
  TLUnknownShape,
  createShapeId,
  isShape,
} from "tldraw";
import { normalizeInkShapeProps } from "./ink-rendering";
import { normalizeTextShapeProps } from "./text-shape-normalization";
import { WritingBounds, normalizeWritingLayout } from "./writing-layout";

export { normalizeWritingLayout } from "./writing-layout";

export type WhiteboardSceneAction =
  | {
      type: "create";
      shape: {
        id?: string;
        type: "geo" | "text" | "arrow" | "latex" | "plot" | "ink";
        x: number;
        y: number;
        props: Record<string, unknown>;
        meta?: Record<string, unknown>;
      };
    }
  | {
      type: "update";
      id: string;
      x?: number;
      y?: number;
      rotation?: number;
      props?: Record<string, unknown>;
    }
  | { type: "delete"; ids: string[] }
  | { type: "group"; ids: string[] }
  | {
      type: "align";
      ids: string[];
      operation:
        | "bottom"
        | "center-horizontal"
        | "center-vertical"
        | "left"
        | "right"
        | "top";
    }
  | { type: "distribute"; ids: string[]; axis: "horizontal" | "vertical" }
  | { type: "camera"; x: number; y: number; zoom: number };

const MAX_ACTIONS = 200;
const ALLOWED_SHAPES = new Set([
  "geo",
  "text",
  "arrow",
  "latex",
  "plot",
  "ink",
]);

export function validateSceneActions(value: unknown): WhiteboardSceneAction[] {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) {
    throw new Error(
      `A proposal must contain at most ${MAX_ACTIONS} scene actions`,
    );
  }

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Scene action ${index + 1} must be an object`);
    }
    const action = candidate as Record<string, unknown>;
    if (action.type === "create") {
      const shape = action.shape as Record<string, unknown> | undefined;
      if (
        !shape ||
        !ALLOWED_SHAPES.has(String(shape.type)) ||
        !isFiniteNumber(shape.x) ||
        !isFiniteNumber(shape.y) ||
        !isPlainObject(shape.props) ||
        (shape.meta !== undefined && !isPlainObject(shape.meta))
      ) {
        throw new Error(`Scene action ${index + 1} contains an invalid shape`);
      }
    } else if (action.type === "update") {
      requireShapeId(action.id, index);
      for (const key of ["x", "y", "rotation"] as const) {
        if (action[key] !== undefined && !isFiniteNumber(action[key])) {
          throw new Error(
            `Scene action ${index + 1} contains an invalid ${key}`,
          );
        }
      }
      if (action.props !== undefined && !isPlainObject(action.props)) {
        throw new Error(
          `Scene action ${index + 1} contains invalid properties`,
        );
      }
    } else if (action.type === "delete" || action.type === "group") {
      validateIds(action.ids, index);
    } else if (action.type === "align") {
      validateIds(action.ids, index);
      if (
        ![
          "bottom",
          "center-horizontal",
          "center-vertical",
          "left",
          "right",
          "top",
        ].includes(String(action.operation))
      ) {
        throw new Error(`Scene action ${index + 1} has an invalid alignment`);
      }
    } else if (action.type === "distribute") {
      validateIds(action.ids, index);
      if (action.axis !== "horizontal" && action.axis !== "vertical") {
        throw new Error(`Scene action ${index + 1} has an invalid axis`);
      }
    } else if (action.type === "camera") {
      if (
        !isFiniteNumber(action.x) ||
        !isFiniteNumber(action.y) ||
        !isFiniteNumber(action.zoom) ||
        action.zoom <= 0 ||
        action.zoom > 16
      ) {
        throw new Error(`Scene action ${index + 1} has an invalid camera`);
      }
    } else {
      throw new Error(`Scene action ${index + 1} has an unsupported type`);
    }
    return action as WhiteboardSceneAction;
  });
}

export function sceneActionsAreDestructive(actions: WhiteboardSceneAction[]) {
  return actions.some((action) => action.type === "delete");
}

export function applySceneActions(
  editor: Editor,
  untrustedActions: unknown,
  options: { historyMark?: string } = {},
) {
  const actions = normalizeWritingLayout(
    validateSceneActions(untrustedActions),
    currentPageBounds(editor),
  );
  editor.markHistoryStoppingPoint(
    options.historyMark ?? "AI whiteboard change",
  );

  for (const action of actions) {
    if (action.type === "create") {
      editor.createShapes([toShapePartial(action.shape)]);
    } else if (action.type === "update") {
      const existing = getShape(editor, action.id);
      editor.updateShapes([
        {
          id: existing.id,
          type: existing.type,
          ...(action.x === undefined ? {} : { x: action.x }),
          ...(action.y === undefined ? {} : { y: action.y }),
          ...(action.rotation === undefined
            ? {}
            : { rotation: action.rotation }),
          ...(action.props
            ? {
                props: normalizeProps(
                  existing.type,
                  action.props,
                  existing.props as Record<string, unknown>,
                ),
              }
            : {}),
        } as TLShapePartial<TLUnknownShape>,
      ]);
    } else if (action.type === "delete") {
      editor.deleteShapes(existingIds(editor, action.ids));
    } else if (action.type === "group") {
      editor.groupShapes(existingIds(editor, action.ids), { select: false });
    } else if (action.type === "align") {
      editor.alignShapes(existingIds(editor, action.ids), action.operation);
    } else if (action.type === "distribute") {
      editor.distributeShapes(existingIds(editor, action.ids), action.axis);
    } else {
      editor.setCamera({ x: action.x, y: action.y, z: action.zoom });
    }
  }
  return actions;
}

export function focusSceneRecords(
  editor: Editor,
  records: Array<TLRecord | null>,
) {
  const bounds = records.flatMap((record) => {
    if (!record || !isShape(record) || !editor.getShape(record.id)) return [];
    const pageBounds = editor.getShapePageBounds(record.id);
    return pageBounds ? [pageBounds] : [];
  });
  if (bounds.length === 0) return false;

  editor.selectNone();
  editor.zoomToBounds(Box.Common(bounds).expandBy(24), {
    // Leave room for tldraw's bottom toolbar so the last line of a worked
    // solution remains visible after the assistant focuses the result.
    inset: 148,
    targetZoom: 1,
    animation: { duration: 220 },
  });
  return true;
}

export function serializeScene(editor: Editor) {
  return editor
    .getCurrentPageShapes()
    .slice(0, 1000)
    .map((shape) => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      rotation: shape.rotation,
      props: shape.props,
      parentId: shape.parentId,
    }));
}

export async function captureScenePng(editor: Editor) {
  const shapes = editor.getCurrentPageShapes();
  if (shapes.length === 0) return null;
  const result = await editor.toImageDataUrl(shapes, {
    background: true,
    format: "png",
    padding: 32,
    scale: 1,
  });
  return result.url;
}

function toShapePartial(
  shape: Extract<WhiteboardSceneAction, { type: "create" }>["shape"],
) {
  const props = normalizeProps(shape.type, shape.props);
  return {
    id: shape.id ? normalizeShapeId(shape.id) : createShapeId(),
    type: shape.type,
    x: shape.x,
    y: shape.y,
    props,
    ...(shape.meta ? { meta: shape.meta } : {}),
  } as TLShapePartial<TLUnknownShape>;
}

function normalizeProps(
  type: string,
  props: Record<string, unknown>,
  previous: Record<string, unknown> = {},
) {
  if (type === "text") return normalizeTextShapeProps(props);
  if (type === "ink") return normalizeInkShapeProps(props, previous);
  return props;
}

function currentPageBounds(editor: Editor): WritingBounds[] {
  return editor.getCurrentPageShapes().flatMap((shape) => {
    const bounds = editor.getShapePageBounds(shape);
    return bounds
      ? [{ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }]
      : [];
  });
}

function getShape(editor: Editor, id: string): TLShape {
  const shape = editor.getShape(normalizeShapeId(id));
  if (!shape) throw new Error(`Shape ${id} no longer exists`);
  return shape;
}

function existingIds(editor: Editor, values: string[]) {
  return values.map((value) => getShape(editor, value).id);
}

function normalizeShapeId(value: string) {
  return (value.startsWith("shape:") ? value : `shape:${value}`) as TLShapeId;
}

function validateIds(value: unknown, index: number) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`Scene action ${index + 1} contains an invalid shape list`);
  }
  value.forEach((item) => requireShapeId(item, index));
}

function requireShapeId(value: unknown, index: number) {
  if (
    typeof value !== "string" ||
    !/^(?:shape:)?[a-zA-Z0-9_-]{1,128}$/.test(value)
  ) {
    throw new Error(`Scene action ${index + 1} contains an invalid shape id`);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
