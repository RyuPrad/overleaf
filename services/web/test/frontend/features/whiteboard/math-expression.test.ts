import { expect } from "chai";
import {
  compileMathExpression,
  sampleMathExpression,
} from "@/features/whiteboard/math-expression";

describe("whiteboard math expressions", function () {
  it("evaluates the supported grammar with mathematical precedence", function () {
    expect(compileMathExpression("2 + 3 * 4")(0)).to.equal(14);
    expect(compileMathExpression("-2^2")(0)).to.equal(-4);
    expect(compileMathExpression("sin(pi / 2) + x^2")(3)).to.be.closeTo(
      10,
      1e-10,
    );
  });

  it("rejects JavaScript and unknown identifiers", function () {
    expect(() => compileMathExpression("globalThis.alert(1)")).to.throw(
      "Unsupported character",
    );
    expect(() => compileMathExpression("x; process.exit()")).to.throw(
      "Unsupported character",
    );
  });

  it("splits sampled paths at discontinuities", function () {
    const samples = sampleMathExpression({
      expression: "1 / x",
      xMin: -1,
      xMax: 1,
      yMin: -10,
      yMax: 10,
      samples: 100,
    });
    expect(samples.filter((sample) => sample.move).length).to.be.greaterThan(1);
  });
});
