import { expect } from "chai";
import { Box, Editor, TLRecord } from "tldraw";
import {
  InkShapeProps,
  normalizeInkShapeProps,
  renderInk,
} from "@/features/whiteboard/ink-rendering";
import {
  WhiteboardSceneAction,
  focusSceneRecords,
} from "@/features/whiteboard/scene-actions";
import { estimateTextShapePropsHeight } from "@/features/whiteboard/text-shape-normalization";
import { normalizeWritingLayout } from "@/features/whiteboard/writing-layout";

describe("whiteboard handwriting rendering", function () {
  it("renders deterministic pen paths for the same shape", function () {
    const props = normalizeInkShapeProps({
      source: "Check the forbidden values first.",
      format: "text",
      w: 420,
      size: "m",
      color: "#1F2937",
    });

    const first = renderInk(props, "shape:working");
    const second = renderInk(props, "shape:working");

    expect(first.error).to.equal(null);
    expect(first.path).not.to.equal("");
    expect(first).to.deep.equal(second);
    expect(first.strokes).to.have.length.greaterThan(1);
    expect(first.path).to.include("Q");
    expect(props.color).to.equal("#1f2937");
  });

  it("varies handwriting by shape while preserving visible word spacing", function () {
    const spaced = renderInk(
      normalizeInkShapeProps({
        source: "Move everything to one side",
        format: "text",
        w: 700,
        size: "m",
      }),
      "shape:spaced",
    );
    const repeated = renderInk(
      normalizeInkShapeProps({
        source: "Move everything to one side",
        format: "text",
        w: 700,
        size: "m",
      }),
      "shape:different",
    );
    const collapsed = renderInk(
      normalizeInkShapeProps({
        source: "Moveeverythingtooneside",
        format: "text",
        w: 700,
        size: "m",
      }),
      "shape:spaced",
    );

    expect(spaced.path).not.to.equal(repeated.path);
    expect(renderedWidth(spaced)).to.be.greaterThan(
      renderedWidth(collapsed) * 1.02,
    );
  });

  it("renders a rational inequality as mathematical ink", function () {
    const props = normalizeInkShapeProps({
      source: "\\frac{x-2}{x-3} \\leq \\frac{2x+5}{9x-7}",
      format: "latex",
      w: 720,
      size: "l",
      color: "#2563eb",
    });
    const rendered = renderInk(props, "shape:q13-math");

    expect(rendered.error).to.equal(null);
    expect(rendered.usedFallback).to.equal(false);
    expect(rendered.polylines.length).to.be.greaterThan(20);
    expect(rendered.height).to.be.greaterThan(48);
  });

  it("normalizes common test-solution LaTeX and lays out aligned steps", function () {
    const shortForm = renderInk(
      normalizeInkShapeProps({
        source: "x \\le0",
        format: "latex",
        w: 500,
        size: "m",
      }),
      "same-seed",
    );
    const canonicalForm = renderInk(
      normalizeInkShapeProps({
        source: "x \\leq 0",
        format: "latex",
        w: 500,
        size: "m",
      }),
      "same-seed",
    );
    const aligned = renderInk(
      normalizeInkShapeProps({
        source: "\\begin{aligned}x&\\le0\\\\[3pt]x+1&\\ge2\\end{aligned}",
        format: "latex",
        w: 500,
        size: "m",
      }),
      "aligned",
    );

    expect(shortForm.path).to.equal(canonicalForm.path);
    expect(aligned.error).to.equal(null);
    expect(aligned.usedFallback).to.equal(false);
    expect(aligned.height).to.be.greaterThan(shortForm.height * 1.5);
  });

  it("renders compact fractions, arrows, spacing, and boxed answers as math", function () {
    const compactWorking = renderInk(
      normalizeInkShapeProps({
        source: "9x-7=0\\Rightarrow x=\\frac79,\\qquad x-3=0\\Rightarrow x=3",
        format: "latex",
        w: 700,
        size: "m",
      }),
      "compact-working",
    );
    const canonicalWorking = renderInk(
      normalizeInkShapeProps({
        source:
          "9x-7=0\\rightarrow x=\\frac{7}{9},\\quad \\quad x-3=0\\rightarrow x=3",
        format: "latex",
        w: 700,
        size: "m",
      }),
      "compact-working",
    );
    const boxedAnswer = renderInk(
      normalizeInkShapeProps({
        source: "\\boxed{x\\in\\left(\\frac79,\\,3\\right)}",
        format: "latex",
        w: 620,
        size: "m",
      }),
      "boxed-answer",
    );
    const canonicalAnswer = renderInk(
      normalizeInkShapeProps({
        source: "{x\\in\\left(\\frac{7}{9}, 3\\right)}",
        format: "latex",
        w: 620,
        size: "m",
      }),
      "boxed-answer",
    );

    expect(compactWorking.path).not.to.equal(canonicalWorking.path);
    expect(boxedAnswer.path).not.to.equal("");
    expect(canonicalAnswer.path).not.to.equal("");
    expect(boxedAnswer.decorations).to.have.length(1);
    expect(boxedAnswer.decorations[0]).to.include({ type: "box" });
    expect(canonicalAnswer.decorations).to.have.length(0);
  });

  it("preserves sign-chart columns and mathematical symbols in pen text", function () {
    const unicodeText = renderInk(
      normalizeInkShapeProps({
        source: "Δ≤π",
        format: "text",
        w: 700,
        size: "m",
      }),
      "unicode-math",
    );
    const canonicalMath = renderInk(
      normalizeInkShapeProps({
        source: "\\Delta\\leq\\pi",
        format: "latex",
        w: 700,
        size: "m",
      }),
      "unicode-math",
    );
    const chart = renderInk(
      normalizeInkShapeProps({
        source: "9x − 7:    −    +    +",
        format: "text",
        w: 700,
        size: "m",
      }),
      "chart",
    );
    const collapsed = renderInk(
      normalizeInkShapeProps({
        source: "9x − 7: − + +",
        format: "text",
        w: 700,
        size: "m",
      }),
      "chart",
    );

    expect(unicodeText.error).to.equal(null);
    expect(canonicalMath.error).to.equal(null);
    expect(unicodeText.polylines.length).to.equal(
      canonicalMath.polylines.length,
    );
    expect(renderedWidth(chart)).to.be.greaterThan(
      renderedWidth(collapsed) * 1.5,
    );
  });

  it("renders prose dashes and Unicode exponents as supported handwriting", function () {
    const unicode = renderInk(
      normalizeInkShapeProps({
        source: "Question 13 — show that 7x² is positive",
        format: "text",
        w: 700,
        size: "m",
      }),
      "unicode-prose",
    );
    const asciiDash = renderInk(
      normalizeInkShapeProps({
        source: "Question 13 - show that 7x² is positive",
        format: "text",
        w: 700,
        size: "m",
      }),
      "unicode-prose",
    );
    const withoutExponent = renderInk(
      normalizeInkShapeProps({
        source: "Question 13 - show that 7x is positive",
        format: "text",
        w: 700,
        size: "m",
      }),
      "unicode-prose",
    );

    expect(unicode.error).to.equal(null);
    expect(unicode.path).to.equal(asciiDash.path);
    expect(unicode.path).not.to.equal(withoutExponent.path);
  });

  it("renders inline TeX in prose without visible command text", function () {
    const inlineTex = renderInk(
      normalizeInkShapeProps({
        source:
          "Since a=7>0 and \\Delta<0, it is negative on \\frac79<x<3.",
        format: "text",
        w: 700,
        size: "m",
      }),
      "inline-tex",
    );
    const readable = renderInk(
      normalizeInkShapeProps({
        source: "Since a = 7 > 0 and Δ < 0, it is negative on 7/9 < x < 3.",
        format: "text",
        w: 700,
        size: "m",
      }),
      "inline-tex",
    );

    expect(inlineTex.error).to.equal(null);
    expect(inlineTex.path).to.equal(readable.path);
  });

  it("separates prose from aligned math in a mixed LaTeX block", function () {
    const mixed = renderInk(
      normalizeInkShapeProps({
        source:
          "Do not cross-multiply: denominator signs are unknown.\n" +
          "\\begin{aligned}x&\\le0\\\\x+1&\\ge2\\end{aligned}",
        format: "latex",
        w: 700,
        size: "m",
      }),
      "mixed-latex",
    );
    const mathOnly = renderInk(
      normalizeInkShapeProps({
        source: "\\begin{aligned}x&\\le0\\\\x+1&\\ge2\\end{aligned}",
        format: "latex",
        w: 700,
        size: "m",
      }),
      "mixed-latex",
    );

    expect(mixed.error).to.equal(null);
    expect(mixed.usedFallback).to.equal(false);
    expect(mixed.height).to.be.greaterThan(mathOnly.height * 1.25);
  });

  it("normalizes empty and oversized values to safe, visible content", function () {
    const props = normalizeInkShapeProps({
      source: "",
      format: "text",
      w: 20_000,
      h: -50,
      size: "invalid",
      color: "not-a-color",
    });
    const rendered = renderInk(props, "shape:fallback");

    expect(props).to.include({
      source: "Handwritten solution",
      format: "text",
      w: 900,
      size: "m",
      color: "#172033",
    });
    expect(rendered.error).to.equal(null);
    expect(rendered.path).not.to.equal("");
  });

  it("reflows a worked solution into non-overlapping writing blocks", function () {
    const actions: WhiteboardSceneAction[] = [
      textAction("heading", 80, "Question 13"),
      inkAction("inequality", 112),
      textAction(
        "reasoning",
        156,
        "Move everything to one side. Do not cross-multiply because the denominator can change sign.",
      ),
    ];

    const normalized = normalizeWritingLayout(actions).filter(
      (action): action is Extract<WhiteboardSceneAction, { type: "create" }> =>
        action.type === "create",
    );

    for (let index = 1; index < normalized.length; index += 1) {
      const previous = normalized[index - 1].shape;
      const current = normalized[index].shape;
      expect(current.y).to.be.at.least(previous.y + shapeHeight(previous) + 20);
    }
    expect(normalized[1].shape.y).to.equal(
      normalized[0].shape.y + shapeHeight(normalized[0].shape) + 28,
    );
  });

  it("moves a new solution column away from existing board work", function () {
    const normalized = normalizeWritingLayout(
      [textAction("heading", 80, "Question 13"), inkAction("inequality", 112)],
      [{ x: 40, y: 20, w: 760, h: 520 }],
    ).filter(
      (action): action is Extract<WhiteboardSceneAction, { type: "create" }> =>
        action.type === "create",
    );

    expect(normalized[0].shape.x).to.be.at.least(980);
    expect(normalized[1].shape.x).to.be.at.least(980);
  });

  it("focuses only affected shapes and ignores delete-only patches", function () {
    const records = [shapeRecord("shape:first"), shapeRecord("shape:second")];
    let selectedNone = 0;
    let zoomed: { bounds: Box; options: Record<string, unknown> } | undefined;
    const editor = {
      getShape: () => records[0],
      getShapePageBounds: (id: string) =>
        id === "shape:first"
          ? new Box(100, 100, 200, 100)
          : new Box(400, 200, 100, 100),
      selectNone: () => {
        selectedNone += 1;
      },
      zoomToBounds: (bounds: Box, options: Record<string, unknown>) => {
        zoomed = { bounds, options };
      },
    } as unknown as Editor;

    expect(focusSceneRecords(editor, records)).to.equal(true);
    expect(selectedNone).to.equal(1);
    expect(zoomed?.bounds.toJson()).to.deep.equal({
      x: 76,
      y: 76,
      w: 448,
      h: 248,
    });
    expect(zoomed?.options).to.deep.include({ inset: 148, targetZoom: 1 });
    expect(focusSceneRecords(editor, [null])).to.equal(false);
    expect(selectedNone).to.equal(1);
  });
});

function textAction(
  id: string,
  y: number,
  text: string,
): WhiteboardSceneAction {
  return {
    type: "create",
    shape: {
      id,
      type: "text",
      x: 100,
      y,
      props: { text, w: 640, size: "m", font: "draw" },
    },
  };
}

function inkAction(id: string, y: number): WhiteboardSceneAction {
  return {
    type: "create",
    shape: {
      id,
      type: "ink",
      x: 100,
      y,
      props: {
        source: "\\frac{x-2}{x-3} \\leq \\frac{2x+5}{9x-7}",
        format: "latex",
        w: 720,
        h: 96,
        size: "m",
        color: "#1f2937",
      },
    },
  };
}

function shapeHeight(
  shape: Extract<WhiteboardSceneAction, { type: "create" }>["shape"],
) {
  return shape.type === "ink"
    ? (shape.props as InkShapeProps).h
    : estimateTextShapePropsHeight(shape.props);
}

function renderedWidth(rendered: ReturnType<typeof renderInk>) {
  const points = rendered.polylines.flat();
  return (
    Math.max(...points.map(({ x }) => x)) -
    Math.min(...points.map(({ x }) => x))
  );
}

function shapeRecord(id: string) {
  return {
    id,
    typeName: "shape",
    type: "ink",
    parentId: "page:page",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {},
  } as unknown as TLRecord;
}
