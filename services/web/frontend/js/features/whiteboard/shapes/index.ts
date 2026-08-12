import { InkShapeUtil } from "./ink-shape";
import { LatexShapeUtil } from "./latex-shape";
import { PlotShapeUtil } from "./plot-shape";

// Tldraw merges these additions with its defaults when rendering. Stores are
// created separately, so persistence.ts explicitly supplies the defaults too.
export const WHITEBOARD_SHAPE_UTILS = [
  InkShapeUtil,
  LatexShapeUtil,
  PlotShapeUtil,
] as const;

export type { InkShape } from "./ink-shape";
export type { LatexShape } from "./latex-shape";
export type { PlotShape } from "./plot-shape";
