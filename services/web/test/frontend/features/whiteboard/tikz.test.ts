import { expect } from "chai";
import type { TLRecord } from "tldraw";
import {
  exportWhiteboardToTikz,
  importWhiteboardFromTikz,
} from "@/features/whiteboard/tikz";

describe("whiteboard TikZ interchange", function () {
  const latexShape = {
    id: "shape:equation",
    typeName: "shape",
    type: "latex",
    x: 96,
    y: 48,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 220,
      h: 96,
      latex: "E = mc^2",
      displayMode: true,
      color: "#111827",
    },
  } as unknown as TLRecord;

  it("round-trips generated records losslessly", function () {
    const source = exportWhiteboardToTikz({
      boardId: "board-1",
      records: [latexShape],
    });
    const result = importWhiteboardFromTikz(source);
    expect(result.kind).to.equal("round-trip");
    if (result.kind === "round-trip") {
      expect(result.records).to.deep.equal([latexShape]);
    }
  });

  it("exports handwritten shapes as vector TikZ paths", function () {
    const inkShape = {
      id: "shape:q13-ink",
      typeName: "shape",
      type: "ink",
      x: 40,
      y: 80,
      rotation: 0,
      index: "a2",
      parentId: "page:page",
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        source: "\\boxed{\\frac{x-2}{x-3} \\leq 0}",
        format: "latex",
        w: 600,
        h: 96,
        size: "m",
        color: "#1f2937",
      },
    } as unknown as TLRecord;

    const source = exportWhiteboardToTikz({
      boardId: "board-ink",
      records: [inkShape],
    });

    expect(source).to.contain("\\draw[line width=2.16pt");
    expect(source).to.contain("line cap=round");
    expect(source).to.contain("opacity=0.9");
    expect(source).to.contain("plot[smooth] coordinates");
    expect(source).to.contain(" -- ");
    const result = importWhiteboardFromTikz(source);
    expect(result.kind).to.equal("round-trip");
    if (result.kind === "round-trip") {
      expect(result.records).to.deep.equal([inkShape]);
    }
  });

  it("parses relative rectangles using their real dimensions", function () {
    const result = importWhiteboardFromTikz(
      "\\begin{tikzpicture}\n\\draw (1,2) rectangle ++(3,-4);\n\\end{tikzpicture}",
    );
    expect(result.kind).to.equal("parsed");
    if (result.kind === "parsed") {
      expect(result.items[0]).to.include({ type: "geo", geo: "rectangle" });
      expect(result.items[0])
        .to.have.property("w")
        .closeTo(3 * (96 / 2.54), 1e-8);
      expect(result.items[0])
        .to.have.property("h")
        .closeTo(4 * (96 / 2.54), 1e-8);
    }
  });

  it("preserves unsupported commands as source fragments", function () {
    const result = importWhiteboardFromTikz(
      "\\begin{tikzpicture}\n\\path[decorate] (0,0) circle (1);\n\\end{tikzpicture}",
    );
    expect(result.kind).to.equal("parsed");
    if (result.kind === "parsed") {
      expect(result.items).to.deep.include({
        type: "source-fragment",
        source: "\\path[decorate] (0,0) circle (1);",
        warning: "Unsupported TikZ preserved for manual editing",
      });
    }
  });
});
