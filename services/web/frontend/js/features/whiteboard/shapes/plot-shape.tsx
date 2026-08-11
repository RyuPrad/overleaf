import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  T,
  TLBaseShape,
} from "tldraw";
import { sampleMathExpression } from "../math-expression";

export type PlotShape = TLBaseShape<
  "plot",
  {
    w: number;
    h: number;
    expression: string;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    color: string;
    showGrid: boolean;
  }
>;

export class PlotShapeUtil extends BaseBoxShapeUtil<PlotShape> {
  static override type = "plot" as const;
  static override props = {
    w: T.number,
    h: T.number,
    expression: T.string,
    xMin: T.number,
    xMax: T.number,
    yMin: T.number,
    yMax: T.number,
    color: T.string,
    showGrid: T.boolean,
  };

  override getDefaultProps(): PlotShape["props"] {
    return {
      w: 360,
      h: 240,
      expression: "sin(x)",
      xMin: -10,
      xMax: 10,
      yMin: -2,
      yMax: 2,
      color: "#2563eb",
      showGrid: true,
    };
  }

  override getGeometry(shape: PlotShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override component(shape: PlotShape) {
    const plot = createPlot(shape);
    return (
      <HTMLContainer
        style={{
          background: "#fff",
          border: "1px solid rgba(31, 41, 55, .2)",
          borderRadius: 8,
          height: shape.props.h,
          overflow: "hidden",
          width: shape.props.w,
        }}
      >
        {plot.error ? (
          <div style={{ color: "#b91c1c", fontSize: 12, padding: 12 }}>
            {plot.error}
          </div>
        ) : (
          <PlotSvg shape={shape} path={plot.path} />
        )}
      </HTMLContainer>
    );
  }

  override indicator(shape: PlotShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }

  override toSvg(shape: PlotShape) {
    const plot = createPlot(shape);
    if (plot.error) {
      return (
        <g>
          <rect width={shape.props.w} height={shape.props.h} fill="#fff" />
          <text x={12} y={24} fill="#b91c1c" fontSize={12}>
            Invalid plot expression
          </text>
        </g>
      );
    }
    return <PlotSvg shape={shape} path={plot.path} />;
  }
}

function PlotSvg({ shape, path }: { shape: PlotShape; path: string }) {
  const { w, h, xMin, xMax, yMin, yMax, showGrid, color } = shape.props;
  const xAxis = toCanvasY(0, h, yMin, yMax);
  const yAxis = toCanvasX(0, w, xMin, xMax);
  const verticalGrid = Array.from(
    { length: 9 },
    (_, index) => ((index + 1) * w) / 10,
  );
  const horizontalGrid = Array.from(
    { length: 5 },
    (_, index) => ((index + 1) * h) / 6,
  );

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <rect width={w} height={h} fill="#fff" />
      {showGrid && (
        <g stroke="#e5e7eb" strokeWidth={1}>
          {verticalGrid.map((value) => (
            <line key={`x-${value}`} x1={value} y1={0} x2={value} y2={h} />
          ))}
          {horizontalGrid.map((value) => (
            <line key={`y-${value}`} x1={0} y1={value} x2={w} y2={value} />
          ))}
        </g>
      )}
      {xAxis >= 0 && xAxis <= h && (
        <line x1={0} y1={xAxis} x2={w} y2={xAxis} stroke="#6b7280" />
      )}
      {yAxis >= 0 && yAxis <= w && (
        <line x1={yAxis} y1={0} x2={yAxis} y2={h} stroke="#6b7280" />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={2} />
      <text x={10} y={18} fill="#374151" fontSize={12}>
        {shape.props.expression}
      </text>
    </svg>
  );
}

function createPlot(shape: PlotShape) {
  try {
    const { w, h, expression, xMin, xMax, yMin, yMax } = shape.props;
    const samples = sampleMathExpression({
      expression,
      xMin,
      xMax,
      yMin,
      yMax,
      samples: Math.max(160, Math.round(w)),
    });
    const path = samples
      .map((sample) => {
        const x = toCanvasX(sample.x, w, xMin, xMax);
        const y = toCanvasY(sample.y, h, yMin, yMax);
        return `${sample.move ? "M" : "L"}${round(x)} ${round(y)}`;
      })
      .join(" ");
    return { path, error: null };
  } catch (cause) {
    return {
      path: "",
      error: cause instanceof Error ? cause.message : "Invalid plot expression",
    };
  }
}

function toCanvasX(value: number, width: number, min: number, max: number) {
  return ((value - min) / (max - min)) * width;
}

function toCanvasY(value: number, height: number, min: number, max: number) {
  return height - ((value - min) / (max - min)) * height;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
