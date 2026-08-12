import { getSvgPathFromPoints } from "tldraw";
import { hfmath } from "hfmath";

export type InkFormat = "text" | "latex";
export type InkSize = "s" | "m" | "l" | "xl";

export type InkShapeProps = {
  source: string;
  format: InkFormat;
  w: number;
  h: number;
  size: InkSize;
  color: string;
};

export type InkPoint = { x: number; y: number };
export type InkPolyline = InkPoint[];

export type InkStrokeGroup = {
  path: string;
  polylines: InkPolyline[];
  width: number;
  opacity: number;
};

export type InkDecoration = {
  type: "box";
  path: string;
  polyline: InkPolyline;
  x: number;
  y: number;
  w: number;
  h: number;
  width: number;
  opacity: number;
};

export type InkRenderResult = {
  polylines: InkPolyline[];
  path: string;
  strokes: InkStrokeGroup[];
  decorations: InkDecoration[];
  height: number;
  usedFallback: boolean;
  error: string | null;
};

type RawDecoration = {
  type: "box";
  x: number;
  y: number;
  w: number;
  h: number;
};

type RenderedContent = {
  polylines: InkPolyline[];
  decorations: RawDecoration[];
  height: number;
};

const INK_PADDING = 14;
const MAX_RENDERED_POINTS = 30_000;
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const MIN_HEIGHT = 48;
const MAX_HEIGHT = 2_000;

const FONT_SIZES: Record<InkSize, number> = {
  s: 24,
  m: 32,
  l: 40,
  xl: 52,
};

const STROKE_WIDTHS: Record<InkSize, number> = {
  s: 1.8,
  m: 2.4,
  l: 3,
  xl: 3.7,
};

const STROKE_PROFILES = [
  { multiplier: 0.9, opacity: 0.9 },
  { multiplier: 1, opacity: 0.96 },
  { multiplier: 1.12, opacity: 1 },
] as const;

const MATH_SYMBOLS: Record<string, string> = {
  Δ: "\\Delta",
  δ: "\\delta",
  "≤": "\\leq",
  "≥": "\\geq",
  "≠": "\\neq",
  "×": "\\times",
  "÷": "\\div",
  "±": "\\pm",
  π: "\\pi",
  "∞": "\\infty",
  "→": "\\rightarrow",
  "←": "\\leftarrow",
  "∈": "\\in",
  "−": "-",
  "·": "\\cdot",
  "—": "-",
  "–": "-",
  "⁰": "^{0}",
  "¹": "^{1}",
  "²": "^{2}",
  "³": "^{3}",
  "⁴": "^{4}",
  "⁵": "^{5}",
  "⁶": "^{6}",
  "⁷": "^{7}",
  "⁸": "^{8}",
  "⁹": "^{9}",
};

const MATH_SYMBOL_PATTERN = /([Δδ≤≥≠×÷±π∞→←∈−·—–⁰¹²³⁴⁵⁶⁷⁸⁹])/u;
const DOUBLE_ARROW_PATTERN =
  /\\(Longrightarrow|Rightarrow|implies|Longleftarrow|Leftarrow)\b/g;

export function normalizeInkShapeProps(
  props: Record<string, unknown>,
  previous: Partial<InkShapeProps> = {},
): InkShapeProps {
  const format = validFormat(props.format)
    ? props.format
    : (previous.format ?? "text");
  const source = normalizedSource(
    typeof props.source === "string"
      ? props.source
      : (previous.source ?? "Handwritten solution"),
    format,
  );
  const size = validSize(props.size) ? props.size : (previous.size ?? "m");
  const w = boundedNumber(props.w, MIN_WIDTH, MAX_WIDTH, previous.w ?? 640);
  const color = validColor(props.color)
    ? props.color.toLowerCase()
    : (previous.color ?? "#172033");
  const measured = renderInk({
    source,
    format,
    w,
    h: previous.h ?? MIN_HEIGHT,
    size,
    color,
  });

  return {
    source,
    format,
    w,
    h: boundedNumber(measured.height, MIN_HEIGHT, MAX_HEIGHT, MIN_HEIGHT),
    size,
    color,
  };
}

export function renderInk(props: InkShapeProps, seed = "ink"): InkRenderResult {
  const fontSize = FONT_SIZES[props.size];
  try {
    const rendered =
      props.format === "latex"
        ? renderLatex(props.source, fontSize, props.w, seed)
        : renderText(props.source, fontSize, props.w, seed, true);
    return completedRender(rendered, props.size, seed, false);
  } catch (cause) {
    try {
      const fallback = renderText(
        readableFallback(props.source),
        fontSize,
        props.w,
        `${seed}:fallback`,
        false,
      );
      return completedRender(fallback, props.size, `${seed}:fallback`, true);
    } catch (fallbackCause) {
      return {
        polylines: [],
        path: "",
        strokes: [],
        decorations: [],
        height: estimatedFallbackHeight(props.source, fontSize, props.w),
        usedFallback: true,
        error:
          fallbackCause instanceof Error
            ? fallbackCause.message
            : cause instanceof Error
              ? cause.message
              : "Unable to render handwriting",
      };
    }
  }
}

export function inkStrokeWidth(size: InkSize) {
  return STROKE_WIDTHS[size];
}

function completedRender(
  rendered: RenderedContent,
  size: InkSize,
  seed: string,
  usedFallback: boolean,
): InkRenderResult {
  const fontSize = FONT_SIZES[size];
  const polylines = limitPoints(
    naturalizePolylines(rendered.polylines, seed, fontSize),
  );
  const strokes = groupStrokes(polylines, size, seed);
  const decorations = renderDecorations(rendered.decorations, size, seed);
  return {
    polylines,
    path: strokes.map((stroke) => stroke.path).join(" "),
    strokes,
    decorations,
    height: boundedNumber(
      rendered.height + INK_PADDING * 2,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MIN_HEIGHT,
    ),
    usedFallback,
    error: null,
  };
}

function renderText(
  source: string,
  fontSize: number,
  width: number,
  seed: string,
  handwritten: boolean,
): RenderedContent {
  source = normalizeInlineLatexText(source);
  const availableWidth = Math.max(1, width - INK_PADDING * 2);
  const lines = wrapText(source, fontSize, availableWidth, handwritten);
  const table = textTableLayout(lines, fontSize, availableWidth);
  const lineHeight = fontSize * 1.34;
  const renderedLines = lines.map((line, index) => {
    if (!line) return { polylines: [], height: fontSize };
    const columns = textColumns(line);
    if (columns.length > 1 && table) {
      const polylines = columns.flatMap((column, columnIndex) => {
        const value = renderExpression(textExpression(column), table.fontSize);
        const cellX = columnIndex * table.columnWidth;
        const columnOffset =
          columnIndex === 0
            ? cellX
            : cellX + Math.max(0, (table.columnWidth - value.width) / 2);
        return translatePolylines(
          value.polylines,
          columnOffset,
          0,
        );
      });
      return { polylines, height: table.fontSize };
    }
    if (!handwritten) {
      const value = renderExpression(textExpression(line), fontSize);
      return { polylines: value.polylines, height: value.height };
    }
    return fitRendered(
      renderHandwrittenLine(line, fontSize, `${seed}:line:${index}`),
      availableWidth,
    );
  });

  const polylines = renderedLines.flatMap((line, index) =>
    translatePolylines(
      line.polylines,
      INK_PADDING,
      INK_PADDING + index * lineHeight,
    ),
  );
  const lastHeight = renderedLines.at(-1)?.height ?? fontSize;
  return {
    polylines,
    decorations: [],
    height: Math.max(
      fontSize,
      Math.max(0, lines.length - 1) * lineHeight + lastHeight,
    ),
  };
}

function renderHandwrittenLine(line: string, fontSize: number, seed: string) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const renderedWords = words.map((word, index) => {
    const rendered = renderExpression(
      handwrittenWordExpression(word),
      fontSize,
    );
    const random = seededRandom(`${seed}:word:${index}`);
    const scaleX = 0.98 + random() * 0.04;
    const rotation = ((random() - 0.5) * 1.4 * Math.PI) / 180;
    const baselineOffset = (random() - 0.5) * 2.4;
    const transformed = transformPolylines(
      rendered.polylines,
      scaleX,
      rotation,
    );
    const bounds = polylineBounds(transformed);
    return {
      polylines: translatePolylines(transformed, -bounds.minX, -bounds.minY),
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      baselineOffset,
      gapScale: 0.94 + random() * 0.14,
      midline: /^[-–—]$/.test(word),
    };
  });

  const maxHeight = Math.max(
    fontSize,
    ...renderedWords.map((word) => word.height),
  );
  let cursorX = 0;
  const polylines: InkPolyline[] = [];
  renderedWords.forEach((word, index) => {
    polylines.push(
      ...translatePolylines(
        word.polylines,
        cursorX,
        (word.midline
          ? maxHeight * 0.5 - word.height / 2
          : maxHeight - word.height) + word.baselineOffset,
      ),
    );
    cursorX += word.width;
    if (index < renderedWords.length - 1) {
      cursorX += fontSize * 0.38 * word.gapScale;
    }
  });
  return { polylines, width: cursorX, height: maxHeight + 2 };
}

function renderLatex(
  source: string,
  fontSize: number,
  width: number,
  seed: string,
): RenderedContent {
  const availableWidth = Math.max(1, width - INK_PADDING * 2);
  const lines = latexLines(source);
  const lineGap = fontSize * 0.28;
  let cursorY = 0;
  const polylines: InkPolyline[] = [];
  const decorations: RawDecoration[] = [];

  for (const [index, line] of lines.entries()) {
    const boxPaddingX = line.boxed ? Math.max(8, fontSize * 0.26) : 0;
    const boxPaddingY = line.boxed ? Math.max(6, fontSize * 0.18) : 0;
    const lineWidth = Math.max(1, availableWidth - boxPaddingX * 2);
    const rendered =
      line.format === "text"
        ? renderWrappedHandwrittenProse(
            normalizeInlineLatexText(line.source),
            fontSize,
            lineWidth,
            `${seed}:latex-prose:${index}`,
          )
        : renderLatexExpression(line.source, fontSize, lineWidth);
    const contentX = INK_PADDING + boxPaddingX;
    const contentY = INK_PADDING + cursorY + boxPaddingY;
    polylines.push(
      ...translatePolylines(rendered.polylines, contentX, contentY),
    );

    const contentHeight = Math.max(rendered.height, fontSize * 1.12);
    const blockHeight = contentHeight + boxPaddingY * 2;
    if (line.boxed) {
      decorations.push({
        type: "box",
        x: INK_PADDING,
        y: INK_PADDING + cursorY,
        w: rendered.width + boxPaddingX * 2,
        h: blockHeight,
      });
    }
    cursorY += blockHeight + lineGap;
  }

  return {
    polylines,
    decorations,
    height: Math.max(fontSize, cursorY - lineGap),
  };
}

function renderLatexExpression(
  source: string,
  fontSize: number,
  maxWidth: number,
) {
  const parts = splitDoubleArrows(source);
  if (!parts.some((part) => part.type === "arrow")) {
    return renderExpression(normalizeLatexLine(source), fontSize, maxWidth);
  }

  const renderedParts = parts.map((part) => {
    if (part.type === "arrow") {
      return renderDoubleArrow(part.direction, fontSize);
    }
    const normalized = normalizeLatexLine(part.source);
    return normalized
      ? renderExpression(normalized, fontSize)
      : { polylines: [] as InkPolyline[], width: 0, height: fontSize };
  });
  const gap = fontSize * 0.12;
  const height = Math.max(
    fontSize,
    ...renderedParts.map((part) => part.height),
  );
  let cursorX = 0;
  const polylines: InkPolyline[] = [];
  renderedParts.forEach((part, index) => {
    polylines.push(
      ...translatePolylines(
        part.polylines,
        cursorX,
        (height - part.height) / 2,
      ),
    );
    cursorX += part.width;
    if (index < renderedParts.length - 1) cursorX += gap;
  });
  return fitRendered({ polylines, width: cursorX, height }, maxWidth);
}

function renderWrappedHandwrittenProse(
  source: string,
  fontSize: number,
  maxWidth: number,
  seed: string,
) {
  const lines = wrapText(source, fontSize, maxWidth, true);
  const lineHeight = fontSize * 1.34;
  const renderedLines = lines.map((line, index) =>
    fitRendered(
      renderHandwrittenLine(line, fontSize, `${seed}:line:${index}`),
      maxWidth,
    ),
  );
  const polylines = renderedLines.flatMap((line, index) =>
    translatePolylines(line.polylines, 0, index * lineHeight),
  );
  return {
    polylines,
    width: Math.max(0, ...renderedLines.map((line) => line.width)),
    height: Math.max(
      fontSize,
      Math.max(0, renderedLines.length - 1) * lineHeight +
        (renderedLines.at(-1)?.height ?? fontSize),
    ),
  };
}

function renderDoubleArrow(direction: "left" | "right", fontSize: number) {
  const width = fontSize * 1.2;
  const height = fontSize * 0.5;
  const centerY = height / 2;
  const shaftEnd = width * 0.74;
  const headStart = width * 0.61;
  const rightPolylines: InkPolyline[] = [
    [
      { x: 0, y: centerY - fontSize * 0.09 },
      { x: shaftEnd, y: centerY - fontSize * 0.09 },
    ],
    [
      { x: 0, y: centerY + fontSize * 0.09 },
      { x: shaftEnd, y: centerY + fontSize * 0.09 },
    ],
    [
      { x: headStart, y: 0 },
      { x: width, y: centerY },
      { x: headStart, y: height },
    ],
  ];
  return {
    polylines:
      direction === "right"
        ? rightPolylines
        : rightPolylines.map((line) =>
            line.map((point) => ({ x: width - point.x, y: point.y })),
          ),
    width,
    height,
  };
}

function splitDoubleArrows(source: string) {
  const parts: Array<
    | { type: "source"; source: string }
    | { type: "arrow"; direction: "left" | "right" }
  > = [];
  let cursor = 0;
  for (const match of source.matchAll(DOUBLE_ARROW_PATTERN)) {
    const index = match.index ?? 0;
    parts.push({ type: "source", source: source.slice(cursor, index) });
    parts.push({
      type: "arrow",
      direction:
        match[1].includes("left") || match[1].includes("Left")
          ? "left"
          : "right",
    });
    cursor = index + match[0].length;
  }
  parts.push({ type: "source", source: source.slice(cursor) });
  return parts;
}

function latexLines(source: string) {
  const withoutEnvironment = source
    .replace(/\\begin\{(?:aligned|align\*?|gathered)\}/g, "\n")
    .replace(/\\end\{(?:aligned|align\*?|gathered)\}/g, "\n");
  const lines = withoutEnvironment
    .split(/\r?\n|\\\\(?:\[[^\]]*\])?/)
    .map(parseLatexLine)
    .filter(
      (
        line,
      ): line is {
        source: string;
        boxed: boolean;
        format: "text" | "latex";
      } => Boolean(line),
    );
  if (lines.length === 0) throw new Error("No handwritten math to render");
  return lines;
}

function parseLatexLine(value: string) {
  const stripped = stripMathDelimiters(value.trim());
  if (!stripped) return null;
  const boxed = stripOuterBox(stripped);
  return {
    source: boxed.source,
    boxed: boxed.boxed,
    format:
      !boxed.boxed && looksLikeProse(boxed.source) ? "text" : "latex",
  } as const;
}

function looksLikeProse(value: string) {
  const withoutCommands = value.replace(/\\[a-zA-Z]+/g, " ");
  return (withoutCommands.match(/[a-zA-Z]{2,}/g) ?? []).length >= 3;
}

function stripMathDelimiters(value: string) {
  return value
    .replace(/^\$|\$$/g, "")
    .replace(/^\\(?:\[|\()/, "")
    .replace(/\\(?:\]|\))$/, "")
    .trim();
}

function stripOuterBox(value: string) {
  const match = /^\\(?:boxed|fbox)\s*\{([\s\S]*)\}$/.exec(value);
  return match
    ? { source: match[1], boxed: true }
    : { source: value, boxed: false };
}

function normalizeLatexLine(value: string) {
  const normalized = value
    .trim()
    .replaceAll("&", "")
    .replace(/\\(?:dfrac|tfrac)\b/g, "\\frac")
    .replace(/\\qquad\b/g, "\\quad \\quad ")
    .replace(
      /\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle)\b/g,
      "",
    )
    // Keep a delimiter after aliases because hfmath otherwise tokenizes
    // compact input such as `\\le0` as the unknown command `\\leq0`.
    .replace(/\\le(?![a-zA-Z])\s*/g, "\\leq ")
    .replace(/\\ge(?![a-zA-Z])\s*/g, "\\geq ")
    .replace(/\\(?:,|;|:|!)/g, " ");

  // hfmath tokenizes digits as part of a command name, so valid TeX
  // shorthand such as compact fractions needs explicit argument braces.
  return normalized
    .replace(/\\frac\s*([a-zA-Z0-9])([a-zA-Z0-9])/g, "\\frac{$1}{$2}")
    .replace(/\\frac\s*(\{[^{}]*\})([a-zA-Z0-9])/g, "\\frac$1{$2}")
    .replace(/\\frac\s*([a-zA-Z0-9])(\{[^{}]*\})/g, "\\frac{$1}$2");
}

function renderExpression(source: string, fontSize: number, maxWidth?: number) {
  const scale = fontSize / 2;
  const raw = new hfmath(source).polylines({
    SCALE_X: scale,
    SCALE_Y: scale,
    MARGIN_X: 0,
    MARGIN_Y: 0,
    ...(maxWidth ? { MAX_W: maxWidth } : {}),
  });
  const polylines = raw
    .map((line) =>
      line
        .filter(
          (point) =>
            Array.isArray(point) &&
            Number.isFinite(point[0]) &&
            Number.isFinite(point[1]),
        )
        .map(([x, y]) => ({ x, y })),
    )
    .filter((line) => line.length > 0);
  if (polylines.length === 0) throw new Error("No handwriting paths produced");

  const bounds = polylineBounds(polylines);
  return {
    polylines: translatePolylines(polylines, -bounds.minX, -bounds.minY),
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

function fitRendered(
  rendered: { polylines: InkPolyline[]; width: number; height: number },
  maxWidth: number,
) {
  if (rendered.width <= maxWidth || rendered.width <= 0) return rendered;
  const scale = maxWidth / rendered.width;
  return {
    polylines: rendered.polylines.map((line) =>
      line.map((point) => ({ x: point.x * scale, y: point.y * scale })),
    ),
    width: maxWidth,
    height: rendered.height * scale,
  };
}

function wrapText(
  source: string,
  fontSize: number,
  maxWidth: number,
  handwritten: boolean,
) {
  return source.split("\n").flatMap((paragraph) => {
    if (!paragraph.trim()) return [""];
    if (textColumns(paragraph).length > 1) return [paragraph.trim()];
    const words = paragraph.trim().split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (
        !current ||
        measuredTextWidth(candidate, fontSize, handwritten) <= maxWidth
      ) {
        current = candidate;
        continue;
      }
      lines.push(current);
      if (measuredTextWidth(word, fontSize, handwritten) <= maxWidth) {
        current = word;
        continue;
      }
      const chunks = splitLongWord(word, fontSize, maxWidth, handwritten);
      lines.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
    }
    if (current) lines.push(current);
    return lines;
  });
}

function textColumns(value: string) {
  const trimmed = value.trim();
  if (!/\S\s{2,}\S/.test(trimmed)) return [trimmed];
  return trimmed
    .split(/\s{2,}/)
    .map((column) => column.trim())
    .filter(Boolean);
}

function textTableLayout(
  lines: string[],
  fontSize: number,
  availableWidth: number,
) {
  const rows = lines.map(textColumns).filter((columns) => columns.length > 1);
  const columnCount = Math.max(0, ...rows.map((columns) => columns.length));
  if (columnCount < 2) return null;
  const columnWidth = availableWidth / columnCount;
  const cellPadding = fontSize * 0.9;
  let scale = 1;
  for (const columns of rows) {
    for (const column of columns) {
      const measured = measuredTextWidth(column, fontSize, false);
      if (measured > 0) {
        scale = Math.min(scale, (columnWidth - cellPadding) / measured);
      }
    }
  }
  return {
    columnWidth,
    fontSize: Math.max(12, fontSize * Math.max(0.35, scale)),
  };
}

const widthCache = new Map<string, number>();

function measuredTextWidth(
  value: string,
  fontSize: number,
  handwritten: boolean,
) {
  const key = `${handwritten ? "hand" : "roman"}:${fontSize}:${value}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  let width;
  try {
    if (handwritten) {
      const words = value.trim().split(/\s+/).filter(Boolean);
      width = words.reduce(
        (total, word, index) =>
          total +
          renderExpression(handwrittenWordExpression(word), fontSize).width +
          (index < words.length - 1 ? fontSize * 0.38 : 0),
        0,
      );
    } else {
      width = renderExpression(textExpression(value), fontSize).width;
    }
  } catch {
    width = value.length * fontSize * 0.58;
  }
  if (widthCache.size > 2_000) widthCache.clear();
  widthCache.set(key, width);
  return width;
}

function splitLongWord(
  value: string,
  fontSize: number,
  maxWidth: number,
  handwritten: boolean,
) {
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    const candidate = `${current}${character}`;
    if (
      current &&
      measuredTextWidth(candidate, fontSize, handwritten) > maxWidth
    ) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizeInlineLatexText(value: string) {
  return value
    .replace(
      /\\(?:dfrac|tfrac|frac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g,
      (_, numerator: string, denominator: string) =>
        `${slashFractionPart(numerator)}/${slashFractionPart(denominator)}`,
    )
    .replace(
      /\\(?:dfrac|tfrac|frac)\s*([a-zA-Z0-9])([a-zA-Z0-9])/g,
      "$1/$2",
    )
    .replace(/\\Delta\b/g, "Δ")
    .replace(/\\delta\b/g, "δ")
    .replace(/\\leq?(?![a-zA-Z])\s*/g, "≤ ")
    .replace(/\\geq?(?![a-zA-Z])\s*/g, "≥ ")
    .replace(/\\neq(?![a-zA-Z])\s*/g, "≠ ")
    .replace(/\\in(?![a-zA-Z])\s*/g, "∈ ")
    .replace(/\\times\b/g, "×")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\pm\b/g, "±")
    .replace(/\\pi\b/g, "π")
    .replace(/\\infty\b/g, "∞")
    .replace(/\\(?:Rightarrow|Longrightarrow|implies)\b/g, "⇒")
    .replace(/\\(?:Leftarrow|Longleftarrow)\b/g, "⇐")
    .replace(/\\(?:rightarrow|to)\b/g, "→")
    .replace(/\\leftarrow\b/g, "←")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\(?:qquad|quad)\b|\\[,;:!]/g, " ")
    .replace(/\\(?:text|mathrm|mathbf|mathit)\{([^{}]*)\}/g, "$1")
    .replace(/[ \t]*([<>=≤≥≠∈])[ \t]*/g, " $1 ");
}

function slashFractionPart(value: string) {
  const trimmed = value.trim();
  return /[+\-\s]/.test(trimmed) ? `(${trimmed})` : trimmed;
}

function handwrittenWordExpression(value: string) {
  return value
    .split(MATH_SYMBOL_PATTERN)
    .filter(Boolean)
    .map((part) => MATH_SYMBOLS[part] ?? mathItalicExpression(part))
    .join("");
}

function mathItalicExpression(value: string) {
  return `\\mathit{${value
    .replaceAll("\\", "/")
    .replaceAll("{", "(")
    .replaceAll("}", ")")
    .replaceAll("#", "\\#")
    .replaceAll("$", "\\$")
    .replaceAll("%", "\\%")
    .replaceAll("&", "\\&")}}`;
}

function textExpression(value: string) {
  return value
    .split(MATH_SYMBOL_PATTERN)
    .filter(Boolean)
    .map((part) => MATH_SYMBOLS[part] ?? escapedTextExpression(part))
    .join("");
}

function escapedTextExpression(value: string) {
  return `\\text{${value
    .replaceAll("\\", "/")
    .replaceAll("{", "(")
    .replaceAll("}", ")")
    .replaceAll("#", "\\#")
    .replaceAll("$", "\\$")
    .replaceAll("%", "\\%")
    .replaceAll("&", "\\&")}}`;
}

function readableFallback(value: string) {
  return value
    .replaceAll("\\leq", "<=")
    .replaceAll("\\geq", ">=")
    .replaceAll("\\neq", "!=")
    .replaceAll("\\times", "x")
    .replaceAll("\\cdot", "·")
    .replaceAll("\\pm", "+/-")
    .replace(/\\(?:left|right|displaystyle|textstyle)\b/g, "")
    .replace(/\\(?:frac|sqrt|text|mathrm|mathbf|mathit)\b/g, "")
    .replace(/[{}]/g, (character) => (character === "{" ? "(" : ")"))
    .replace(/[^\x20-\x7e·≤≥≠×÷±√π]/g, "?");
}

function normalizedSource(value: string, format: InkFormat) {
  const normalized =
    format === "text"
      ? value.replace(/\r\n?/g, "\n").replace(/\\r\\n|\\n|\\r/g, "\n")
      : value;
  return normalized.trim().slice(0, 4_000) || "Handwritten solution";
}

function transformPolylines(
  polylines: InkPolyline[],
  scaleX: number,
  rotation: number,
) {
  const bounds = polylineBounds(polylines);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return polylines.map((line) =>
    line.map((point) => {
      const x = (point.x - centerX) * scaleX;
      const y = point.y - centerY;
      return {
        x: centerX + x * cosine - y * sine,
        y: centerY + x * sine + y * cosine,
      };
    }),
  );
}

function translatePolylines(
  polylines: InkPolyline[],
  offsetX: number,
  offsetY: number,
) {
  return polylines.map((line) =>
    line.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY })),
  );
}

function naturalizePolylines(
  polylines: InkPolyline[],
  seed: string,
  fontSize: number,
) {
  const random = seededRandom(`${seed}:points`);
  const amount = Math.min(0.42, Math.max(0.18, fontSize * 0.009));
  return polylines.map((line) => {
    const offsetX = (random() - 0.5) * amount;
    const offsetY = (random() - 0.5) * amount;
    const phase = random() * Math.PI * 2;
    return line.map((point, index) => ({
      x: point.x + offsetX + Math.sin(phase + index * 0.72) * amount * 0.28,
      y: point.y + offsetY + Math.cos(phase + index * 0.61) * amount * 0.28,
    }));
  });
}

function groupStrokes(
  polylines: InkPolyline[],
  size: InkSize,
  seed: string,
): InkStrokeGroup[] {
  const random = seededRandom(`${seed}:pressure`);
  const groups = STROKE_PROFILES.map(() => [] as InkPolyline[]);
  for (const polyline of polylines) {
    groups[
      Math.min(groups.length - 1, Math.floor(random() * groups.length))
    ].push(polyline);
  }
  return groups.flatMap((group, index) => {
    if (group.length === 0) return [];
    const profile = STROKE_PROFILES[index];
    return [
      {
        path: polylinesToSmoothPath(group),
        polylines: group,
        width: inkStrokeWidth(size) * profile.multiplier,
        opacity: profile.opacity,
      },
    ];
  });
}

function renderDecorations(
  decorations: RawDecoration[],
  size: InkSize,
  seed: string,
): InkDecoration[] {
  return decorations.map((decoration, index) => {
    const random = seededRandom(`${seed}:decoration:${index}`);
    const wobble = Math.max(0.5, FONT_SIZES[size] * 0.018);
    const point = (x: number, y: number) => ({
      x: x + (random() - 0.5) * wobble,
      y: y + (random() - 0.5) * wobble,
    });
    const polyline = [
      point(decoration.x, decoration.y),
      point(decoration.x + decoration.w, decoration.y),
      point(decoration.x + decoration.w, decoration.y + decoration.h),
      point(decoration.x, decoration.y + decoration.h),
      point(decoration.x, decoration.y),
    ];
    return {
      ...decoration,
      path: linearPolylinePath(polyline),
      polyline,
      width: inkStrokeWidth(size) * 0.92,
      opacity: 0.96,
    };
  });
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function limitPoints(polylines: InkPolyline[]) {
  const total = polylines.reduce((count, line) => count + line.length, 0);
  if (total <= MAX_RENDERED_POINTS) return polylines;
  const stride = Math.ceil(total / MAX_RENDERED_POINTS);
  return polylines.map((line) => {
    if (line.length <= 2) return line;
    return line.filter(
      (_, index) =>
        index === 0 || index === line.length - 1 || index % stride === 0,
    );
  });
}

function polylinesToSmoothPath(polylines: InkPolyline[]) {
  return polylines
    .filter((line) => line.length > 0)
    .map((line) =>
      line.length === 1
        ? `M${round(line[0].x)} ${round(line[0].y)}l0.01 0`
        : getSvgPathFromPoints(line, false),
    )
    .join(" ");
}

function linearPolylinePath(polyline: InkPolyline) {
  return polyline
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`,
    )
    .join(" ");
}

function polylineBounds(polylines: InkPolyline[]) {
  const points = polylines.flat();
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function estimatedFallbackHeight(
  source: string,
  fontSize: number,
  width: number,
) {
  const charactersPerLine = Math.max(12, Math.floor(width / (fontSize * 0.58)));
  const lines = source
    .split("\n")
    .reduce(
      (count, line) =>
        count +
        Math.max(1, Math.ceil(Math.max(1, line.length) / charactersPerLine)),
      0,
    );
  return boundedNumber(
    lines * fontSize * 1.34 + INK_PADDING * 2,
    MIN_HEIGHT,
    MAX_HEIGHT,
    MIN_HEIGHT,
  );
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function validFormat(value: unknown): value is InkFormat {
  return value === "text" || value === "latex";
}

function validSize(value: unknown): value is InkSize {
  return value === "s" || value === "m" || value === "l" || value === "xl";
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
