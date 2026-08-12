import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  T,
  TLBaseShape,
} from "tldraw";
import { InkFormat, InkShapeProps, InkSize, renderInk } from "../ink-rendering";

export type InkShape = TLBaseShape<"ink", InkShapeProps>;

export class InkShapeUtil extends BaseBoxShapeUtil<InkShape> {
  static override type = "ink" as const;
  static override props = {
    source: T.string,
    format: T.literalEnum("text", "latex"),
    w: T.number,
    h: T.number,
    size: T.literalEnum("s", "m", "l", "xl"),
    color: T.string,
  };

  override getDefaultProps(): InkShape["props"] {
    return {
      source: "Handwritten solution",
      format: "text",
      w: 640,
      h: 64,
      size: "m",
      color: "#1f2937",
    };
  }

  override getGeometry(shape: InkShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: false,
    });
  }

  override component(shape: InkShape) {
    return <InkShapeSvg shape={shape} />;
  }

  override indicator(shape: InkShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }

  override toSvg(shape: InkShape) {
    return <InkSvgContent shape={shape} />;
  }
}

function InkShapeSvg({ shape }: { shape: InkShape }) {
  return (
    <HTMLContainer
      style={{
        height: shape.props.h,
        overflow: "hidden",
        width: shape.props.w,
      }}
    >
      <svg
        aria-label={shape.props.source}
        height={shape.props.h}
        role="img"
        viewBox={`0 0 ${shape.props.w} ${shape.props.h}`}
        width={shape.props.w}
      >
        <InkSvgContent shape={shape} />
      </svg>
    </HTMLContainer>
  );
}

function InkSvgContent({ shape }: { shape: InkShape }) {
  const rendered = renderInk(shape.props, shape.id);
  if (rendered.error) {
    return (
      <text
        fill={shape.props.color}
        fontFamily="tldraw_draw, sans-serif"
        fontSize={fontSize(shape.props.size)}
        x={8}
        y={fontSize(shape.props.size) + 8}
      >
        {shape.props.source}
      </text>
    );
  }
  return (
    <g>
      <title>{shape.props.source}</title>
      {rendered.strokes.map((stroke, index) => (
        <path
          d={stroke.path}
          fill="none"
          key={`stroke-${index}`}
          opacity={stroke.opacity}
          stroke={shape.props.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke.width}
        />
      ))}
      {rendered.decorations.map((decoration, index) => (
        <path
          d={decoration.path}
          fill="none"
          key={`decoration-${index}`}
          opacity={decoration.opacity}
          stroke={shape.props.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={decoration.width}
        />
      ))}
    </g>
  );
}

function fontSize(size: InkSize) {
  return { s: 24, m: 32, l: 40, xl: 52 }[size];
}

export type { InkFormat, InkSize };
