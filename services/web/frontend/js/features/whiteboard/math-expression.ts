type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: "+" | "-" | "*" | "/" | "^" }
  | { type: "left-paren" | "right-paren" | "comma" };

type ExpressionNode =
  | { type: "number"; value: number }
  | { type: "variable" }
  | { type: "unary"; operator: "+" | "-"; value: ExpressionNode }
  | {
      type: "binary";
      operator: "+" | "-" | "*" | "/" | "^";
      left: ExpressionNode;
      right: ExpressionNode;
    }
  | { type: "call"; name: FunctionName; arguments: ExpressionNode[] };

type FunctionName = keyof typeof FUNCTIONS;

const MAX_EXPRESSION_LENGTH = 200;
const MAX_TOKENS = 256;

const FUNCTIONS = {
  abs: { arity: 1, evaluate: Math.abs },
  acos: { arity: 1, evaluate: Math.acos },
  asin: { arity: 1, evaluate: Math.asin },
  atan: { arity: 1, evaluate: Math.atan },
  ceil: { arity: 1, evaluate: Math.ceil },
  cos: { arity: 1, evaluate: Math.cos },
  exp: { arity: 1, evaluate: Math.exp },
  floor: { arity: 1, evaluate: Math.floor },
  ln: { arity: 1, evaluate: Math.log },
  log: { arity: 1, evaluate: Math.log },
  max: { arity: 2, evaluate: Math.max },
  min: { arity: 2, evaluate: Math.min },
  round: { arity: 1, evaluate: Math.round },
  sin: { arity: 1, evaluate: Math.sin },
  sqrt: { arity: 1, evaluate: Math.sqrt },
  tan: { arity: 1, evaluate: Math.tan },
} as const;

export type FunctionSample = {
  x: number;
  y: number;
  move: boolean;
};

export function compileMathExpression(expression: string) {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Function expression cannot be empty");
  }
  if (trimmed.length > MAX_EXPRESSION_LENGTH) {
    throw new Error("Function expression is too long");
  }

  const parser = new ExpressionParser(tokenize(trimmed));
  const node = parser.parse();

  return (x: number) => evaluate(node, x);
}

export function sampleMathExpression({
  expression,
  xMin,
  xMax,
  yMin,
  yMax,
  samples = 320,
}: {
  expression: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  samples?: number;
}): FunctionSample[] {
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite)) {
    throw new Error("Plot bounds must be finite numbers");
  }
  if (xMin >= xMax || yMin >= yMax) {
    throw new Error("Plot minimums must be smaller than maximums");
  }

  const evaluateAt = compileMathExpression(expression);
  const count = Math.max(16, Math.min(2000, Math.floor(samples)));
  const output: FunctionSample[] = [];
  let previousY: number | null = null;

  for (let index = 0; index <= count; index += 1) {
    const x = xMin + ((xMax - xMin) * index) / count;
    const y = evaluateAt(x);
    const finite = Number.isFinite(y);
    const visible =
      finite && y >= yMin - (yMax - yMin) && y <= yMax + (yMax - yMin);
    const discontinuity =
      previousY !== null &&
      finite &&
      Math.abs(y - previousY) > (yMax - yMin) * 2;

    if (visible) {
      output.push({ x, y, move: previousY === null || discontinuity });
      previousY = y;
    } else {
      previousY = null;
    }
  }

  return output;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS) {
      throw new Error("Function expression has too many tokens");
    }
  };

  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    const numberMatch = expression
      .slice(index)
      .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (numberMatch) {
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value)) {
        throw new Error("Function expression contains an invalid number");
      }
      push({ type: "number", value });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = expression.slice(index).match(/^[a-z_][a-z0-9_]*/i);
    if (identifierMatch) {
      push({ type: "identifier", value: identifierMatch[0].toLowerCase() });
      index += identifierMatch[0].length;
      continue;
    }

    if (character === "(") push({ type: "left-paren" });
    else if (character === ")") push({ type: "right-paren" });
    else if (character === ",") push({ type: "comma" });
    else if (["+", "-", "*", "/", "^"].includes(character)) {
      push({
        type: "operator",
        value: character as Extract<Token, { type: "operator" }>["value"],
      });
    } else {
      throw new Error(
        `Unsupported character in function expression: ${character}`,
      );
    }
    index += 1;
  }

  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse() {
    const expression = this.parseAddition();
    if (this.peek()) {
      throw new Error("Unexpected token at the end of function expression");
    }
    return expression;
  }

  private parseAddition(): ExpressionNode {
    let left = this.parseMultiplication();
    while (this.isOperator("+") || this.isOperator("-")) {
      const operator = this.consumeOperator() as "+" | "-";
      left = {
        type: "binary",
        operator,
        left,
        right: this.parseMultiplication(),
      };
    }
    return left;
  }

  private parseMultiplication(): ExpressionNode {
    let left = this.parseUnary();
    while (this.isOperator("*") || this.isOperator("/")) {
      const operator = this.consumeOperator() as "*" | "/";
      left = {
        type: "binary",
        operator,
        left,
        right: this.parseUnary(),
      };
    }
    return left;
  }

  private parsePower(): ExpressionNode {
    const left = this.parsePrimary();
    if (!this.isOperator("^")) return left;
    this.consume();
    return {
      type: "binary",
      operator: "^",
      left,
      right: this.parseUnary(),
    };
  }

  private parseUnary(): ExpressionNode {
    if (this.isOperator("+") || this.isOperator("-")) {
      const operator = this.consumeOperator() as "+" | "-";
      return { type: "unary", operator, value: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parsePrimary(): ExpressionNode {
    const token = this.consume();
    if (token.type === "number") return { type: "number", value: token.value };

    if (token.type === "identifier") {
      if (token.value === "x") return { type: "variable" };
      if (token.value === "pi") return { type: "number", value: Math.PI };
      if (token.value === "e") return { type: "number", value: Math.E };

      if (!(token.value in FUNCTIONS)) {
        throw new Error(`Unsupported function or variable: ${token.value}`);
      }
      this.expect("left-paren");
      const arguments_: ExpressionNode[] = [];
      if (this.peek()?.type !== "right-paren") {
        arguments_.push(this.parseAddition());
        while (this.peek()?.type === "comma") {
          this.consume();
          arguments_.push(this.parseAddition());
        }
      }
      this.expect("right-paren");

      const name = token.value as FunctionName;
      if (arguments_.length !== FUNCTIONS[name].arity) {
        throw new Error(`${name} expects ${FUNCTIONS[name].arity} argument(s)`);
      }
      return { type: "call", name, arguments: arguments_ };
    }

    if (token.type === "left-paren") {
      const expression = this.parseAddition();
      this.expect("right-paren");
      return expression;
    }

    throw new Error(
      "Expected a number, x, function, or parenthesized expression",
    );
  }

  private expect(type: Token["type"]) {
    const token = this.consume();
    if (token.type !== type) {
      throw new Error(`Expected ${type}`);
    }
  }

  private isOperator(operator: Extract<Token, { type: "operator" }>["value"]) {
    const token = this.peek();
    return token?.type === "operator" && token.value === operator;
  }

  private peek() {
    return this.tokens[this.index];
  }

  private consume(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Unexpected end of function expression");
    this.index += 1;
    return token;
  }

  private consumeOperator() {
    const token = this.consume();
    if (token.type !== "operator") {
      throw new Error("Expected an operator");
    }
    return token.value;
  }
}

function evaluate(node: ExpressionNode, x: number): number {
  if (node.type === "number") return node.value;
  if (node.type === "variable") return x;
  if (node.type === "unary") {
    const value = evaluate(node.value, x);
    return node.operator === "-" ? -value : value;
  }
  if (node.type === "call") {
    const values = node.arguments.map((argument) => evaluate(argument, x));
    const evaluateFunction = FUNCTIONS[node.name].evaluate as (
      ...arguments_: number[]
    ) => number;
    return evaluateFunction(...values);
  }

  const left = evaluate(node.left, x);
  const right = evaluate(node.right, x);
  if (node.operator === "+") return left + right;
  if (node.operator === "-") return left - right;
  if (node.operator === "*") return left * right;
  if (node.operator === "/") return left / right;
  return left ** right;
}
