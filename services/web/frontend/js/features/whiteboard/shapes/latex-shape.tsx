import { useEffect, useRef, useState } from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  T,
  TLBaseShape,
} from "tldraw";
import { loadMathJax } from "@/features/mathjax/load-mathjax";

export type LatexShape = TLBaseShape<
  "latex",
  {
    w: number;
    h: number;
    latex: string;
    displayMode: boolean;
    color: string;
  }
>;

export class LatexShapeUtil extends BaseBoxShapeUtil<LatexShape> {
  static override type = "latex" as const;
  static override props = {
    w: T.number,
    h: T.number,
    latex: T.string,
    displayMode: T.boolean,
    color: T.string,
  };

  override getDefaultProps(): LatexShape["props"] {
    return {
      w: 220,
      h: 96,
      latex: "E = mc^2",
      displayMode: true,
      color: "#1f2937",
    };
  }

  override getGeometry(shape: LatexShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override component(shape: LatexShape) {
    return <RenderedLatex shape={shape} />;
  }

  override indicator(shape: LatexShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }

  override async toSvg(shape: LatexShape) {
    const markup = await renderLatexToSvgMarkup(
      shape.props.latex,
      shape.props.displayMode,
    );
    return (
      <g color={shape.props.color}>
        <foreignObject width={shape.props.w} height={shape.props.h}>
          <div
            style={{
              alignItems: "center",
              color: shape.props.color,
              display: "flex",
              height: "100%",
              justifyContent: "center",
              overflow: "hidden",
              width: "100%",
            }}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        </foreignObject>
      </g>
    );
  }
}

function RenderedLatex({ shape }: { shape: LatexShape }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    renderLatexToSvgMarkup(shape.props.latex, shape.props.displayMode).then(
      (markup) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = markup;
        setError(null);
      },
      (cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Invalid LaTeX");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [shape.props.displayMode, shape.props.latex]);

  return (
    <HTMLContainer
      style={{
        alignItems: "center",
        background: "var(--color-panel, #fff)",
        border: error ? "1px solid #dc2626" : "1px solid rgba(31, 41, 55, .18)",
        borderRadius: 8,
        color: shape.props.color,
        display: "flex",
        height: shape.props.h,
        justifyContent: "center",
        overflow: "hidden",
        padding: 8,
        width: shape.props.w,
      }}
    >
      {error ? (
        <span style={{ color: "#b91c1c", fontSize: 12 }}>{error}</span>
      ) : (
        <div ref={containerRef} />
      )}
    </HTMLContainer>
  );
}

async function renderLatexToSvgMarkup(latex: string, displayMode: boolean) {
  const MathJax = await loadMathJax();
  MathJax.texReset([0]);
  const node = await MathJax.tex2svgPromise(latex, { display: displayMode });
  return node.innerHTML;
}
